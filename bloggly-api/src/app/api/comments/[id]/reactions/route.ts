// src/app/api/comments/[id]/reactions/route.ts
import { getAuthenticatedUserWithProfile } from "@/lib/authHelpers";
import {
  createErrorResponse,
  createSuccessResponse,
  handleRouteError,
} from "@/lib/errorHandler";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { NextRequest } from "next/server";
import { z } from "zod";

const reactionSchema = z.object({
  reaction_type: z.enum(["like", "love", "insightful", "unicorn"]),
});

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const { user, profile } = await getAuthenticatedUserWithProfile(request);
    if (!user || !profile) {
      return createErrorResponse("Authentication required.", 401);
    }

    const commentId = z.string().uuid().parse(params.id);
    const body = await request.json();
    const { reaction_type } = reactionSchema.parse(body);

    // Check if comment exists
    const { data: comment, error: commentError } = await supabaseAdmin
      .from("comments")
      .select("id, user_id, is_flagged_as_spam")
      .eq("id", commentId)
      .single();

    if (commentError || !comment) {
      return createErrorResponse("Comment not found.", 404);
    }

    if (comment.is_flagged_as_spam) {
      return createErrorResponse("Cannot react to this comment.", 400);
    }

    // Check if user already reacted to this comment
    const { data: existingReaction } = await supabaseAdmin
      .from("comment_reactions")
      .select("*")
      .eq("comment_id", commentId)
      .eq("user_id", user.id)
      .single();

    if (existingReaction) {
      if (existingReaction.reaction_type === reaction_type) {
        // Remove reaction if same type
        const { error: deleteError } = await supabaseAdmin
          .from("comment_reactions")
          .delete()
          .eq("id", existingReaction.id);

        if (deleteError) {
          throw deleteError;
        }

        return createSuccessResponse({
          message: "Reaction removed successfully.",
          action: "removed",
        });
      } else {
        // Update reaction if different type
        const { error: updateError } = await supabaseAdmin
          .from("comment_reactions")
          .update({
            reaction_type,
            updated_at: new Date().toISOString(),
          })
          .eq("id", existingReaction.id);

        if (updateError) {
          throw updateError;
        }

        return createSuccessResponse({
          message: "Reaction updated successfully.",
          action: "updated",
          reaction_type,
        });
      }
    } else {
      // Create new reaction
      const { error: insertError } = await supabaseAdmin
        .from("comment_reactions")
        .insert({
          comment_id: commentId,
          user_id: user.id,
          reaction_type,
          created_at: new Date().toISOString(),
        });

      if (insertError) {
        throw insertError;
      }

      // Create notification for comment author (if not self-reaction)
      if (comment.user_id !== user.id) {
        await supabaseAdmin.from("notifications").insert({
          user_id: comment.user_id,
          type: "reaction",
          message: `${profile.display_name || profile.username} reacted to your comment`,
          related_comment_id: commentId,
          created_at: new Date().toISOString(),
        });
      }

      return createSuccessResponse(
        {
          message: "Reaction added successfully.",
          action: "added",
          reaction_type,
        },
        201
      );
    }
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const commentId = z.string().uuid().parse(params.id);

    // Get reaction counts for the comment
    const { data: reactions, error: reactionsError } = await supabaseAdmin
      .from("comment_reactions")
      .select(
        `
        reaction_type,
        user:profiles(username, display_name, avatar_url)
      `
      )
      .eq("comment_id", commentId);

    if (reactionsError) {
      throw reactionsError;
    }

    // Group reactions by type
    const reactionCounts: Record<string, number> = {};
    const reactionUsers: Record<
      string,
      Array<{ username: string; display_name?: string; avatar_url?: string }>
    > = {};

    // Type assertion for the database query result
    const typedReactions = reactions as unknown as Array<{
      reaction_type: string;
      user: { username: string; display_name?: string; avatar_url?: string };
    }>;

    typedReactions.forEach((reaction) => {
      const type = reaction.reaction_type;

      if (!reactionCounts[type]) {
        reactionCounts[type] = 0;
        reactionUsers[type] = [];
      }

      reactionCounts[type]++;
      reactionUsers[type].push(reaction.user);
    });

    return createSuccessResponse({
      reaction_counts: reactionCounts,
      reaction_users: reactionUsers,
      total_reactions: reactions.length,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
