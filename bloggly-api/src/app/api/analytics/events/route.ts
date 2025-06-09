import { validateToken } from "@/lib/authHelpers";
import { handleRouteError } from "@/lib/errorHandler";
import { rateLimitAPI } from "@/lib/rateLimit";
import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const analyticsEventSchema = z.object({
  event_type: z.enum([
    "page_view",
    "post_view",
    "post_read",
    "search",
    "click",
    "scroll",
    "time_spent",
  ]),
  post_id: z.string().optional(),
  data: z.record(z.any()).optional(),
  timestamp: z.string().optional(),
});

// POST /api/analytics/events - Track user events for analytics
export async function POST(request: NextRequest) {
  try {
    // Apply rate limiting
    const rateLimitResult = await rateLimitAPI("analytics-events");
    if (!rateLimitResult.allowed) {
      return NextResponse.json(
        { error: "Rate limit exceeded" },
        { status: 429 }
      );
    }

    // Validate authentication (optional)
    const user = await validateToken(request, false);

    const body = await request.json();

    // Validate request body
    const validationResult = analyticsEventSchema.safeParse(body);
    if (!validationResult.success) {
      return NextResponse.json(
        {
          error: "Invalid request body",
          details: validationResult.error.errors,
        },
        { status: 400 }
      );
    }

    const { event_type, post_id, data, timestamp } = validationResult.data;

    // Get client IP and user agent for analytics
    const clientIP =
      request.headers.get("x-forwarded-for") ||
      request.headers.get("x-real-ip") ||
      "unknown";
    const userAgent = request.headers.get("user-agent") || "unknown";

    // Insert analytics event
    const { error } = await supabase.from("analytics_events").insert({
      user_id: user?.id || null,
      event_type,
      post_id: post_id || null,
      data: data || {},
      client_ip: clientIP,
      user_agent: userAgent,
      created_at: timestamp || new Date().toISOString(),
    });

    if (error) {
      console.error("Error inserting analytics event:", error);
      return NextResponse.json(
        { error: "Failed to track event" },
        { status: 500 }
      );
    }

    // Special handling for specific event types
    if (event_type === "post_view" && post_id) {
      // Update post views count
      const { error: viewError } = await supabase.rpc("increment_post_views", {
        post_uuid: post_id,
      });

      if (viewError) {
        console.error("Error updating post views:", viewError);
      }

      // Track individual user view (if authenticated)
      if (user) {
        await supabase.from("post_views").upsert(
          {
            user_id: user.id,
            post_id,
            viewed_at: new Date().toISOString(),
          },
          {
            onConflict: "user_id,post_id",
          }
        );
      }
    }

    return NextResponse.json({
      message: "Event tracked successfully",
    });
  } catch (error) {
    console.error("Error in analytics events POST:", error);
    return handleRouteError(error);
  }
}
