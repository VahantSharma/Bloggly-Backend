// src/app/api/admin/settings/route.ts
import { getAuthenticatedUser, isPlatformAdmin } from "@/lib/authHelpers";
import {
  createErrorResponse,
  createSuccessResponse,
  handleRouteError,
} from "@/lib/errorHandler";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { NextRequest } from "next/server";
import { z } from "zod";

const updateSettingsSchema = z.object({
  setting_key: z.string().min(1).max(100),
  setting_value: z.any(), // Can be string, number, boolean, or object
  description: z.string().max(500).optional(),
});

const bulkUpdateSchema = z.object({
  settings: z.array(
    z.object({
      key: z.string().min(1).max(100),
      value: z.any(),
      description: z.string().max(500).optional(),
    })
  ),
});

export async function GET(request: NextRequest) {
  try {
    // Check admin authorization
    const { user } = await getAuthenticatedUser(request);
    if (!user || !isPlatformAdmin(user)) {
      return createErrorResponse("Admin access required", 403);
    }

    const { searchParams } = new URL(request.url);
    const category = searchParams.get("category");
    const search = searchParams.get("search");

    // Build query
    let query = supabaseAdmin
      .from("platform_settings")
      .select("*")
      .order("category")
      .order("setting_key");

    if (category) {
      query = query.eq("category", category);
    }

    if (search) {
      query = query.or(
        `setting_key.ilike.%${search}%,description.ilike.%${search}%`
      );
    }

    const { data: settings, error: settingsError } = await query;

    if (settingsError) {
      throw settingsError;
    }

    // Group settings by category
    const settingsByCategory = (settings || []).reduce(
      (
        acc: Record<string, unknown[]>,
        setting: { category?: string; [key: string]: unknown }
      ) => {
        const category = setting.category || "general";
        if (!acc[category]) {
          acc[category] = [];
        }
        acc[category].push(setting);
        return acc;
      },
      {}
    );

    // Get setting categories and their descriptions
    const categories = {
      general: "General platform settings",
      security: "Security and authentication settings",
      email: "Email service and template settings",
      moderation: "Content moderation and spam detection",
      features: "Feature flags and experimental settings",
      rate_limiting: "Rate limiting and API throttling",
      notifications: "Notification preferences and delivery",
      storage: "File storage and media settings",
    };

    return createSuccessResponse({
      settings: settingsByCategory,
      categories,
      total_settings: settings?.length || 0,
    });
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

    // Handle bulk update
    if (body.settings && Array.isArray(body.settings)) {
      const { settings } = bulkUpdateSchema.parse(body);

      const updatePromises = settings.map(async (setting) => {
        return supabaseAdmin.from("platform_settings").upsert(
          {
            setting_key: setting.key,
            setting_value: setting.value,
            description: setting.description,
            updated_by: user.id,
            updated_at: new Date().toISOString(),
          },
          {
            onConflict: "setting_key",
          }
        );
      });

      await Promise.all(updatePromises);

      // Log bulk update
      await supabaseAdmin.from("admin_activity_logs").insert({
        admin_id: user.id,
        action_type: "settings_bulk_update",
        target_id: null,
        details: {
          updated_settings: settings.map((s) => ({
            key: s.key,
            value: s.value,
          })),
          setting_count: settings.length,
        },
        created_at: new Date().toISOString(),
      });

      return createSuccessResponse({
        message: `${settings.length} settings updated successfully`,
        updated_count: settings.length,
      });
    }

    // Handle single setting update
    const { setting_key, setting_value, description } =
      updateSettingsSchema.parse(body);

    // Get existing setting for logging
    const { data: existingSetting } = await supabaseAdmin
      .from("platform_settings")
      .select("setting_value")
      .eq("setting_key", setting_key)
      .single();

    // Upsert setting
    const { data: updatedSetting, error: updateError } = await supabaseAdmin
      .from("platform_settings")
      .upsert(
        {
          setting_key,
          setting_value,
          description,
          updated_by: user.id,
          updated_at: new Date().toISOString(),
        },
        {
          onConflict: "setting_key",
        }
      )
      .select()
      .single();

    if (updateError) {
      throw updateError;
    }

    // Log setting change
    await supabaseAdmin.from("admin_activity_logs").insert({
      admin_id: user.id,
      action_type: "setting_updated",
      target_id: null,
      details: {
        setting_key,
        previous_value: existingSetting?.setting_value || null,
        new_value: setting_value,
        description,
      },
      created_at: new Date().toISOString(),
    });

    return createSuccessResponse({
      message: "Setting updated successfully",
      setting: updatedSetting,
    });
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
    const action = body.action;

    switch (action) {
      case "reset_to_defaults":
        // Reset all settings to default values
        const defaultSettings = [
          {
            key: "site_name",
            value: "Bloggly",
            category: "general",
            description: "Platform name",
          },
          {
            key: "max_post_length",
            value: 50000,
            category: "general",
            description: "Maximum post content length",
          },
          {
            key: "max_comment_length",
            value: 2000,
            category: "general",
            description: "Maximum comment length",
          },
          {
            key: "allow_user_registration",
            value: true,
            category: "security",
            description: "Allow new user registrations",
          },
          {
            key: "require_email_verification",
            value: true,
            category: "security",
            description: "Require email verification for new accounts",
          },
          {
            key: "rate_limit_posts",
            value: 10,
            category: "rate_limiting",
            description: "Posts per hour limit",
          },
          {
            key: "rate_limit_comments",
            value: 30,
            category: "rate_limiting",
            description: "Comments per hour limit",
          },
          {
            key: "enable_spam_detection",
            value: true,
            category: "moderation",
            description: "Enable automatic spam detection",
          },
          {
            key: "auto_flag_threshold",
            value: 3,
            category: "moderation",
            description: "Auto-flag content after X reports",
          },
          {
            key: "smtp_enabled",
            value: false,
            category: "email",
            description: "Enable SMTP email delivery",
          },
          {
            key: "file_upload_enabled",
            value: true,
            category: "storage",
            description: "Allow file uploads",
          },
          {
            key: "max_file_size_mb",
            value: 10,
            category: "storage",
            description: "Maximum file size in MB",
          },
        ];

        // Delete existing settings
        await supabaseAdmin
          .from("platform_settings")
          .delete()
          .neq("id", "00000000-0000-0000-0000-000000000000");

        // Insert default settings
        const { error: insertError } = await supabaseAdmin
          .from("platform_settings")
          .insert(
            defaultSettings.map((setting) => ({
              setting_key: setting.key,
              setting_value: setting.value,
              category: setting.category,
              description: setting.description,
              updated_by: user.id,
              updated_at: new Date().toISOString(),
            }))
          );

        if (insertError) {
          throw insertError;
        }

        // Log action
        await supabaseAdmin.from("admin_activity_logs").insert({
          admin_id: user.id,
          action_type: "settings_reset_to_defaults",
          target_id: null,
          details: {
            reset_count: defaultSettings.length,
            default_settings: defaultSettings.map((s) => s.key),
          },
          created_at: new Date().toISOString(),
        });

        return createSuccessResponse({
          message: "Settings reset to defaults successfully",
          reset_count: defaultSettings.length,
        });

      case "export_settings":
        // Export all current settings
        const { data: allSettings } = await supabaseAdmin
          .from("platform_settings")
          .select("*")
          .order("category", { ascending: true })
          .order("setting_key", { ascending: true });

        // Log export
        await supabaseAdmin.from("admin_activity_logs").insert({
          admin_id: user.id,
          action_type: "settings_exported",
          target_id: null,
          details: {
            export_count: allSettings?.length || 0,
            exported_at: new Date().toISOString(),
          },
          created_at: new Date().toISOString(),
        });

        return createSuccessResponse({
          message: "Settings exported successfully",
          settings: allSettings,
          export_timestamp: new Date().toISOString(),
        });

      case "validate_settings":
        // Validate current settings for consistency and correctness
        const { data: settings } = await supabaseAdmin
          .from("platform_settings")
          .select("*");

        const validationErrors: string[] = [];
        const requiredSettings = [
          "site_name",
          "max_post_length",
          "max_comment_length",
          "allow_user_registration",
          "require_email_verification",
          "rate_limit_posts",
          "rate_limit_comments",
        ];

        // Check for missing required settings
        const existingKeys = new Set(settings?.map((s) => s.setting_key) || []);
        requiredSettings.forEach((key) => {
          if (!existingKeys.has(key)) {
            validationErrors.push(`Missing required setting: ${key}`);
          }
        });

        // Validate specific setting values
        settings?.forEach((setting) => {
          switch (setting.setting_key) {
            case "max_post_length":
              if (
                typeof setting.setting_value !== "number" ||
                setting.setting_value < 1000
              ) {
                validationErrors.push(
                  "max_post_length must be a number >= 1000"
                );
              }
              break;
            case "max_comment_length":
              if (
                typeof setting.setting_value !== "number" ||
                setting.setting_value < 100
              ) {
                validationErrors.push(
                  "max_comment_length must be a number >= 100"
                );
              }
              break;
            case "rate_limit_posts":
            case "rate_limit_comments":
              if (
                typeof setting.setting_value !== "number" ||
                setting.setting_value < 1
              ) {
                validationErrors.push(
                  `${setting.setting_key} must be a positive number`
                );
              }
              break;
          }
        });

        return createSuccessResponse({
          message:
            validationErrors.length === 0
              ? "All settings are valid"
              : "Validation errors found",
          is_valid: validationErrors.length === 0,
          validation_errors: validationErrors,
          total_settings: settings?.length || 0,
        });

      default:
        return createErrorResponse("Invalid action", 400);
    }
  } catch (error) {
    return handleRouteError(error);
  }
}
