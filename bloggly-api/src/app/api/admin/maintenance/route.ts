// src/app/api/admin/maintenance/route.ts
import { getAuthenticatedUser, isPlatformAdmin } from "@/lib/authHelpers";
import {
  createErrorResponse,
  createSuccessResponse,
  handleRouteError,
} from "@/lib/errorHandler";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { NextRequest } from "next/server";
import { z } from "zod";

const maintenanceSchema = z.object({
  is_enabled: z.boolean(),
  message: z.string().max(1000).optional(),
  estimated_duration: z.string().max(100).optional(), // e.g., "2 hours", "30 minutes"
  start_time: z.string().datetime().optional(),
  end_time: z.string().datetime().optional(),
  allowed_ips: z.array(z.string().ip()).max(10).optional(), // IPs that can access during maintenance
});

const announcementSchema = z.object({
  title: z.string().min(1).max(200),
  message: z.string().min(1).max(2000),
  type: z
    .enum(["info", "warning", "success", "error"])
    .optional()
    .default("info"),
  is_active: z.boolean().optional().default(true),
  priority: z.enum(["low", "medium", "high"]).optional().default("medium"),
  expires_at: z.string().datetime().optional(),
  target_audience: z.enum(["all", "users", "admins"]).optional().default("all"),
});

