// src/app/api/admin/comments/route.ts
import { getAuthenticatedUser, isPlatformAdmin } from "@/lib/authHelpers";
import {
  createErrorResponse,
  createSuccessResponse,
  handleRouteError,
} from "@/lib/errorHandler";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { NextRequest } from "next/server";
import { z } from "zod";

const getCommentsSchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  search: z.string().optional(),
  status: z
    .enum(["all", "published", "flagged", "deleted", "pending"])
    .optional()
    .default("all"),
  spam_filter: z.enum(["all", "spam", "not_spam"]).optional().default("all"),
  sort: z
    .enum(["newest", "oldest", "most_reported"])
    .optional()
    .default("newest"),
  user_id: z.string().uuid().optional(),
  post_id: z.string().uuid().optional(),
});

const bulkUpdateSchema = z.object({
  comment_ids: z.array(z.string().uuid()),
  action: z.enum(["approve", "flag", "delete", "mark_spam", "unmark_spam"]),
  reason: z.string().max(500).optional(),
});

export async function GET(request: NextRequest) {
  try {
    // Check admin authorization
    const { user } = await getAuthenticatedUser(request);
    if (!user || !isPlatformAdmin(user)) {
      return createErrorResponse("Admin access required", 403);
    }

    const { searchParams } = new URL(request.url);
    const queryParams = getCommentsSchema.parse(
      Object.fromEntries(searchParams.entries())
    );

    const offset = (queryParams.page - 1) * queryParams.limit;

    // Build base query
    let query = supabaseAdmin.from("comments").select(
      `
        id,
        content,
        status,
        is_flagged_as_spam,
        created_at,
        updated_at,
        author:profiles(id, username, display_name, avatar_url, email),
        post:posts(id, title, slug, author:profiles(username, display_name)),
        parent_comment:comments!parent_id(
          id,
          content,
          author:profiles(username, display_name)
        ),
        reactions_count:comment_reactions(count),
        replies_count:comments!parent_id(count),
        reports_count:content_reports!reported_content_id(count)
      `,
      { count: "exact" }
    );

    // Apply filters
    if (queryParams.search) {
      query = query.ilike("content", `%${queryParams.search}%`);
    }

    if (queryParams.status !== "all") {
      query = query.eq("status", queryParams.status);
    }

    if (queryParams.spam_filter === "spam") {
      query = query.eq("is_flagged_as_spam", true);
    } else if (queryParams.spam_filter === "not_spam") {
      query = query.eq("is_flagged_as_spam", false);
    }

    if (queryParams.user_id) {
      query = query.eq("author_id", queryParams.user_id);
    }

    if (queryParams.post_id) {
      query = query.eq("post_id", queryParams.post_id);
    }

    // Apply sorting
    switch (queryParams.sort) {
      case "oldest":
        query = query.order("created_at", { ascending: true });
        break;
      case "most_reported":
        // This would need a more complex query in production
        query = query.order("created_at", { ascending: false });
        break;
      default:
        query = query.order("created_at", { ascending: false });
        break;
    }

    // Apply pagination
    query = query.range(offset, offset + queryParams.limit - 1);

    const { data: comments, error: commentsError, count } = await query;

    if (commentsError) {
      throw commentsError;
    }

    // Get summary statistics
    const [
      { data: statusStats },
      { data: spamStats },
      { data: reportedComments },
    ] = await Promise.all([
      supabaseAdmin
        .from("comments")
        .select("status")
        .order("created_at", { ascending: false }),
      supabaseAdmin
        .from("comments")
        .select("is_flagged_as_spam")
        .order("created_at", { ascending: false }),
      supabaseAdmin
        .from("content_reports")
        .select("reported_content_id")
        .eq("reported_content_type", "comment")
        .eq("status", "pending"),
    ]);

    const statusCounts =
      statusStats?.reduce(
        (acc: Record<string, number>, comment: { status: string }) => {
          acc[comment.status] = (acc[comment.status] || 0) + 1;
          return acc;
        },
        {}
      ) || {};

    const spamCounts =
      spamStats?.reduce(
        (
          acc: Record<string, number>,
          comment: { is_flagged_as_spam: boolean }
        ) => {
          const key = comment.is_flagged_as_spam ? "spam" : "not_spam";
          acc[key] = (acc[key] || 0) + 1;
          return acc;
        },
        {}
      ) || {};

    const reportedCommentIds = new Set(
      reportedComments?.map((r) => r.reported_content_id) || []
    );

    // Transform comment data
    const transformedComments =
      comments?.map((comment: Record<string, unknown>) => ({
        ...comment,
        reactions_count:
          (comment.reactions_count as { count: number }[])?.[0]?.count || 0,
        replies_count:
          (comment.replies_count as { count: number }[])?.[0]?.count || 0,
        reports_count:
          (comment.reports_count as { count: number }[])?.[0]?.count || 0,
        has_pending_reports: reportedCommentIds.has(comment.id as string),
        content_preview:
          (comment.content as string).length > 100
            ? (comment.content as string).substring(0, 100) + "..."
            : comment.content,
      })) || [];

    return createSuccessResponse({
      comments: transformedComments,
      pagination: {
        page: queryParams.page,
        limit: queryParams.limit,
        total: count || 0,
        total_pages: Math.ceil((count || 0) / queryParams.limit),
      },
      statistics: {
        status_counts: statusCounts,
        spam_counts: spamCounts,
        total_reported: reportedCommentIds.size,
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    // Check admin authorization
    const { user } = await getAuthenticatedUser(request);
    if (!user || !isPlatformAdmin(user)) {
      return createErrorResponse("Admin access required", 403);
    }

    const body = await request.json();
    const { comment_ids, action, reason } = bulkUpdateSchema.parse(body);

    const updateData: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };

    let actionDescription = "";

    switch (action) {
      case "approve":
        updateData.status = "published";
        updateData.is_flagged_as_spam = false;
        actionDescription = "approved";
        break;
      case "flag":
        updateData.status = "flagged";
        actionDescription = "flagged";
        break;
      case "delete":
        updateData.status = "deleted";
        actionDescription = "deleted";
        break;
      case "mark_spam":
        updateData.is_flagged_as_spam = true;
        updateData.status = "flagged";
        actionDescription = "marked as spam";
        break;
      case "unmark_spam":
        updateData.is_flagged_as_spam = false;
        updateData.status = "published";
        actionDescription = "unmarked as spam";
        break;
      default:
        return createErrorResponse("Invalid action", 400);
    }

    // Update comments
    const { data: updatedComments, error: updateError } = await supabaseAdmin
      .from("comments")
      .update(updateData)
      .in("id", comment_ids).select(`
        id,
        content,
        status,
        is_flagged_as_spam,
        author:profiles(username, display_name),
        post:posts(title, slug)
      `);

    if (updateError) {
      throw updateError;
    }

    // Log admin action
    await supabaseAdmin.from("admin_activity_logs").insert({
      admin_id: user.id,
      action_type: "comments_bulk_update",
      target_id: null,
      details: {
        comment_ids,
        action,
        reason: reason || null,
        comment_count: comment_ids.length,
        action_description: actionDescription,
      },
      created_at: new Date().toISOString(),
    });

    // Create notifications for content authors if needed
    if (action === "approve" || action === "flag" || action === "delete") {
      const notifications =
        updatedComments?.map((comment: Record<string, unknown>) => ({
          user_id: (comment.author as { id: string }).id,
          type: "moderation",
          message: `Your comment has been ${actionDescription} by an administrator`,
          related_comment_id: comment.id,
          created_at: new Date().toISOString(),
        })) || [];

      if (notifications.length > 0) {
        await supabaseAdmin.from("notifications").insert(notifications);
      }
    }

    return createSuccessResponse({
      message: `${comment_ids.length} comment(s) ${actionDescription} successfully`,
      updated_comments: updatedComments,
      action: actionDescription,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
