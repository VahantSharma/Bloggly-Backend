// src/app/api/admin/users/[id]/ban/route.ts
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
const banUserSchema = z.object({
  reason: z
    .string()
    .min(1, "Ban reason is required")
    .max(500, "Reason too long"),
  duration_days: z.number().int().min(1).max(365).optional(), // Optional for permanent ban
});

export async function POST(
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
    const body = await request.json();
    const { reason, duration_days } = banUserSchema.parse(body);

    // Prevent self-ban
    if (userId === user.id) {
      return createErrorResponse("Cannot ban your own account", 400);
    }

    // Check if user exists
    const { data: existingUser, error: userError } = await supabaseAdmin
      .from("profiles")
      .select("id, username, email")
      .eq("id", userId)
      .single();

    if (userError) {
      if (userError.code === "PGRST116") {
        return createErrorResponse("User not found", 404);
      }
      throw userError;
    }

    // Check if already banned
    const { data: existingBan } = await supabaseAdmin
      .from("banned_users")
      .select("id")
      .eq("user_id", userId)
      .single();

    if (existingBan) {
      return createErrorResponse("User is already banned", 409);
    }

    // Calculate ban expiry
    const bannedAt = new Date();
    const expiresAt = duration_days
      ? new Date(bannedAt.getTime() + duration_days * 24 * 60 * 60 * 1000)
      : null; // null means permanent ban

    // Insert ban record
    const { error: banError } = await supabaseAdmin
      .from("banned_users")
      .insert({
        user_id: userId,
        banned_by: user.id,
        reason,
        banned_at: bannedAt.toISOString(),
        expires_at: expiresAt?.toISOString() || null,
      });

    if (banError) {
      throw banError;
    }

    // Revoke all user sessions
    try {
      // This would require getting all user sessions and revoking them
      // For now, we'll just note it in the logs
      console.log(`Banned user ${userId} - sessions should be revoked`);
    } catch (sessionError) {
      console.error("Failed to revoke user sessions:", sessionError);
    }

    // Log admin action
    await supabaseAdmin.from("admin_activity_logs").insert({
      admin_id: user.id,
      action_type: "user_banned",
      target_id: userId,
      details: {
        banned_username: existingUser.username,
        reason,
        duration_days,
        ban_type: duration_days ? "temporary" : "permanent",
      },
      created_at: new Date().toISOString(),
    });

    return createSuccessResponse({
      message: `User ${existingUser.username} has been ${duration_days ? "temporarily" : "permanently"} banned`,
      ban_details: {
        banned_at: bannedAt.toISOString(),
        expires_at: expiresAt?.toISOString() || null,
        reason,
        banned_by: user.id,
      },
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

    // Check if user exists and is banned
    const { error: banError } = await supabaseAdmin
      .from("banned_users")
      .select("id, user_id")
      .eq("user_id", userId)
      .single();

    if (banError) {
      if (banError.code === "PGRST116") {
        return createErrorResponse("User is not banned", 404);
      }
      throw banError;
    }

    // Get user info for logging
    const { data: userProfile } = await supabaseAdmin
      .from("profiles")
      .select("username")
      .eq("id", userId)
      .single();

    // Remove ban
    const { error: unbanError } = await supabaseAdmin
      .from("banned_users")
      .delete()
      .eq("user_id", userId);

    if (unbanError) {
      throw unbanError;
    }

    // Log admin action
    await supabaseAdmin.from("admin_activity_logs").insert({
      admin_id: user.id,
      action_type: "user_unbanned",
      target_id: userId,
      details: {
        unbanned_username: userProfile?.username || "unknown",
        unban_method: "admin_panel",
      },
      created_at: new Date().toISOString(),
    });

    return createSuccessResponse({
      message: `User ${userProfile?.username || userId} has been unbanned`,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