export async function GET(request: NextRequest) {
  try {
    // Check admin authorization
    const { user } = await getAuthenticatedUser(request);
    if (!user || !isPlatformAdmin(user)) {
      return createErrorResponse("Admin access required", 403);
    }

    const { searchParams } = new URL(request.url);
    const type = searchParams.get("type") || "all"; // "maintenance", "announcements", or "all"

    const response: Record<string, unknown> = {};

    if (type === "maintenance" || type === "all") {
      // Get current maintenance status
      const { data: maintenanceSettings } = await supabaseAdmin
        .from("platform_settings")
        .select("setting_key, setting_value")
        .in("setting_key", [
          "maintenance_mode_enabled",
          "maintenance_message",
          "maintenance_start_time",
          "maintenance_end_time",
          "maintenance_estimated_duration",
          "maintenance_allowed_ips",
        ]);

      const maintenanceData = (maintenanceSettings || []).reduce(
        (
          acc: Record<string, unknown>,
          setting: { setting_key: string; setting_value: unknown }
        ) => {
          const key = setting.setting_key.replace("maintenance_", "");
          acc[key] = setting.setting_value;
          return acc;
        },
        {}
      );

      response.maintenance = {
        is_enabled: maintenanceData.mode_enabled || false,
        message:
          maintenanceData.message ||
          "The platform is currently undergoing maintenance. Please check back soon.",
        estimated_duration: maintenanceData.estimated_duration || null,
        start_time: maintenanceData.start_time || null,
        end_time: maintenanceData.end_time || null,
        allowed_ips: maintenanceData.allowed_ips || [],
      };
    }

    if (type === "announcements" || type === "all") {
      // Get active announcements
      const { data: announcements } = await supabaseAdmin
        .from("platform_announcements")
        .select(
          `
          id,
          title,
          message,
          type,
          is_active,
          priority,
          expires_at,
          target_audience,
          created_at,
          updated_at,
          created_by:profiles(username, display_name)
        `
        )
        .order("priority", { ascending: false })
        .order("created_at", { ascending: false });

      response.announcements = announcements || [];
    }

    // Get system status information
    if (type === "all") {
      const [
        { data: activeUsers },
        { data: systemHealth },
        { data: recentErrors },
      ] = await Promise.all([
        // Count active users (logged in within last 24 hours)
        supabaseAdmin
          .from("user_activity_logs")
          .select("user_id", { count: "exact" })
          .gte(
            "created_at",
            new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
          )
          .order("created_at", { ascending: false }),

        // Get basic system health metrics
        supabaseAdmin
          .from("posts")
          .select("id", { count: "exact" })
          .gte(
            "created_at",
            new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
          ),

        // Get recent error logs
        supabaseAdmin
          .from("error_logs")
          .select("id, error_type, created_at")
          .gte(
            "created_at",
            new Date(Date.now() - 60 * 60 * 1000).toISOString()
          ) // Last hour
          .order("created_at", { ascending: false })
          .limit(10),
      ]);

      response.system_status = {
        active_users_24h: activeUsers?.length || 0,
        posts_created_24h: systemHealth?.length || 0,
        recent_errors: recentErrors?.length || 0,
        last_updated: new Date().toISOString(),
      };
    }

    return createSuccessResponse(response);
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    // Check admin authorization
    const { user } = await getAuthenticatedUser(request);
    if (!user || !isPlatformAdmin(user)) {
      return createErrorResponse("Admin access required", 403);
    }

    const body = await request.json();
    const action = body.action;

    if (action === "maintenance") {
      const maintenanceData = maintenanceSchema.parse(body.data);

      // Update maintenance settings
      const settingsToUpdate = [
        { key: "maintenance_mode_enabled", value: maintenanceData.is_enabled },
        {
          key: "maintenance_message",
          value:
            maintenanceData.message ||
            "The platform is currently undergoing maintenance.",
        },
        {
          key: "maintenance_estimated_duration",
          value: maintenanceData.estimated_duration || null,
        },
        {
          key: "maintenance_start_time",
          value: maintenanceData.start_time || null,
        },
        {
          key: "maintenance_end_time",
          value: maintenanceData.end_time || null,
        },
        {
          key: "maintenance_allowed_ips",
          value: maintenanceData.allowed_ips || [],
        },
      ];

      for (const setting of settingsToUpdate) {
        await supabaseAdmin.from("platform_settings").upsert(
          {
            setting_key: setting.key,
            setting_value: setting.value,
            updated_by: user.id,
            updated_at: new Date().toISOString(),
          },
          {
            onConflict: "setting_key",
          }
        );
      }

      // Log maintenance mode change
      await supabaseAdmin.from("admin_activity_logs").insert({
        admin_id: user.id,
        action_type: maintenanceData.is_enabled
          ? "maintenance_mode_enabled"
          : "maintenance_mode_disabled",
        target_id: null,
        details: {
          maintenance_settings: maintenanceData,
          action_timestamp: new Date().toISOString(),
        },
        created_at: new Date().toISOString(),
      });

      // Send notifications to all admins about maintenance mode change
      const { data: admins } = await supabaseAdmin
        .from("profiles")
        .select("id")
        .eq("role", "admin")
        .neq("id", user.id); // Exclude the current user

      if (admins && admins.length > 0) {
        const adminNotifications = admins.map((admin) => ({
          user_id: admin.id,
          type: "admin_alert",
          message: maintenanceData.is_enabled
            ? `Maintenance mode has been enabled${maintenanceData.estimated_duration ? ` for ${maintenanceData.estimated_duration}` : ""}`
            : "Maintenance mode has been disabled",
          created_at: new Date().toISOString(),
        }));

        await supabaseAdmin.from("notifications").insert(adminNotifications);
      }

      return createSuccessResponse({
        message: `Maintenance mode ${maintenanceData.is_enabled ? "enabled" : "disabled"} successfully`,
        maintenance: maintenanceData,
      });
    }

    return createErrorResponse("Invalid action", 400);
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    // Check admin authorization
    const { user } = await getAuthenticatedUser(request);
    if (!user || !isPlatformAdmin(user)) {
      return createErrorResponse("Admin access required", 403);
    }

    const body = await request.json();
    const announcementData = announcementSchema.parse(body);

    // Create announcement
    const { data: announcement, error: createError } = await supabaseAdmin
      .from("platform_announcements")
      .insert({
        title: announcementData.title,
        message: announcementData.message,
        type: announcementData.type,
        is_active: announcementData.is_active,
        priority: announcementData.priority,
        expires_at: announcementData.expires_at || null,
        target_audience: announcementData.target_audience,
        created_by: user.id,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select(
        `
        *,
        created_by:profiles(username, display_name)
      `
      )
      .single();

    if (createError) {
      throw createError;
    }

    // Log announcement creation
    await supabaseAdmin.from("admin_activity_logs").insert({
      admin_id: user.id,
      action_type: "announcement_created",
      target_id: announcement.id,
      details: {
        announcement_title: announcementData.title,
        announcement_type: announcementData.type,
        priority: announcementData.priority,
        target_audience: announcementData.target_audience,
      },
      created_at: new Date().toISOString(),
    });

    // Send notifications based on target audience and priority
    if (announcementData.priority === "high") {
      // For high priority announcements, notify relevant users
      let userQuery = supabaseAdmin.from("profiles").select("id");

      if (announcementData.target_audience === "admins") {
        userQuery = userQuery.eq("role", "admin");
      } else if (announcementData.target_audience === "users") {
        userQuery = userQuery.neq("role", "admin");
      }
      // For "all", no additional filtering needed

      const { data: targetUsers } = await userQuery.limit(1000); // Limit to prevent overwhelming the system

      if (targetUsers && targetUsers.length > 0) {
        const notifications = targetUsers.map((targetUser) => ({
          user_id: targetUser.id,
          type: "announcement",
          message: `Important announcement: ${announcementData.title}`,
          metadata: {
            announcement_id: announcement.id,
            announcement_type: announcementData.type,
            priority: announcementData.priority,
          },
          created_at: new Date().toISOString(),
        }));

        // Insert notifications in batches to avoid overwhelming the database
        const batchSize = 100;
        for (let i = 0; i < notifications.length; i += batchSize) {
          const batch = notifications.slice(i, i + batchSize);
          await supabaseAdmin.from("notifications").insert(batch);
        }
      }
    }

    return createSuccessResponse(
      {
        message: "Announcement created successfully",
        announcement,
      },
      201
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
