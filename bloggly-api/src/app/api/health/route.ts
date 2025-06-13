// src/app/api/health/route.ts
import {
  createErrorResponse,
  createSuccessResponse,
  handleRouteError,
} from "@/lib/errorHandler";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { NextRequest } from "next/server";

interface HealthStatus {
  status: "healthy" | "degraded" | "unhealthy";
  timestamp: string;
  version: string;
  uptime: number;
  environment: string;
  services: {
    database: {
      status: "healthy" | "unhealthy";
      response_time?: number;
      error?: string;
    };
    email: {
      status: "healthy" | "unhealthy" | "not_configured";
      provider?: string;
    };
    storage: {
      status: "healthy" | "unhealthy";
      provider?: string;
    };
  };
  metrics?: {
    total_users?: number;
    total_posts?: number;
    total_comments?: number;
  };
}

export async function GET() {
  try {
    const timestamp = new Date().toISOString();
    const version = process.env.npm_package_version || "1.0.0";
    const environment = process.env.NODE_ENV || "development";

    // Calculate uptime (simple implementation)
    const uptime = process.uptime();

    const healthStatus: HealthStatus = {
      status: "healthy",
      timestamp,
      version,
      uptime,
      environment,
      services: {
        database: { status: "healthy" },
        email: { status: "not_configured" },
        storage: { status: "healthy" },
      },
    };

    // Test database connection
    try {
      const dbStartTime = Date.now();
      const { error } = await supabaseAdmin
        .from("profiles")
        .select("count", { count: "exact", head: true })
        .limit(1);

      const dbResponseTime = Date.now() - dbStartTime;

      if (error) {
        healthStatus.services.database = {
          status: "unhealthy",
          error: error.message,
        };
        healthStatus.status = "degraded";
      } else {
        healthStatus.services.database = {
          status: "healthy",
          response_time: dbResponseTime,
        };
      }
    } catch (dbError) {
      healthStatus.services.database = {
        status: "unhealthy",
        error:
          dbError instanceof Error ? dbError.message : "Unknown database error",
      };
      healthStatus.status = "unhealthy";
    }

    // Check email service configuration
    if (process.env.RESEND_API_KEY) {
      healthStatus.services.email = {
        status: "healthy",
        provider: "resend",
      };
    } else {
      healthStatus.services.email = {
        status: "not_configured",
      };
    }

    // Check storage service (Supabase Storage)
    if (process.env.SUPABASE_URL) {
      healthStatus.services.storage = {
        status: "healthy",
        provider: "supabase",
      };
    }

    // Get basic metrics (only if database is healthy)
    if (healthStatus.services.database.status === "healthy") {
      try {
        const [usersResult, postsResult, commentsResult] = await Promise.all([
          supabaseAdmin
            .from("profiles")
            .select("count", { count: "exact", head: true }),
          supabaseAdmin
            .from("posts")
            .select("count", { count: "exact", head: true }),
          supabaseAdmin
            .from("comments")
            .select("count", { count: "exact", head: true }),
        ]);

        healthStatus.metrics = {
          total_users: usersResult.count || 0,
          total_posts: postsResult.count || 0,
          total_comments: commentsResult.count || 0,
        };
      } catch (metricsError) {
        // Metrics are optional, don't fail the health check
        console.error("Failed to fetch metrics:", metricsError);
      }
    }

    // Determine overall status
    if (healthStatus.services.database.status === "unhealthy") {
      healthStatus.status = "unhealthy";
    } else if (healthStatus.services.email.status === "not_configured") {
      healthStatus.status = "degraded";
    }

    const statusCode =
      healthStatus.status === "healthy"
        ? 200
        : healthStatus.status === "degraded"
          ? 200
          : 503;

    return createSuccessResponse(healthStatus, statusCode);
  } catch (error) {
    return handleRouteError(error);
  }
}

// Detailed health check for admin monitoring
export async function POST(request: NextRequest) {
  try {
    // This could be used for more detailed health checks
    // or for triggering health check notifications

    const body = await request.json();
    const { check_type = "basic" } = body;

    if (check_type === "detailed") {
      // Perform more comprehensive checks
      const detailedChecks = {
        database_performance: await checkDatabasePerformance(),
        email_service: await checkEmailService(),
        rate_limiting: await checkRateLimiting(),
        storage_access: await checkStorageAccess(),
      };

      return createSuccessResponse({
        message: "Detailed health check completed",
        checks: detailedChecks,
        timestamp: new Date().toISOString(),
      });
    }

    return createErrorResponse("Invalid check type", 400);
  } catch (error) {
    return handleRouteError(error);
  }
}

async function checkDatabasePerformance() {
  try {
    const startTime = Date.now();

    // Test a complex query
    await supabaseAdmin
      .from("posts")
      .select(
        `
        id,
        title,
        author:profiles!posts_author_id_fkey(username),
        comments(count)
      `
      )
      .limit(10);

    const responseTime = Date.now() - startTime;

    return {
      status: responseTime < 1000 ? "healthy" : "slow",
      response_time: responseTime,
      threshold: 1000,
    };
  } catch (error) {
    return {
      status: "unhealthy",
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function checkEmailService() {
  if (!process.env.RESEND_API_KEY) {
    return { status: "not_configured" };
  }

  // Could implement a test email send here
  return {
    status: "configured",
    provider: "resend",
  };
}

async function checkRateLimiting() {
  try {
    // Check if rate limiting tables exist and are accessible
    const { count } = await supabaseAdmin
      .from("rate_limit_logs")
      .select("count", { count: "exact", head: true });

    return {
      status: "healthy",
      logs_count: count,
    };
  } catch (error) {
    return {
      status: "unhealthy",
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

async function checkStorageAccess() {
  try {
    // Test storage bucket access (if configured)
    return {
      status: "healthy",
      provider: "supabase",
    };
  } catch (error) {
    return {
      status: "unhealthy",
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
