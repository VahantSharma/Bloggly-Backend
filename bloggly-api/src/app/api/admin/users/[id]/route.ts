// src/app/api/admin/users/[id]/route.ts
import { getAuthenticatedUser, isPlatformAdmin } from "@/lib/authHelpers";
import {
  createErrorResponse,
  createSuccessResponse,
  handleRouteError,
} from "@/lib/errorHandler";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { NextRequest } from "next/server";
import { z } from "zod";

const userIdSchema = z.string().uuid();

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

    const userId = userIdSchema.parse(params.id);

    // Get user details
    const { data: userProfile, error: userError } = await supabaseAdmin
      .from("profiles")
      .select(
        `
        id,
        username,
        display_name,
        email,
        avatar_url,
        bio,
        website_url,
        location,
        social_twitter,
        social_github,
        social_linkedin,
        is_email_verified,
        email_notification_preferences,
        created_at,
        updated_at
      `
      )
      .eq("id", userId)
      .single();

    if (userError) {
      if (userError.code === "PGRST116") {
        return createErrorResponse("User not found", 404);
      }
      throw userError;
    }

    // Get user statistics
    const [
      postsResult,
      commentsResult,
      followersResult,
      followingResult,
      activitiesResult,
      bannedResult,
    ] = await Promise.all([
      supabaseAdmin
        .from("posts")
        .select("id, status", { count: "exact" })
        .eq("author_id", userId),
      supabaseAdmin
        .from("comments")
        .select("id, status", { count: "exact" })
        .eq("author_id", userId),
      supabaseAdmin
        .from("follows")
        .select("id", { count: "exact" })
        .eq("following_id", userId),
      supabaseAdmin
        .from("follows")
        .select("id", { count: "exact" })
        .eq("follower_id", userId),
      supabaseAdmin
        .from("user_activity_logs")
        .select("action_type, created_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(10),
      supabaseAdmin
        .from("banned_users")
        .select("banned_at, reason, banned_by")
        .eq("user_id", userId)
        .single(),
    ]);

    const postsByStatus =
      postsResult.data?.reduce(
        (acc: Record<string, number>, post: { status: string }) => {
          acc[post.status] = (acc[post.status] || 0) + 1;
          return acc;
        },
        {}
      ) || {};

    const commentsByStatus =
      commentsResult.data?.reduce(
        (acc: Record<string, number>, comment: { status: string }) => {
          acc[comment.status] = (acc[comment.status] || 0) + 1;
          return acc;
        },
        {}
      ) || {};

    return createSuccessResponse({
      user: userProfile,
      statistics: {
        posts: {
          total: postsResult.count || 0,
          published: postsByStatus.published || 0,
          draft: postsByStatus.draft || 0,
          archived: postsByStatus.archived || 0,
        },
        comments: {
          total: commentsResult.count || 0,
          published: commentsByStatus.published || 0,
          flagged: commentsByStatus.flagged || 0,
        },
        social: {
          followers: followersResult.count || 0,
          following: followingResult.count || 0,
        },
      },
      recent_activities: activitiesResult.data || [],
      is_banned: !bannedResult.error,
      ban_info: bannedResult.error ? null : bannedResult.data,
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

    const userId = userIdSchema.parse(params.id);

    // Prevent self-deletion
    if (userId === user.id) {
      return createErrorResponse("Cannot delete your own account", 400);
    }

    // Check if user exists
    const { data: existingUser, error: userError } = await supabaseAdmin
      .from("profiles")
      .select("id, username")
      .eq("id", userId)
      .single();

    if (userError) {
      if (userError.code === "PGRST116") {
        return createErrorResponse("User not found", 404);
      }
      throw userError;
    }

    // Delete user from Supabase Auth (this will cascade to related data)
    const { error: deleteError } =
      await supabaseAdmin.auth.admin.deleteUser(userId);

    if (deleteError) {
      throw deleteError;
    }

    // Log admin action
    await supabaseAdmin.from("admin_activity_logs").insert({
      admin_id: user.id,
      action_type: "user_deleted",
      target_id: userId,
      details: {
        deleted_username: existingUser.username,
        deletion_method: "admin_panel",
      },
      created_at: new Date().toISOString(),
    });

    return createSuccessResponse({
      message: `User ${existingUser.username} has been permanently deleted`,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
