import { validateToken } from "@/lib/authHelpers";
import { handleRouteError } from "@/lib/errorHandler";
import { rateLimitAPI } from "@/lib/rateLimit";
import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// GET /api/notifications - Get user notifications with pagination and filtering
export async function GET(request: NextRequest) {
  try {
    // Apply rate limiting
    const rateLimitResult = await rateLimitAPI("notifications-get");
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
    const page = parseInt(searchParams.get("page") || "1");
    const limit = Math.min(parseInt(searchParams.get("limit") || "20"), 50);
    const type = searchParams.get("type"); // comment, reaction, follow, mention, etc.
    const unreadOnly = searchParams.get("unread") === "true";
    const offset = (page - 1) * limit;

    // Build query
    let query = supabase
      .from("notifications")
      .select(
        `
        id,
        type,
        title,
        message,
        is_read,
        created_at,
        data,
        actor:profiles!notifications_actor_id_fkey(username, display_name, avatar_url)
      `
      )
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (type) {
      query = query.eq("type", type);
    }

    if (unreadOnly) {
      query = query.eq("is_read", false);
    }

    const { data: notifications, error, count } = await query;

    if (error) {
      console.error("Error fetching notifications:", error);
      return NextResponse.json(
        { error: "Failed to fetch notifications" },
        { status: 500 }
      );
    }

    // Get unread count
    const { count: unreadCount } = await supabase
      .from("notifications")
      .select("*", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("is_read", false);

    return NextResponse.json({
      notifications: notifications || [],
      pagination: {
        page,
        limit,
        total: count || 0,
        pages: Math.ceil((count || 0) / limit),
      },
      unread_count: unreadCount || 0,
    });
  } catch (error) {
    console.error("Error in notifications GET:", error);
    return handleRouteError(error);
  }
}

// POST /api/notifications - Mark notifications as read/unread (bulk operation)
export async function POST(request: NextRequest) {
  try {
    // Apply rate limiting
    const rateLimitResult = await rateLimitAPI("notifications-update");
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
    const { notification_ids, action = "mark_read" } = body;

    if (!notification_ids || !Array.isArray(notification_ids)) {
      return NextResponse.json(
        { error: "notification_ids array is required" },
        { status: 400 }
      );
    }

    if (notification_ids.length === 0) {
      return NextResponse.json(
        { error: "At least one notification ID is required" },
        { status: 400 }
      );
    }

    // Validate that all notifications belong to the authenticated user
    const { data: ownedNotifications } = await supabase
      .from("notifications")
      .select("id")
      .in("id", notification_ids)
      .eq("user_id", user.id);

    if (
      !ownedNotifications ||
      ownedNotifications.length !== notification_ids.length
    ) {
      return NextResponse.json(
        { error: "Some notifications not found or not owned by user" },
        { status: 403 }
      );
    }

    // Update notifications
    const updateData: { is_read?: boolean; read_at?: string | null } = {};

    if (action === "mark_read") {
      updateData.is_read = true;
      updateData.read_at = new Date().toISOString();
    } else if (action === "mark_unread") {
      updateData.is_read = false;
      updateData.read_at = null;
    } else {
      return NextResponse.json(
        { error: "Invalid action. Use 'mark_read' or 'mark_unread'" },
        { status: 400 }
      );
    }

    const { data: updatedNotifications, error } = await supabase
      .from("notifications")
      .update(updateData)
      .in("id", notification_ids)
      .eq("user_id", user.id)
      .select();

    if (error) {
      console.error("Error updating notifications:", error);
      return NextResponse.json(
        { error: "Failed to update notifications" },
        { status: 500 }
      );
    }

    return NextResponse.json({
      message: `${notification_ids.length} notification(s) ${action === "mark_read" ? "marked as read" : "marked as unread"}`,
      updated_notifications: updatedNotifications,
    });
  } catch (error) {
    console.error("Error in notifications POST:", error);
    return handleRouteError(error);
  }
}

// DELETE /api/notifications - Delete notifications (bulk operation)
export async function DELETE(request: NextRequest) {
  try {
    // Apply rate limiting
    const rateLimitResult = await rateLimitAPI("notifications-delete");
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
    const notificationIds = searchParams.get("ids")?.split(",");
    const deleteAll = searchParams.get("all") === "true";
    const deleteRead = searchParams.get("read") === "true";

    if (
      !deleteAll &&
      !deleteRead &&
      (!notificationIds || notificationIds.length === 0)
    ) {
      return NextResponse.json(
        { error: "Provide notification IDs, use ?all=true, or ?read=true" },
        { status: 400 }
      );
    }

    let deleteQuery = supabase
      .from("notifications")
      .delete()
      .eq("user_id", user.id);

    if (deleteAll) {
      // Delete all notifications for the user
    } else if (deleteRead) {
      // Delete only read notifications
      deleteQuery = deleteQuery.eq("is_read", true);
    } else if (notificationIds) {
      // Delete specific notifications
      deleteQuery = deleteQuery.in("id", notificationIds);
    }

    const { data: deletedNotifications, error } = await deleteQuery.select();

    if (error) {
      console.error("Error deleting notifications:", error);
      return NextResponse.json(
        { error: "Failed to delete notifications" },
        { status: 500 }
      );
    }

    const deletedCount = deletedNotifications?.length || 0;

    return NextResponse.json({
      message: `${deletedCount} notification(s) deleted successfully`,
      deleted_count: deletedCount,
    });
  } catch (error) {
    console.error("Error in notifications DELETE:", error);
    return handleRouteError(error);
  }
}
