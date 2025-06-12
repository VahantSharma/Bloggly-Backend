// src/app/api/admin/reports/[id]/route.ts
import { getAuthenticatedUser, isPlatformAdmin } from "@/lib/authHelpers";
import {
  createErrorResponse,
  createSuccessResponse,
  handleRouteError,
} from "@/lib/errorHandler";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { NextRequest } from "next/server";
import { z } from "zod";

const reportIdSchema = z.string().uuid();

const updateReportSchema = z.object({
  status: z.enum(["reviewed", "resolved", "dismissed"]),
  admin_notes: z.string().max(1000).optional(),
  action_taken: z.string().max(500).optional(),
});

const moderationActionSchema = z.object({
  action_type: z.enum([
    "approve_content",
    "delete_content",
    "flag_content",
    "ban_user",
    "warn_user",
    "dismiss_report",
  ]),
  reason: z.string().max(500).optional(),
  duration_days: z.number().int().min(1).max(365).optional(), // For temporary bans
});

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

    const reportId = reportIdSchema.parse(params.id);

    // Get detailed report information
    const { data: report, error: reportError } = await supabaseAdmin
      .from("content_reports")
      .select(
        `
        id,
        report_type,
        reported_content_type,
        reported_content_id,
        reason,
        description,
        severity,
        status,
        created_at,
        updated_at,
        reviewed_at,
        admin_notes,
        action_taken,
        reporter:profiles!reporter_id(
          id, 
          username, 
          display_name, 
          avatar_url, 
          email
        ),
        reviewed_by_admin:profiles!reviewed_by(
          id, 
          username, 
          display_name
        )
      `
      )
      .eq("id", reportId)
      .single();

    if (reportError) {
      if (reportError.code === "PGRST116") {
        return createErrorResponse("Report not found", 404);
      }
      throw reportError;
    }

    // Get detailed content information based on type
    let contentDetails = null;
    let relatedReports: unknown[] = [];

    try {
      if (report.reported_content_type === "post") {
        // Get post details
        const { data: post } = await supabaseAdmin
          .from("posts")
          .select(
            `
            id,
            title,
            slug,
            content_markdown,
            excerpt,
            status,
            view_count,
            created_at,
            updated_at,
            author:profiles(id, username, display_name, avatar_url, email),
            tags:post_tags(tag:tags(name)),
            comments_count:comments(count),
            reactions_count:reactions(count)
          `
          )
          .eq("id", report.reported_content_id)
          .single();

        contentDetails = post;

        // Get other reports for this post
        const { data: otherReports } = await supabaseAdmin
          .from("content_reports")
          .select(
            `
            id,
            reason,
            severity,
            status,
            created_at,
            reporter:profiles!reporter_id(username, display_name)
          `
          )
          .eq("reported_content_id", report.reported_content_id)
          .eq("reported_content_type", "post")
          .neq("id", reportId)
          .order("created_at", { ascending: false })
          .limit(10);

        relatedReports = otherReports || [];
      } else if (report.reported_content_type === "comment") {
        // Get comment details
        const { data: comment } = await supabaseAdmin
          .from("comments")
          .select(
            `
            id,
            content,
            status,
            is_flagged_as_spam,
            created_at,
            updated_at,
            author:profiles(id, username, display_name, avatar_url, email),
            post:posts(id, title, slug, author:profiles(username, display_name)),
            reactions_count:comment_reactions(count),
            replies_count:comments!parent_id(count)
          `
          )
          .eq("id", report.reported_content_id)
          .single();

        contentDetails = comment;

        // Get other reports for this comment
        const { data: otherReports } = await supabaseAdmin
          .from("content_reports")
          .select(
            `
            id,
            reason,
            severity,
            status,
            created_at,
            reporter:profiles!reporter_id(username, display_name)
          `
          )
          .eq("reported_content_id", report.reported_content_id)
          .eq("reported_content_type", "comment")
          .neq("id", reportId)
          .order("created_at", { ascending: false })
          .limit(10);

        relatedReports = otherReports || [];
      } else if (report.reported_content_type === "user") {
        // Get user details
        const { data: reportedUser } = await supabaseAdmin
          .from("profiles")
          .select(
            `
            id,
            username,
            display_name,
            email,
            avatar_url,
            bio,
            created_at,
            updated_at,
            is_email_verified
          `
          )
          .eq("id", report.reported_content_id)
          .single();

        contentDetails = reportedUser;

        // Get user statistics
        if (reportedUser) {
          const [postsCount, commentsCount, followersCount] = await Promise.all(
            [
              supabaseAdmin
                .from("posts")
                .select("id", { count: "exact" })
                .eq("author_id", reportedUser.id),
              supabaseAdmin
                .from("comments")
                .select("id", { count: "exact" })
                .eq("author_id", reportedUser.id),
              supabaseAdmin
                .from("follows")
                .select("id", { count: "exact" })
                .eq("following_id", reportedUser.id),
            ]
          );

          contentDetails = {
            ...reportedUser,
            statistics: {
              posts_count: postsCount.count || 0,
              comments_count: commentsCount.count || 0,
              followers_count: followersCount.count || 0,
            },
          };
        }

        // Get other reports for this user
        const { data: otherReports } = await supabaseAdmin
          .from("content_reports")
          .select(
            `
            id,
            reason,
            severity,
            status,
            created_at,
            reporter:profiles!reporter_id(username, display_name)
          `
          )
          .eq("reported_content_id", report.reported_content_id)
          .eq("reported_content_type", "user")
          .neq("id", reportId)
          .order("created_at", { ascending: false })
          .limit(10);

        relatedReports = otherReports || [];
      }
    } catch (error) {
      console.error(
        `Failed to fetch content details for report ${reportId}:`,
        error
      );
    }

    // Get admin activity history for this report
    const { data: adminActions } = await supabaseAdmin
      .from("admin_activity_logs")
      .select(
        `
        id,
        action_type,
        details,
        created_at,
        admin:profiles!admin_id(username, display_name)
      `
      )
      .eq("target_id", reportId)
      .order("created_at", { ascending: false })
      .limit(10);

    return createSuccessResponse({
      report: {
        ...report,
        content_details: contentDetails,
        related_reports: relatedReports,
        admin_actions: adminActions || [],
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    // Check admin authorization
    const { user } = await getAuthenticatedUser(request);
    if (!user || !isPlatformAdmin(user)) {
      return createErrorResponse("Admin access required", 403);
    }

    const reportId = reportIdSchema.parse(params.id);
    const body = await request.json();
    const { status, admin_notes, action_taken } =
      updateReportSchema.parse(body);

    // Check if report exists
    const { data: existingReport, error: fetchError } = await supabaseAdmin
      .from("content_reports")
      .select("id, status, reported_content_type, reported_content_id")
      .eq("id", reportId)
      .single();

    if (fetchError) {
      if (fetchError.code === "PGRST116") {
        return createErrorResponse("Report not found", 404);
      }
      throw fetchError;
    }

    // Update report
    const { data: updatedReport, error: updateError } = await supabaseAdmin
      .from("content_reports")
      .update({
        status,
        reviewed_by: user.id,
        reviewed_at: new Date().toISOString(),
        admin_notes: admin_notes || null,
        action_taken: action_taken || null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", reportId)
      .select()
      .single();

    if (updateError) {
      throw updateError;
    }

    // Log admin action
    await supabaseAdmin.from("admin_activity_logs").insert({
      admin_id: user.id,
      action_type: "report_updated",
      target_id: reportId,
      details: {
        previous_status: existingReport.status,
        new_status: status,
        admin_notes: admin_notes || null,
        action_taken: action_taken || null,
      },
      created_at: new Date().toISOString(),
    });

    return createSuccessResponse({
      message: "Report updated successfully",
      report: updatedReport,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

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

    const reportId = reportIdSchema.parse(params.id);
    const body = await request.json();
    const { action_type, reason, duration_days } =
      moderationActionSchema.parse(body);

    // Get report details
    const { data: report, error: reportError } = await supabaseAdmin
      .from("content_reports")
      .select("*")
      .eq("id", reportId)
      .single();

    if (reportError) {
      if (reportError.code === "PGRST116") {
        return createErrorResponse("Report not found", 404);
      }
      throw reportError;
    }

    let actionResult: {
      success: boolean;
      message: string;
      data: Record<string, unknown> | null;
    } = { success: false, message: "", data: null };

    // Execute moderation action based on type
    switch (action_type) {
      case "approve_content":
        // Mark content as approved
        if (report.reported_content_type === "post") {
          const { error } = await supabaseAdmin
            .from("posts")
            .update({ status: "published" })
            .eq("id", report.reported_content_id);

          if (!error) {
            actionResult = {
              success: true,
              message: "Post approved",
              data: null,
            };
          }
        } else if (report.reported_content_type === "comment") {
          const { error } = await supabaseAdmin
            .from("comments")
            .update({ status: "published", is_flagged_as_spam: false })
            .eq("id", report.reported_content_id);

          if (!error) {
            actionResult = {
              success: true,
              message: "Comment approved",
              data: null,
            };
          }
        }
        break;

      case "delete_content":
        // Delete or hide content
        if (report.reported_content_type === "post") {
          const { error } = await supabaseAdmin
            .from("posts")
            .update({ status: "deleted" })
            .eq("id", report.reported_content_id);

          if (!error) {
            actionResult = {
              success: true,
              message: "Post deleted",
              data: null,
            };
          }
        } else if (report.reported_content_type === "comment") {
          const { error } = await supabaseAdmin
            .from("comments")
            .update({ status: "deleted" })
            .eq("id", report.reported_content_id);

          if (!error) {
            actionResult = {
              success: true,
              message: "Comment deleted",
              data: null,
            };
          }
        }
        break;

      case "flag_content":
        // Flag content as inappropriate
        if (report.reported_content_type === "post") {
          const { error } = await supabaseAdmin
            .from("posts")
            .update({ status: "flagged" })
            .eq("id", report.reported_content_id);

          if (!error) {
            actionResult = {
              success: true,
              message: "Post flagged",
              data: null,
            };
          }
        } else if (report.reported_content_type === "comment") {
          const { error } = await supabaseAdmin
            .from("comments")
            .update({ status: "flagged", is_flagged_as_spam: true })
            .eq("id", report.reported_content_id);

          if (!error) {
            actionResult = {
              success: true,
              message: "Comment flagged",
              data: null,
            };
          }
        }
        break;

      case "ban_user":
        // Ban the user
        if (
          report.reported_content_type === "user" ||
          report.reported_content_type === "post" ||
          report.reported_content_type === "comment"
        ) {
          let userIdToBan = report.reported_content_id;

          // If reporting content, get the content author
          if (report.reported_content_type === "post") {
            const { data: post } = await supabaseAdmin
              .from("posts")
              .select("author_id")
              .eq("id", report.reported_content_id)
              .single();
            userIdToBan = post?.author_id;
          } else if (report.reported_content_type === "comment") {
            const { data: comment } = await supabaseAdmin
              .from("comments")
              .select("author_id")
              .eq("id", report.reported_content_id)
              .single();
            userIdToBan = comment?.author_id;
          }

          if (userIdToBan) {
            // Check if already banned
            const { data: existingBan } = await supabaseAdmin
              .from("banned_users")
              .select("id")
              .eq("user_id", userIdToBan)
              .single();

            if (!existingBan) {
              const bannedAt = new Date();
              const expiresAt = duration_days
                ? new Date(
                    bannedAt.getTime() + duration_days * 24 * 60 * 60 * 1000
                  )
                : null;

              const { error: banError } = await supabaseAdmin
                .from("banned_users")
                .insert({
                  user_id: userIdToBan,
                  banned_by: user.id,
                  reason: reason || "Content policy violation",
                  banned_at: bannedAt.toISOString(),
                  expires_at: expiresAt?.toISOString() || null,
                });

              if (!banError) {
                actionResult = {
                  success: true,
                  message: `User banned ${duration_days ? "temporarily" : "permanently"}`,
                  data: expiresAt
                    ? { banned_until: expiresAt.toISOString() }
                    : { banned_until: null },
                };
              }
            } else {
              actionResult = {
                success: false,
                message: "User is already banned",
                data: null,
              };
            }
          }
        }
        break;

      case "warn_user":
        // Send warning notification to user
        if (
          report.reported_content_type === "user" ||
          report.reported_content_type === "post" ||
          report.reported_content_type === "comment"
        ) {
          let userIdToWarn = report.reported_content_id;

          // If reporting content, get the content author
          if (report.reported_content_type === "post") {
            const { data: post } = await supabaseAdmin
              .from("posts")
              .select("author_id")
              .eq("id", report.reported_content_id)
              .single();
            userIdToWarn = post?.author_id;
          } else if (report.reported_content_type === "comment") {
            const { data: comment } = await supabaseAdmin
              .from("comments")
              .select("author_id")
              .eq("id", report.reported_content_id)
              .single();
            userIdToWarn = comment?.author_id;
          }

          if (userIdToWarn) {
            const { error: notificationError } = await supabaseAdmin
              .from("notifications")
              .insert({
                user_id: userIdToWarn,
                type: "warning",
                message: `Content warning: ${reason || "Your content has been reported for violating community guidelines"}`,
                created_at: new Date().toISOString(),
              });

            if (!notificationError) {
              actionResult = {
                success: true,
                message: "Warning sent to user",
                data: null,
              };
            }
          }
        }
        break;

      case "dismiss_report":
        // Simply dismiss the report without action
        actionResult = {
          success: true,
          message: "Report dismissed",
          data: null,
        };
        break;

      default:
        return createErrorResponse("Invalid action type", 400);
    }

    if (!actionResult.success) {
      return createErrorResponse(
        actionResult.message || "Failed to execute moderation action",
        500
      );
    }

    // Update report status based on action
    let newStatus = "reviewed";
    if (action_type === "dismiss_report") {
      newStatus = "dismissed";
    } else if (action_type !== "warn_user") {
      newStatus = "resolved";
    }

    await supabaseAdmin
      .from("content_reports")
      .update({
        status: newStatus,
        reviewed_by: user.id,
        reviewed_at: new Date().toISOString(),
        action_taken: actionResult.message,
        updated_at: new Date().toISOString(),
      })
      .eq("id", reportId);

    // Log admin action
    await supabaseAdmin.from("admin_activity_logs").insert({
      admin_id: user.id,
      action_type: "moderation_action",
      target_id: reportId,
      details: {
        action_type,
        reason: reason || null,
        duration_days: duration_days || null,
        result: actionResult.message,
        report_id: reportId,
      },
      created_at: new Date().toISOString(),
    });

    return createSuccessResponse({
      message: actionResult.message,
      action_result: actionResult.data,
      report_status: newStatus,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
