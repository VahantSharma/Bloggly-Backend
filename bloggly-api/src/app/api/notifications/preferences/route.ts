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

const notificationPreferencesSchema = z.object({
  email_notifications: z.boolean().optional(),
  push_notifications: z.boolean().optional(),
  comment_notifications: z.boolean().optional(),
  reaction_notifications: z.boolean().optional(),
  follow_notifications: z.boolean().optional(),
  mention_notifications: z.boolean().optional(),
  post_published_notifications: z.boolean().optional(),
  weekly_digest: z.boolean().optional(),
  marketing_emails: z.boolean().optional(),
});

// GET /api/notifications/preferences - Get user notification preferences
export async function GET(request: NextRequest) {
  try {
    // Apply rate limiting
    const rateLimitResult = await rateLimitAPI("notification-preferences-get");
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

    // Get user preferences
    const { data: preferences, error } = await supabase
      .from("notification_preferences")
      .select("*")
      .eq("user_id", user.id)
      .single();

    if (error && error.code !== "PGRST116") {
      // PGRST116 is "not found"
      console.error("Error fetching notification preferences:", error);
      return NextResponse.json(
        { error: "Failed to fetch notification preferences" },
        { status: 500 }
      );
    }

    // If no preferences exist, return defaults
    const defaultPreferences = {
      email_notifications: true,
      push_notifications: true,
      comment_notifications: true,
      reaction_notifications: true,
      follow_notifications: true,
      mention_notifications: true,
      post_published_notifications: true,
      weekly_digest: true,
      marketing_emails: false,
    };

    return NextResponse.json({
      preferences: preferences || defaultPreferences,
    });
  } catch (error) {
    console.error("Error in notification preferences GET:", error);
    return handleRouteError(error);
  }
}

// PUT /api/notifications/preferences - Update user notification preferences
export async function PUT(request: NextRequest) {
  try {
    // Apply rate limiting
    const rateLimitResult = await rateLimitAPI(
      "notification-preferences-update"
    );
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

    const body = await request.json();

    // Validate request body
    const validationResult = notificationPreferencesSchema.safeParse(body);
    if (!validationResult.success) {
      return NextResponse.json(
        {
          error: "Invalid request body",
          details: validationResult.error.errors,
        },
        { status: 400 }
      );
    }

    const preferences = validationResult.data;

    // Check if preferences already exist
    const { data: existingPreferences } = await supabase
      .from("notification_preferences")
      .select("id")
      .eq("user_id", user.id)
      .single();

    let result;
    if (existingPreferences) {
      // Update existing preferences
      result = await supabase
        .from("notification_preferences")
        .update({
          ...preferences,
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", user.id)
        .select()
        .single();
    } else {
      // Create new preferences
      result = await supabase
        .from("notification_preferences")
        .insert({
          user_id: user.id,
          ...preferences,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .select()
        .single();
    }

    const { data: updatedPreferences, error } = result;

    if (error) {
      console.error("Error updating notification preferences:", error);
      return NextResponse.json(
        { error: "Failed to update notification preferences" },
        { status: 500 }
      );
    }

    return NextResponse.json({
      message: "Notification preferences updated successfully",
      preferences: updatedPreferences,
    });
  } catch (error) {
    console.error("Error in notification preferences PUT:", error);
    return handleRouteError(error);
  }
}
