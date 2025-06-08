// src/app/api/comments/[id]/route.ts
import { getAuthenticatedUser } from "@/lib/authHelpers";
import {
  createErrorResponse,
  createSuccessResponse,
  handleRouteError,
} from "@/lib/errorHandler";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { NextRequest } from "next/server";
import { z } from "zod";

const updateCommentSchema = z.object({
  content: z.string().min(1).max(2000),
});

export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const { user } = await getAuthenticatedUser(request);
    if (!user) {
      return createErrorResponse("Authentication required.", 401);
    }

    const commentId = z.string().uuid().parse(params.id);
    const body = await request.json();
    const { content } = updateCommentSchema.parse(body);

    // Check if comment exists and user has permission
    const { data: existingComment, error: fetchError } = await supabaseAdmin
      .from("comments")
      .select("*")
      .eq("id", commentId)
      .single();

    if (fetchError || !existingComment) {
      return createErrorResponse("Comment not found.", 404);
    }

    // Check permissions (only author can edit)
    if (existingComment.author_id !== user.id) {
      return createErrorResponse("You can only edit your own comments.", 403);
    }

    // Check if comment is still editable (within edit window)
    const createdAt = new Date(existingComment.created_at);
    const now = new Date();
    const editWindowMinutes = 15; // 15-minute edit window
    const isWithinEditWindow =
      now.getTime() - createdAt.getTime() <= editWindowMinutes * 60 * 1000;

    if (!isWithinEditWindow && existingComment.status !== "draft") {
      return createErrorResponse("Comment edit window has expired.", 400);
    }

    // Update comment
    const { data: updatedComment, error: updateError } = await supabaseAdmin
      .from("comments")
      .update({
        content,
        edited_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", commentId)
      .select(
        `
        *,
        author:profiles(id, username, display_name, avatar_url),
        reactions_count:comment_reactions(reaction_type, count)
      `
      )
      .single();

    if (updateError) {
      throw updateError;
    }

    // Log activity
    await supabaseAdmin.from("activity_logs").insert({
      user_id: user.id,
      action: "comment_updated",
      resource_type: "comment",
      resource_id: commentId,
      metadata: {
        post_id: existingComment.post_id,
      },
    });

    return createSuccessResponse(updatedComment);
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const { user } = await getAuthenticatedUser(request);
    if (!user) {
      return createErrorResponse("Authentication required.", 401);
    }

    const commentId = z.string().uuid().parse(params.id);

    // Check if comment exists and user has permission
    const { data: existingComment, error: fetchError } = await supabaseAdmin
      .from("comments")
      .select("*")
      .eq("id", commentId)
      .single();

    if (fetchError || !existingComment) {
      return createErrorResponse("Comment not found.", 404);
    }

    // Check permissions (author or post author can delete)
    const { data: post } = await supabaseAdmin
      .from("posts")
      .select("author_id")
      .eq("id", existingComment.post_id)
      .single();

    const canDelete =
      existingComment.author_id === user.id ||
      (post && post.author_id === user.id);

    if (!canDelete) {
      return createErrorResponse(
        "Insufficient permissions to delete this comment.",
        403
      );
    }

    // Soft delete - update status to deleted
    const { error: deleteError } = await supabaseAdmin
      .from("comments")
      .update({
        status: "deleted",
        deleted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", commentId);

    if (deleteError) {
      throw deleteError;
    }

    // Log activity
    await supabaseAdmin.from("activity_logs").insert({
      user_id: user.id,
      action: "comment_deleted",
      resource_type: "comment",
      resource_id: commentId,
      metadata: {
        post_id: existingComment.post_id,
        was_author: existingComment.author_id === user.id,
      },
    });

    return createSuccessResponse({ message: "Comment deleted successfully." });
  } catch (error) {
    return handleRouteError(error);
  }
}
