// src/app/api/admin/posts/route.ts
import { getAuthenticatedUser, isPlatformAdmin } from "@/lib/authHelpers";
import {
  createErrorResponse,
  createSuccessResponse,
  handleRouteError,
} from "@/lib/errorHandler";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { NextRequest } from "next/server";
import { z } from "zod";

const getPostsSchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  search: z.string().optional(),
  status: z
    .enum(["all", "published", "draft", "archived"])
    .optional()
    .default("all"),
  reported: z
    .enum(["all", "reported", "not_reported"])
    .optional()
    .default("all"),
  sort: z
    .enum(["newest", "oldest", "most_viewed", "most_commented"])
    .optional()
    .default("newest"),
});

export async function GET(request: NextRequest) {
  try {
    // Check admin authorization
    const { user } = await getAuthenticatedUser(request);
    if (!user || !isPlatformAdmin(user)) {
      return createErrorResponse("Admin access required", 403);
    }

    const { searchParams } = new URL(request.url);
    const queryParams = getPostsSchema.parse(
      Object.fromEntries(searchParams.entries())
    );

    const offset = (queryParams.page - 1) * queryParams.limit;

    // Build base query
    let query = supabaseAdmin.from("posts").select(
      `
        id,
        title,
        slug,
        excerpt,
        status,
        published_at,
        view_count,
        created_at,
        updated_at,
        author:profiles(id, username, display_name, avatar_url),
        tags:post_tags(tag:tags(name)),
        comments_count:comments(count),
        reactions_count:reactions(count)
      `,
      { count: "exact" }
    );

    // Apply filters
    if (queryParams.search) {
      query = query.or(
        `title.ilike.%${queryParams.search}%,excerpt.ilike.%${queryParams.search}%`
      );
    }

    if (queryParams.status !== "all") {
      query = query.eq("status", queryParams.status);
    }

    // Apply sorting
    switch (queryParams.sort) {
      case "oldest":
        query = query.order("created_at", { ascending: true });
        break;
      case "most_viewed":
        query = query.order("view_count", { ascending: false });
        break;
      case "most_commented":
        // This would need a computed field or subquery
        query = query.order("created_at", { ascending: false });
        break;
      default:
        query = query.order("created_at", { ascending: false });
        break;
    }

    // Apply pagination
    query = query.range(offset, offset + queryParams.limit - 1);

    const { data: posts, error: postsError, count } = await query;

    if (postsError) {
      throw postsError;
    }

    // Get reported posts if needed
    let reportedPostIds = new Set();
    if (queryParams.reported === "reported") {
      const { data: reports } = await supabaseAdmin
        .from("post_reports")
        .select("post_id");
      reportedPostIds = new Set(reports?.map((r) => r.post_id) || []);
    }

    // Transform post data
    const transformedPosts =
      posts?.map((post: Record<string, unknown>) => ({
        ...post,
        tags: Array.isArray(post.tags)
          ? post.tags
              .map(
                (pt: Record<string, unknown>) =>
                  (pt.tag as Record<string, unknown>)?.name
              )
              .filter(Boolean)
          : [],
        comments_count: Array.isArray(post.comments_count)
          ? (post.comments_count[0] as Record<string, unknown>)?.count || 0
          : 0,
        reactions_count: Array.isArray(post.reactions_count)
          ? (post.reactions_count[0] as Record<string, unknown>)?.count || 0
          : 0,
        is_reported: reportedPostIds.has(post.id),
      })) || [];

    // Filter by reported status if needed
    const filteredPosts =
      queryParams.reported === "all"
        ? transformedPosts
        : transformedPosts.filter((post) =>
            queryParams.reported === "reported"
              ? post.is_reported
              : !post.is_reported
          );

    return createSuccessResponse({
      posts: filteredPosts,
      pagination: {
        page: queryParams.page,
        limit: queryParams.limit,
        total: count || 0,
        pages: Math.ceil((count || 0) / queryParams.limit),
      },
      filters: {
        search: queryParams.search,
        status: queryParams.status,
        reported: queryParams.reported,
        sort: queryParams.sort,
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
