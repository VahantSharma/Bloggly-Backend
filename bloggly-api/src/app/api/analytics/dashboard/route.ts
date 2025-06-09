import { validateToken } from "@/lib/authHelpers";
import { handleRouteError } from "@/lib/errorHandler";
import { rateLimitAPI } from "@/lib/rateLimit";
import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";

// Types for better type safety
interface PostAnalytics {
  id: string;
  title: string;
  slug: string;
  views_count: number;
  reactions_count: number;
  comments_count: number;
  published_at: string;
  reading_time: number;
}

interface AnalyticsOverview {
  timeframe: string;
  overview: Record<string, number>;
  posts: {
    published: number;
    total_views: number;
    total_reactions: number;
    total_comments: number;
    top_posts: Array<{
      title: string;
      slug: string;
      views: number;
      reactions: number;
      comments: number;
    }>;
  };
  engagement: {
    reactions_received: number;
    comments_received: number;
    followers_gained: number;
    profile_views: number;
  };
  reading: {
    posts_read: number;
    total_reading_time: number;
    favorite_tags: Array<{ tag: string; count: number }>;
  };
  activity: {
    daily_stats: Array<{ date: string; count: number }>;
    most_active_day: { date: string; activity_count: number } | null;
    streak: number;
  };
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// GET /api/analytics/dashboard - Get user's personal analytics dashboard
export async function GET(request: NextRequest) {
  try {
    // Apply rate limiting
    const rateLimitResult = await rateLimitAPI("analytics-dashboard");
    if (!rateLimitResult.allowed) {
      return NextResponse.json(
        { error: "Rate limit exceeded" },
        { status: 429 }
      );
    }

    // Validate authentication
    const user = await validateToken(request);
    if (!user) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 }
      );
    }

    const { searchParams } = new URL(request.url);
    const timeframe = searchParams.get("timeframe") || "30"; // days
    const days = Math.min(parseInt(timeframe), 365);
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const analytics: AnalyticsOverview = {
      timeframe: `${days} days`,
      overview: {},
      posts: {
        published: 0,
        total_views: 0,
        total_reactions: 0,
        total_comments: 0,
        top_posts: [],
      },
      engagement: {
        reactions_received: 0,
        comments_received: 0,
        followers_gained: 0,
        profile_views: 0,
      },
      reading: {
        posts_read: 0,
        total_reading_time: 0,
        favorite_tags: [],
      },
      activity: {
        daily_stats: [],
        most_active_day: null,
        streak: 0,
      },
    };

    // Get user's posts analytics
    const { data: userPosts } = await supabase
      .from("posts")
      .select(
        `
        id,
        title,
        slug,
        views_count,
        reactions_count,
        comments_count,
        published_at,
        reading_time
      `
      )
      .eq("author_id", user.id)
      .eq("status", "published")
      .gte("published_at", startDate.toISOString());

    if (userPosts) {
      analytics.posts.published = userPosts.length;
      analytics.posts.total_views = userPosts.reduce(
        (sum: number, post: PostAnalytics) => sum + (post.views_count || 0),
        0
      );
      analytics.posts.total_reactions = userPosts.reduce(
        (sum: number, post: PostAnalytics) => sum + (post.reactions_count || 0),
        0
      );
      analytics.posts.total_comments = userPosts.reduce(
        (sum: number, post: PostAnalytics) => sum + (post.comments_count || 0),
        0
      );

      // Top posts by views
      analytics.posts.top_posts = userPosts
        .sort(
          (a: PostAnalytics, b: PostAnalytics) =>
            (b.views_count || 0) - (a.views_count || 0)
        )
        .slice(0, 5)
        .map((post: PostAnalytics) => ({
          title: post.title,
          slug: post.slug,
          views: post.views_count || 0,
          reactions: post.reactions_count || 0,
          comments: post.comments_count || 0,
        }));
    }

    // Get engagement analytics
    const { data: recentReactions } = await supabase
      .from("reactions")
      .select("id, created_at")
      .eq("post_author_id", user.id)
      .gte("created_at", startDate.toISOString());

    if (recentReactions) {
      analytics.engagement.reactions_received = recentReactions.length;
    }

    const { data: recentComments } = await supabase
      .from("comments")
      .select("id, created_at")
      .eq("post_author_id", user.id)
      .gte("created_at", startDate.toISOString());

    if (recentComments) {
      analytics.engagement.comments_received = recentComments.length;
    }

    // Get followers gained in timeframe
    const { data: recentFollows } = await supabase
      .from("follows")
      .select("created_at")
      .eq("following_id", user.id)
      .gte("created_at", startDate.toISOString());

    if (recentFollows) {
      analytics.engagement.followers_gained = recentFollows.length;
    }

    // Get reading analytics
    const { data: readingHistory } = await supabase
      .from("post_views")
      .select(
        `
        viewed_at,
        posts!inner(tags, reading_time)
      `
      )
      .eq("user_id", user.id)
      .gte("viewed_at", startDate.toISOString());

    if (readingHistory) {
      analytics.reading.posts_read = readingHistory.length;

      // Calculate total reading time
      analytics.reading.total_reading_time = readingHistory.reduce(
        (sum: number, view: { posts: Array<{ reading_time?: number }> }) => {
          const readingTime = view.posts[0]?.reading_time || 0;
          return sum + readingTime;
        },
        0
      );

      // Calculate favorite tags
      const tagCounts: { [key: string]: number } = {};
      readingHistory.forEach((view: { posts: Array<{ tags?: string[] }> }) => {
        const tags = view.posts[0]?.tags;
        if (tags) {
          tags.forEach((tag: string) => {
            tagCounts[tag] = (tagCounts[tag] || 0) + 1;
          });
        }
      });

      analytics.reading.favorite_tags = Object.entries(tagCounts)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 10)
        .map(([tag, count]) => ({ tag, count }));
    }

    // Get daily activity stats
    const { data: dailyActivity } = await supabase
      .from("analytics_events")
      .select("created_at, event_type")
      .eq("user_id", user.id)
      .gte("created_at", startDate.toISOString())
      .order("created_at", { ascending: false });

    if (dailyActivity) {
      // Group by day
      const dailyStats: { [key: string]: number } = {};
      dailyActivity.forEach((event: { created_at: string }) => {
        const day = event.created_at.split("T")[0];
        dailyStats[day] = (dailyStats[day] || 0) + 1;
      });

      analytics.activity.daily_stats = Object.entries(dailyStats)
        .map(([date, count]) => ({ date, count }))
        .sort((a, b) => a.date.localeCompare(b.date));

      // Find most active day
      const maxActivity = Math.max(...Object.values(dailyStats));
      const mostActiveDay = Object.entries(dailyStats).find(
        ([, count]) => count === maxActivity
      );

      if (mostActiveDay) {
        analytics.activity.most_active_day = {
          date: mostActiveDay[0],
          activity_count: mostActiveDay[1],
        };
      }

      // Calculate current streak (consecutive days with activity)
      const sortedDays = Object.keys(dailyStats).sort().reverse();
      let streak = 0;
      const today = new Date().toISOString().split("T")[0];

      for (const day of sortedDays) {
        const daysDiff = Math.floor(
          (new Date(today).getTime() - new Date(day).getTime()) /
            (1000 * 60 * 60 * 24)
        );
        if (daysDiff === streak) {
          streak++;
        } else {
          break;
        }
      }
      analytics.activity.streak = streak;
    }

    // Set overview
    analytics.overview = {
      posts_published: analytics.posts.published,
      total_views: analytics.posts.total_views,
      total_reactions: analytics.posts.total_reactions,
      followers_gained: analytics.engagement.followers_gained,
      posts_read: analytics.reading.posts_read,
      current_streak: analytics.activity.streak,
    };

    return NextResponse.json(analytics);
  } catch (error) {
    console.error("Error in analytics dashboard GET:", error);
    return handleRouteError(error);
  }
}
