// src/app/api/admin/comments/[id]/route.ts
import { getAuthenticatedUser, isPlatformAdmin } from "@/lib/authHelpers";
import {
  createErrorResponse,
  createSuccessResponse,
  handleRouteError,
} from "@/lib/errorHandler";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { NextRequest } from "next/server";
import { z } from "zod";

const commentIdSchema = z.string().uuid();
const updateCommentSchema = z.object({
  status: z.enum(["published", "flagged", "deleted", "pending"]).optional(),
  is_flagged_as_spam: z.boolean().optional(),
  admin_notes: z.string().max(1000).optional(),
});

const moderationActionSchema = z.object({
  action_type: z.enum([
    "approve_comment",
    "delete_comment",
    "flag_comment",
    "mark_spam",
    "unmark_spam",
    "edit_comment",
    "restore_comment",
  ]),
  reason: z.string().max(500).optional(),
  new_content: z.string().max(2000).optional(), // For edit_comment action
});

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    // Check admin authorization
    const { user } = await getAuthenticatedUser(request);
    if (!user || !isPlatformAdmin(user)) {
      return createErrorResponse("Admin access required", 403);
    }

    const commentId = commentIdSchema.parse(params.id);

    // Get detailed comment information
    const { data: comment, error: commentError } = await supabaseAdmin
      .from("comments")
      .select(
        `
        *,
        author:profiles(
          id,
          username,
          display_name,
          avatar_url,
          email,
          created_at,
          is_email_verified
        ),
        post:posts(
          id,
          title,
          slug,
          status,
          author:profiles(username, display_name)
        ),
        parent_comment:comments!parent_id(
          id,
          content,
          author:profiles(username, display_name)
        ),
        replies:comments!parent_id(
          id,
          content,
          status,
          is_flagged_as_spam,
          created_at,
          author:profiles(username, display_name)
        ),
        reactions:comment_reactions(
          reaction_type,
          user:profiles(username, display_name)
        ),
        edit_history:comment_edit_history(
          id,
          previous_content,
          edited_at,
          edited_by:profiles(username, display_name)
        )
      `
      )
      .eq("id", commentId)
      .single();

    if (commentError) {
      if (commentError.code === "PGRST116") {
        return createErrorResponse("Comment not found", 404);
      }
      throw commentError;
    }

    // Get reports for this comment
    const { data: reports } = await supabaseAdmin
      .from("content_reports")
      .select(
        `
        id,
        reason,
        severity,
        status,
        additional_context,
        created_at,
        reporter:profiles(username, display_name),
        reviewed_by:profiles(username, display_name),
        reviewed_at,
        admin_notes,
        action_taken
      `
      )
      .eq("reported_content_type", "comment")
      .eq("reported_content_id", commentId)
      .order("created_at", { ascending: false });

    // Get moderation history
    const { data: moderationHistory } = await supabaseAdmin
      .from("admin_activity_logs")
      .select(
        `
        id,
        action_type,
        details,
        created_at,
        admin:profiles(username, display_name)
      `
      )
      .eq("target_id", commentId)
      .order("created_at", { ascending: false });

    // Get author's other comments and activity
    const { data: authorComments } = await supabaseAdmin
      .from("comments")
      .select("id, status, is_flagged_as_spam, created_at")
      .eq("author_id", (comment.author as { id: string }).id)
      .order("created_at", { ascending: false })
      .limit(10);

    const [{ data: authorReports }, { data: authorBanStatus }] =
      await Promise.all([
        supabaseAdmin
          .from("content_reports")
          .select("id, reason, severity, status, created_at")
          .eq("reported_content_type", "comment")
          .or(
            `reported_content_id.in.(${authorComments?.map((c: { id: string }) => c.id).join(",") || ""})`
          ),
        supabaseAdmin
          .from("banned_users")
          .select("banned_at, reason, expires_at")
          .eq("user_id", (comment.author as { id: string }).id)
          .single(),
      ]);

    // Calculate comment statistics
    const commentStats = {
      total_reactions: (comment.reactions as unknown[])?.length || 0,
      reaction_breakdown:
        (comment.reactions as { reaction_type: string }[])?.reduce(
          (
            acc: Record<string, number>,
            reaction: { reaction_type: string }
          ) => {
            acc[reaction.reaction_type] =
              (acc[reaction.reaction_type] || 0) + 1;
            return acc;
          },
          {}
        ) || {},
      total_replies: (comment.replies as unknown[])?.length || 0,
      total_reports: reports?.length || 0,
      pending_reports:
        reports?.filter((r) => r.status === "pending").length || 0,
    };

    // Author summary
    const authorSummary = {
      ...comment.author,
      total_comments: authorComments?.length || 0,
      flagged_comments:
        authorComments?.filter(
          (c: { is_flagged_as_spam: boolean }) => c.is_flagged_as_spam
        ).length || 0,
      deleted_comments:
        authorComments?.filter(
          (c: { status: string }) => c.status === "deleted"
        ).length || 0,
      total_reports_received: authorReports?.length || 0,
      is_banned: !!authorBanStatus,
      ban_details: authorBanStatus || null,
    };

    return createSuccessResponse({
      comment: {
        ...comment,
        statistics: commentStats,
      },
      author_summary: authorSummary,
      reports: reports || [],
      moderation_history: moderationHistory || [],
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    // Check admin authorization
    const { user } = await getAuthenticatedUser(request);
    if (!user || !isPlatformAdmin(user)) {
      return createErrorResponse("Admin access required", 403);
    }

    const commentId = commentIdSchema.parse(params.id);
    const body = await request.json();
    const { status, is_flagged_as_spam, admin_notes } =
      updateCommentSchema.parse(body);

    // Check if comment exists
    const { data: existingComment, error: fetchError } = await supabaseAdmin
      .from("comments")
      .select("id, status, is_flagged_as_spam, author_id, content")
      .eq("id", commentId)
      .single();

    if (fetchError) {
      if (fetchError.code === "PGRST116") {
        return createErrorResponse("Comment not found", 404);
      }
      throw fetchError;
    }

    // Build update data
    const updateData: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };

    if (status !== undefined) updateData.status = status;
    if (is_flagged_as_spam !== undefined)
      updateData.is_flagged_as_spam = is_flagged_as_spam;

    // Update comment
    const { data: updatedComment, error: updateError } = await supabaseAdmin
      .from("comments")
      .update(updateData)
      .eq("id", commentId)
      .select(
        `
        *,
        author:profiles(username, display_name),
        post:posts(title, slug)
      `
      )
      .single();

    if (updateError) {
      throw updateError;
    }

    // Store admin notes if provided
    if (admin_notes) {
      await supabaseAdmin.from("admin_notes").insert({
        content_type: "comment",
        content_id: commentId,
        admin_id: user.id,
        notes: admin_notes,
        created_at: new Date().toISOString(),
      });
    }

    // Log admin action
    await supabaseAdmin.from("admin_activity_logs").insert({
      admin_id: user.id,
      action_type: "comment_updated",
      target_id: commentId,
      details: {
        previous_status: existingComment.status,
        new_status: status,
        previous_spam_flag: existingComment.is_flagged_as_spam,
        new_spam_flag: is_flagged_as_spam,
        admin_notes: admin_notes || null,
      },
      created_at: new Date().toISOString(),
    });

    // Create notification for comment author if status changed significantly
    if (
      status &&
      status !== existingComment.status &&
      (status === "deleted" || status === "flagged" || status === "published")
    ) {
      await supabaseAdmin.from("notifications").insert({
        user_id: existingComment.author_id,
        type: "moderation",
        message: `Your comment has been ${status} by an administrator`,
        related_comment_id: commentId,
        created_at: new Date().toISOString(),
      });
    }

    return createSuccessResponse({
      message: "Comment updated successfully",
      comment: updatedComment,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    // Check admin authorization
    const { user } = await getAuthenticatedUser(request);
    if (!user || !isPlatformAdmin(user)) {
      return createErrorResponse("Admin access required", 403);
    }

    const commentId = commentIdSchema.parse(params.id);
    const body = await request.json();
    const { action_type, reason, new_content } =
      moderationActionSchema.parse(body);

    // Get comment details
    const { data: comment, error: commentError } = await supabaseAdmin
      .from("comments")
      .select("*")
      .eq("id", commentId)
      .single();

    if (commentError) {
      if (commentError.code === "PGRST116") {
        return createErrorResponse("Comment not found", 404);
      }
      throw commentError;
    }

    let actionResult: {
      success: boolean;
      message: string;
      data: Record<string, unknown> | null;
    } = { success: false, message: "", data: null };

    // Execute moderation action
    switch (action_type) {
      case "approve_comment":
        const { error: approveError } = await supabaseAdmin
          .from("comments")
          .update({
            status: "published",
            is_flagged_as_spam: false,
            updated_at: new Date().toISOString(),
          })
          .eq("id", commentId);

        if (!approveError) {
          actionResult = {
            success: true,
            message: "Comment approved",
            data: null,
          };
        }
        break;

      case "delete_comment":
        const { error: deleteError } = await supabaseAdmin
          .from("comments")
          .update({
            status: "deleted",
            updated_at: new Date().toISOString(),
          })
          .eq("id", commentId);

        if (!deleteError) {
          actionResult = {
            success: true,
            message: "Comment deleted",
            data: null,
          };
        }
        break;

      case "flag_comment":
        const { error: flagError } = await supabaseAdmin
          .from("comments")
          .update({
            status: "flagged",
            updated_at: new Date().toISOString(),
          })
          .eq("id", commentId);

        if (!flagError) {
          actionResult = {
            success: true,
            message: "Comment flagged",
            data: null,
          };
        }
        break;

      case "mark_spam":
        const { error: spamError } = await supabaseAdmin
          .from("comments")
          .update({
            is_flagged_as_spam: true,
            status: "flagged",
            updated_at: new Date().toISOString(),
          })
          .eq("id", commentId);

        if (!spamError) {
          actionResult = {
            success: true,
            message: "Comment marked as spam",
            data: null,
          };
        }
        break;

      case "unmark_spam":
        const { error: unspamError } = await supabaseAdmin
          .from("comments")
          .update({
            is_flagged_as_spam: false,
            status: "published",
            updated_at: new Date().toISOString(),
          })
          .eq("id", commentId);

        if (!unspamError) {
          actionResult = {
            success: true,
            message: "Comment unmarked as spam",
            data: null,
          };
        }
        break;

      case "edit_comment":
        if (!new_content) {
          return createErrorResponse(
            "New content is required for edit action",
            400
          );
        }

        // Store original content in edit history
        await supabaseAdmin.from("comment_edit_history").insert({
          comment_id: commentId,
          previous_content: comment.content,
          edited_by: user.id,
          edited_at: new Date().toISOString(),
          edit_reason: reason || "Administrative edit",
        });

        const { error: editError } = await supabaseAdmin
          .from("comments")
          .update({
            content: new_content,
            updated_at: new Date().toISOString(),
          })
          .eq("id", commentId);

        if (!editError) {
          actionResult = {
            success: true,
            message: "Comment edited",
            data: { new_content },
          };
        }
        break;

      case "restore_comment":
        const { error: restoreError } = await supabaseAdmin
          .from("comments")
          .update({
            status: "published",
            is_flagged_as_spam: false,
            updated_at: new Date().toISOString(),
          })
          .eq("id", commentId);

        if (!restoreError) {
          actionResult = {
            success: true,
            message: "Comment restored",
            data: null,
          };
        }
        break;

      default:
        return createErrorResponse("Invalid action type", 400);
    }

    if (!actionResult.success) {
      return createErrorResponse(
        actionResult.message || "Failed to execute moderation action",
        500
      );
    }

    // Log admin action
    await supabaseAdmin.from("admin_activity_logs").insert({
      admin_id: user.id,
      action_type: "comment_moderation_action",
      target_id: commentId,
      details: {
        action_type,
        reason: reason || null,
        result: actionResult.message,
        comment_id: commentId,
        new_content: new_content || null,
      },
      created_at: new Date().toISOString(),
    });

    // Create notification for comment author
    if (action_type !== "edit_comment") {
      await supabaseAdmin.from("notifications").insert({
        user_id: comment.author_id,
        type: "moderation",
        message: `Your comment has been ${actionResult.message.toLowerCase()} by an administrator${reason ? `: ${reason}` : ""}`,
        related_comment_id: commentId,
        created_at: new Date().toISOString(),
      });
    }

    return createSuccessResponse({
      message: actionResult.message,
      action_type,
      comment_id: commentId,
      data: actionResult.data,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    // Check admin authorization
    const { user } = await getAuthenticatedUser(request);
    if (!user || !isPlatformAdmin(user)) {
      return createErrorResponse("Admin access required", 403);
    }

    const commentId = commentIdSchema.parse(params.id);

    // Get comment details for logging
    const { data: comment, error: fetchError } = await supabaseAdmin
      .from("comments")
      .select("id, content, author_id, author:profiles(username)")
      .eq("id", commentId)
      .single();

    if (fetchError) {
      if (fetchError.code === "PGRST116") {
        return createErrorResponse("Comment not found", 404);
      }
      throw fetchError;
    }

    // Permanently delete comment (hard delete)
    // Note: This will cascade to related data like reactions, reports, etc.
    const { error: deleteError } = await supabaseAdmin
      .from("comments")
      .delete()
      .eq("id", commentId);

    if (deleteError) {
      throw deleteError;
    }

    // Log admin action
    await supabaseAdmin.from("admin_activity_logs").insert({
      admin_id: user.id,
      action_type: "comment_permanently_deleted",
      target_id: commentId,
      details: {
        deleted_comment_content: comment.content.substring(0, 200),
        comment_author: Array.isArray(comment.author)
          ? (comment.author[0] as { username: string })?.username || "unknown"
          : (comment.author as { username: string })?.username || "unknown",
        deletion_method: "admin_panel",
      },
      created_at: new Date().toISOString(),
    });

    return createSuccessResponse({
      message: "Comment permanently deleted",
      comment_id: commentId,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
