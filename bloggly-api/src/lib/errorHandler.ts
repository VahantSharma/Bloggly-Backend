// src/lib/errorHandler.ts
import { ZodError, ZodIssue } from "zod";
import { captureException, MonitoringContext } from "./monitoring";
import { ApiErrorPayload } from "./types";

export function createErrorResponse(
  message: string,
  status: number,
  details?: string | Record<string, string[] | undefined> | ZodIssue[]
): Response {
  const errorPayload: ApiErrorPayload = { message };
  if (details) {
    errorPayload.details = details;
  }
  return Response.json({ error: errorPayload }, { status });
}

export function handleRouteError(
  err: unknown,
  context?: MonitoringContext
): Response {
  console.error("[API_ROUTE_ERROR]", err);

  // Capture exception with monitoring system
  if (err instanceof Error) {
    captureException(err, context);
  } else {
    // Handle non-Error objects
    const errorObj = new Error(
      typeof err === "string" ? err : "Unknown error occurred"
    );
    captureException(errorObj, context);
  }

  if (err instanceof ZodError) {
    return createErrorResponse(
      "Validation failed.",
      400,
      err.flatten().fieldErrors
    );
  }

  // Check for Supabase AuthError or PostgrestError specifically
  if (
    err &&
    typeof err === "object" &&
    "name" in err &&
    (err.name === "AuthApiError" || err.name === "PostgrestError") &&
    "message" in err &&
    typeof err.message === "string"
  ) {
    const status =
      "status" in err && typeof err.status === "number"
        ? err.status
        : "code" in err &&
            typeof err.code === "string" &&
            !isNaN(parseInt(err.code.substring(0, 3)))
          ? parseInt(err.code.substring(0, 3))
          : 500;

    const details =
      ("details" in err ? err.details : undefined) ||
      ("hint" in err ? err.hint : undefined);
    return createErrorResponse(
      err.message,
      status,
      typeof details === "string" ? details : undefined
    );
  }

  // Check for custom error objects with status
  if (
    err &&
    typeof err === "object" &&
    "status" in err &&
    typeof err.status === "number" &&
    "message" in err &&
    typeof err.message === "string"
  ) {
    const details =
      "details" in err && typeof err.details === "string"
        ? err.details
        : undefined;
    return createErrorResponse(err.message, err.status, details);
  }

  return createErrorResponse("An internal server error occurred.", 500);
}

export function createSuccessResponse<T>(
  data: T,
  status: number = 200
): Response {
  return Response.json({ data }, { status });
}

// Utility function to extract monitoring context from request
export function extractMonitoringContext(
  request: Request,
  userId?: string
): MonitoringContext {
  const url = new URL(request.url);
  return {
    userId,
    endpoint: url.pathname,
    method: request.method,
    userAgent: request.headers.get("user-agent") || undefined,
    ip:
      request.headers.get("x-forwarded-for") ||
      request.headers.get("x-real-ip") ||
      undefined,
  };
}

// Enhanced error handler that can extract context from request
export function handleApiError(
  err: unknown,
  request?: Request,
  userId?: string
): Response {
  const context = request
    ? extractMonitoringContext(request, userId)
    : undefined;
  return handleRouteError(err, context);
}

// Async wrapper for route handlers with automatic error handling
export function withErrorHandling<T extends unknown[]>(
  handler: (...args: T) => Promise<Response>,
  extractUserId?: (request: Request) => Promise<string | undefined>
) {
  return async (...args: T): Promise<Response> => {
    try {
      return await handler(...args);
    } catch (error) {
      const request = args.find((arg) => arg instanceof Request);
      let userId: string | undefined;

      if (request && extractUserId) {
        try {
          userId = await extractUserId(request);
        } catch {
          // Ignore userId extraction errors
        }
      }

      return handleApiError(error, request, userId);
    }
  };
}
