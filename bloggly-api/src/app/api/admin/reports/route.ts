// src/app/api/admin/reports/route.ts
import { getAuthenticatedUser, isPlatformAdmin } from "@/lib/authHelpers";
import {
  createErrorResponse,
  createSuccessResponse,
  handleRouteError,
} from "@/lib/errorHandler";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { NextRequest } from "next/server";
import { z } from "zod";

const getReportsSchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  type: z.enum(["all", "post", "comment", "user"]).optional().default("all"),
  status: z
    .enum(["all", "pending", "reviewed", "resolved", "dismissed"])
    .optional()
    .default("all"),
  severity: z.enum(["all", "low", "medium", "high"]).optional().default("all"),
  sort: z
    .enum(["newest", "oldest", "severity", "status"])
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
    const queryParams = getReportsSchema.parse(
      Object.fromEntries(searchParams.entries())
    );

    const offset = (queryParams.page - 1) * queryParams.limit;

    // Build base query for content reports
    let query = supabaseAdmin.from("content_reports").select(
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
        reporter:profiles!reporter_id(id, username, display_name),
        reviewed_by_admin:profiles!reviewed_by(id, username, display_name),
        admin_notes,
        action_taken
      `,
      { count: "exact" }
    );

    // Apply filters
    if (queryParams.type !== "all") {
      query = query.eq("reported_content_type", queryParams.type);
    }

    if (queryParams.status !== "all") {
      query = query.eq("status", queryParams.status);
    }

    if (queryParams.severity !== "all") {
      query = query.eq("severity", queryParams.severity);
    }

    // Apply sorting
    switch (queryParams.sort) {
      case "oldest":
        query = query.order("created_at", { ascending: true });
        break;
      case "severity":
        query = query.order("severity", { ascending: false });
        break;
      case "status":
        query = query.order("status", { ascending: true });
        break;
      default:
        query = query.order("created_at", { ascending: false });
        break;
    }

    // Apply pagination
    query = query.range(offset, offset + queryParams.limit - 1);

    const { data: reports, error: reportsError, count } = await query;

    if (reportsError) {
      throw reportsError;
    }

    // Get related content details for each report
    const enrichedReports = await Promise.all(
      (reports || []).map(async (report: Record<string, unknown>) => {
        let contentDetails = null;

        try {
          if (report.reported_content_type === "post") {
            const { data: post } = await supabaseAdmin
              .from("posts")
              .select(
                "id, title, slug, status, author:profiles(username, display_name)"
              )
              .eq("id", report.reported_content_id)
              .single();
            contentDetails = post;
          } else if (report.reported_content_type === "comment") {
            const { data: comment } = await supabaseAdmin
              .from("comments")
              .select(
                `
                id, 
                content, 
                status,
                author:profiles(username, display_name),
                post:posts(id, title, slug)
              `
              )
              .eq("id", report.reported_content_id)
              .single();
            contentDetails = comment;
          } else if (report.reported_content_type === "user") {
            const { data: user } = await supabaseAdmin
              .from("profiles")
              .select("id, username, display_name, email")
              .eq("id", report.reported_content_id)
              .single();
            contentDetails = user;
          }
        } catch (error) {
          console.error(
            `Failed to fetch content details for report ${report.id}:`,
            error
          );
        }

        return {
          ...report,
          content_details: contentDetails,
        };
      })
    );

    return createSuccessResponse({
      reports: enrichedReports,
      pagination: {
        page: queryParams.page,
        limit: queryParams.limit,
        total: count || 0,
        pages: Math.ceil((count || 0) / queryParams.limit),
      },
      filters: {
        type: queryParams.type,
        status: queryParams.status,
        severity: queryParams.severity,
        sort: queryParams.sort,
      },
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
    const { report_ids, status, admin_notes, action_taken } = z
      .object({
        report_ids: z.array(z.string().uuid()),
        status: z.enum(["reviewed", "resolved", "dismissed"]),
        admin_notes: z.string().max(1000).optional(),
        action_taken: z.string().max(500).optional(),
      })
      .parse(body);

    // Update multiple reports
    const { data: updatedReports, error: updateError } = await supabaseAdmin
      .from("content_reports")
      .update({
        status,
        reviewed_by: user.id,
        reviewed_at: new Date().toISOString(),
        admin_notes: admin_notes || null,
        action_taken: action_taken || null,
        updated_at: new Date().toISOString(),
      })
      .in("id", report_ids)
      .select();

    if (updateError) {
      throw updateError;
    }

    // Log admin action
    await supabaseAdmin.from("admin_activity_logs").insert({
      admin_id: user.id,
      action_type: "reports_updated",
      target_id: null,
      details: {
        report_ids,
        new_status: status,
        action_taken,
        report_count: report_ids.length,
      },
      created_at: new Date().toISOString(),
    });

    return createSuccessResponse({
      message: `${report_ids.length} report(s) updated successfully`,
      updated_reports: updatedReports,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
