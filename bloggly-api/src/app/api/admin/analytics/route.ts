// src/app/api/admin/analytics/route.ts
import { getAuthenticatedUser, isPlatformAdmin } from "@/lib/authHelpers";
import {
  createErrorResponse,
  createSuccessResponse,
  handleRouteError,
} from "@/lib/errorHandler";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { NextRequest } from "next/server";
import { z } from "zod";

const analyticsSchema = z.object({
  period: z.enum(["7d", "30d", "90d", "1y"]).optional().default("30d"),
  metrics: z
    .array(z.enum(["users", "posts", "comments", "views", "engagement"]))
    .optional(),
});

export async function GET(request: NextRequest) {
  try {
    // Check admin authorization
    const { user } = await getAuthenticatedUser(request);
    if (!user || !isPlatformAdmin(user)) {
      return createErrorResponse("Admin access required", 403);
    }

    const { searchParams } = new URL(request.url);
    const { period } = analyticsSchema.parse({
      period: searchParams.get("period"),
      metrics: searchParams.get("metrics")?.split(","),
    });

    // Calculate date range
    const now = new Date();
    const daysMap = { "7d": 7, "30d": 30, "90d": 90, "1y": 365 };
    const days = daysMap[period];
    const startDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

    // Get overall statistics
    const [
      totalUsersResult,
      newUsersResult,
      totalPostsResult,
      newPostsResult,
      totalCommentsResult,
      newCommentsResult,
      totalViewsResult,
      activeUsersResult,
    ] = await Promise.all([
      // Total users
      supabaseAdmin.from("profiles").select("id", { count: "exact" }),

      // New users in period
      supabaseAdmin
        .from("profiles")
        .select("id", { count: "exact" })
        .gte("created_at", startDate.toISOString()),

      // Total posts
      supabaseAdmin.from("posts").select("id", { count: "exact" }),

      // New posts in period
      supabaseAdmin
        .from("posts")
        .select("id", { count: "exact" })
        .gte("created_at", startDate.toISOString()),

      // Total comments
      supabaseAdmin.from("comments").select("id", { count: "exact" }),

      // New comments in period
      supabaseAdmin
        .from("comments")
        .select("id", { count: "exact" })
        .gte("created_at", startDate.toISOString()),

      // Total views (sum of all post views)
      supabaseAdmin.from("posts").select("view_count"),

      // Active users (users who performed any action in the period)
      supabaseAdmin
        .from("user_activity_logs")
        .select("user_id")
        .gte("created_at", startDate.toISOString()),
    ]);

    // Calculate total views
    const totalViews =
      totalViewsResult.data?.reduce(
        (sum, post) => sum + (post.view_count || 0),
        0
      ) || 0;

    // Get unique active users
    const uniqueActiveUsers = new Set(
      activeUsersResult.data?.map((log) => log.user_id) || []
    ).size;

    // Get daily statistics for charts
    const dailyStats = [];
    for (let i = days - 1; i >= 0; i--) {
      const date = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
      const nextDate = new Date(date.getTime() + 24 * 60 * 60 * 1000);

      const [usersCount, postsCount, commentsCount] = await Promise.all([
        supabaseAdmin
          .from("profiles")
          .select("id", { count: "exact" })
          .gte("created_at", date.toISOString())
          .lt("created_at", nextDate.toISOString()),

        supabaseAdmin
          .from("posts")
          .select("id", { count: "exact" })
          .gte("created_at", date.toISOString())
          .lt("created_at", nextDate.toISOString()),

        supabaseAdmin
          .from("comments")
          .select("id", { count: "exact" })
          .gte("created_at", date.toISOString())
          .lt("created_at", nextDate.toISOString()),
      ]);

      dailyStats.push({
        date: date.toISOString().split("T")[0],
        new_users: usersCount.count || 0,
        new_posts: postsCount.count || 0,
        new_comments: commentsCount.count || 0,
      });
    }

    // Get top content
    const [topPosts, topUsers, topTags] = await Promise.all([
      // Top posts by views
      supabaseAdmin
        .from("posts")
        .select(
          `
          id,
          title,
          slug,
          view_count,
          author:profiles(username, display_name)
        `
        )
        .eq("status", "published")
        .order("view_count", { ascending: false })
        .limit(10),

      // Top users by post count
      supabaseAdmin
        .from("posts")
        .select(
          `
          author_id,
          author:profiles(username, display_name, avatar_url)
        `
        )
        .eq("status", "published")
        .gte("created_at", startDate.toISOString()),

      // Top tags by usage
      supabaseAdmin
        .from("post_tags")
        .select(
          `
          tag:tags(id, name),
          post:posts(created_at)
        `
        )
        .gte("post.created_at", startDate.toISOString()),
    ]);

    // Process top users
    const userPostCounts: Record<string, Record<string, unknown>> = {};

    if (topUsers.data) {
      for (const post of topUsers.data as Record<string, unknown>[]) {
        const authorId = post.author_id as string;
        const author = post.author as Record<string, unknown>;

        if (!userPostCounts[authorId]) {
          userPostCounts[authorId] = {
            ...author,
            post_count: 0,
          };
        }
        userPostCounts[authorId].post_count =
          (userPostCounts[authorId].post_count as number) + 1;
      }
    }

    const topUsersArray = Object.values(userPostCounts)
      .sort((a, b) => (b.post_count as number) - (a.post_count as number))
      .slice(0, 10);

    // Process top tags
    const tagCounts: Record<string, number> = {};

    if (topTags.data) {
      for (const item of topTags.data as Record<string, unknown>[]) {
        const tag = item.tag as Record<string, unknown>;
        const tagName = tag?.name as string;
        if (tagName) {
          tagCounts[tagName] = (tagCounts[tagName] || 0) + 1;
        }
      }
    }

    const topTagsArray = Object.entries(tagCounts)
      .map(([name, count]) => ({ name, usage_count: count }))
      .sort((a, b) => b.usage_count - a.usage_count)
      .slice(0, 10);

    return createSuccessResponse({
      overview: {
        total_users: totalUsersResult.count || 0,
        new_users: newUsersResult.count || 0,
        active_users: uniqueActiveUsers,
        total_posts: totalPostsResult.count || 0,
        new_posts: newPostsResult.count || 0,
        total_comments: totalCommentsResult.count || 0,
        new_comments: newCommentsResult.count || 0,
        total_views: totalViews,
      },
      daily_stats: dailyStats,
      top_content: {
        posts: topPosts.data || [],
        users: topUsersArray,
        tags: topTagsArray,
      },
      period,
      generated_at: now.toISOString(),
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
