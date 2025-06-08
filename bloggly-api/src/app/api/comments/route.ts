// src/app/api/comments/route.ts
import { getAuthenticatedUserWithProfile } from "@/lib/authHelpers";
import {
  createErrorResponse,
  createSuccessResponse,
  handleRouteError,
} from "@/lib/errorHandler";
import { checkSpam } from "@/lib/spamService";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  CommentReactionCount,
  CommentWithRelations,
  ReactionType,
} from "@/lib/types";
import { extractMentions } from "@/lib/utils";
import { NextRequest } from "next/server";
import { z } from "zod";

const createCommentSchema = z.object({
  post_id: z.string().uuid(),
  content: z.string().min(1).max(2000),
  parent_id: z.string().uuid().optional(),
});

const getCommentsSchema = z.object({
  post_id: z.string().uuid(),
  limit: z.coerce.number().int().min(1).max(50).optional().default(20),
  cursor: z.string().optional(),
  sort: z.enum(["newest", "oldest", "top"]).optional().default("top"),
});

export async function POST(request: NextRequest) {
  try {
    const { user, profile } = await getAuthenticatedUserWithProfile(request);
    if (!user || !profile) {
      return createErrorResponse("Authentication required.", 401);
    }

    const body = await request.json();
    const { post_id, content, parent_id } = createCommentSchema.parse(body);

    // Check if post exists and is published
    const { data: post, error: postError } = await supabaseAdmin
      .from("posts")
      .select("id, status, allow_comments, author_id")
      .eq("id", post_id)
      .single();

    if (postError || !post) {
      return createErrorResponse("Post not found.", 404);
    }

    if (post.status !== "published") {
      return createErrorResponse("Cannot comment on unpublished posts.", 400);
    }

    if (!post.allow_comments) {
      return createErrorResponse("Comments are disabled for this post.", 400);
    }

    // Check if parent comment exists (if replying)
    if (parent_id) {
      const { data: parentComment, error: parentError } = await supabaseAdmin
        .from("comments")
        .select("id, post_id")
        .eq("id", parent_id)
        .single();

      if (parentError || !parentComment || parentComment.post_id !== post_id) {
        return createErrorResponse("Parent comment not found.", 404);
      }
    }

    // Check for spam
    const isSpam = await checkSpam({
      content,
      authorEmail: user.email || "",
      authorName: profile.display_name || profile.username,
      userIP: request.headers.get("x-forwarded-for") || "unknown",
      userAgent: request.headers.get("user-agent") || "unknown",
    });

    // Extract mentions from content
    const mentions = extractMentions(content);

    // Create comment
    const commentData = {
      post_id,
      author_id: user.id,
      content,
      parent_id: parent_id || null,
      is_spam: isSpam,
      status: isSpam ? "flagged" : "published",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const { data: comment, error: commentError } = await supabaseAdmin
      .from("comments")
      .insert(commentData)
      .select(
        `
        *,
        author:profiles(id, username, display_name, avatar_url),
        reactions_count:comment_reactions(reaction_type, count),
        replies_count:comments!parent_id(count)
      `
      )
      .single();

    if (commentError) {
      throw commentError;
    }

    // Handle mentions
    if (mentions.length > 0) {
      const mentionNotifications = [];

      for (const username of mentions) {
        const { data: mentionedUser } = await supabaseAdmin
          .from("profiles")
          .select("id")
          .eq("username", username)
          .single();

        if (mentionedUser && mentionedUser.id !== user.id) {
          mentionNotifications.push({
            user_id: mentionedUser.id,
            type: "mention",
            message: `${profile.display_name || profile.username} mentioned you in a comment`,
            related_post_id: post_id,
            related_comment_id: comment.id,
            created_at: new Date().toISOString(),
          });
        }
      }

      if (mentionNotifications.length > 0) {
        await supabaseAdmin.from("notifications").insert(mentionNotifications);
      }
    }

    // Create notification for post author (if not self-comment)
    if (user.id !== post.author_id && !parent_id) {
      await supabaseAdmin.from("notifications").insert({
        user_id: post.author_id,
        type: "comment",
        message: `${profile.display_name || profile.username} commented on your post`,
        related_post_id: post_id,
        related_comment_id: comment.id,
        created_at: new Date().toISOString(),
      });
    }

    // Create notification for parent comment author (if replying)
    if (parent_id) {
      const { data: parentComment } = await supabaseAdmin
        .from("comments")
        .select("author_id")
        .eq("id", parent_id)
        .single();

      if (parentComment && parentComment.author_id !== user.id) {
        await supabaseAdmin.from("notifications").insert({
          user_id: parentComment.author_id,
          type: "reply",
          message: `${profile.display_name || profile.username} replied to your comment`,
          related_post_id: post_id,
          related_comment_id: comment.id,
          created_at: new Date().toISOString(),
        });
      }
    }

    // Log activity
    await supabaseAdmin.from("activity_logs").insert({
      user_id: user.id,
      action: "comment_created",
      resource_type: "comment",
      resource_id: comment.id,
      metadata: {
        post_id,
        parent_id,
        is_spam: isSpam,
      },
    });

    return createSuccessResponse(comment, 201);
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const queryParams = Object.fromEntries(searchParams.entries());

    const { post_id, limit, cursor, sort } =
      getCommentsSchema.parse(queryParams);

    // Check if post exists
    const { data: post, error: postError } = await supabaseAdmin
      .from("posts")
      .select("id, status")
      .eq("id", post_id)
      .single();

    if (postError || !post) {
      return createErrorResponse("Post not found.", 404);
    }

    if (post.status !== "published") {
      return createErrorResponse(
        "Cannot view comments on unpublished posts.",
        400
      );
    }

    // Build query for top-level comments
    let query = supabaseAdmin
      .from("comments")
      .select(
        `
        *,
        author:profiles(id, username, display_name, avatar_url),
        reactions_count:comment_reactions(reaction_type, count),
        replies_count:comments!parent_id(count),
        replies:comments!parent_id(
          *,
          author:profiles(id, username, display_name, avatar_url),
          reactions_count:comment_reactions(reaction_type, count)
        )
      `
      )
      .eq("post_id", post_id)
      .is("parent_id", null)
      .eq("status", "published")
      .limit(limit);

    // Apply sorting
    switch (sort) {
      case "newest":
        query = query.order("created_at", { ascending: false });
        break;
      case "oldest":
        query = query.order("created_at", { ascending: true });
        break;
      case "top":
      default:
        // Order by reaction count, then by created_at
        query = query
          .order("like_count", { ascending: false })
          .order("created_at", { ascending: false });
        break;
    }

    // Apply cursor pagination
    if (cursor) {
      const cursorDate = new Date(cursor).toISOString();
      query = query.lt("created_at", cursorDate);
    }

    const { data: comments, error: commentsError } = await query;

    if (commentsError) {
      throw commentsError;
    }

    // Transform comments data
    const transformedComments = comments.map(
      (comment: CommentWithRelations) => ({
        ...comment,
        reactions_count:
          comment.reactions_count?.reduce(
            (
              acc: Record<ReactionType, number>,
              reaction: CommentReactionCount
            ) => {
              acc[reaction.reaction_type] = reaction.count;
              return acc;
            },
            {} as Record<ReactionType, number>
          ) || {},
        replies_count: comment.replies_count?.[0]?.count || 0,
        replies:
          comment.replies?.map((reply: CommentWithRelations) => ({
            ...reply,
            reactions_count:
              reply.reactions_count?.reduce(
                (
                  acc: Record<ReactionType, number>,
                  reaction: CommentReactionCount
                ) => {
                  acc[reaction.reaction_type] = reaction.count;
                  return acc;
                },
                {} as Record<ReactionType, number>
              ) || {},
          })) || [],
      })
    );

    const hasMore = comments.length === limit;
    const nextCursor = hasMore
      ? comments[comments.length - 1].created_at
      : null;

    return createSuccessResponse({
      comments: transformedComments,
      pagination: {
        has_more: hasMore,
        next_cursor: nextCursor,
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
