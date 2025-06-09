// src/lib/monitoring.ts
import * as Sentry from "@sentry/nextjs";

// Initialize Sentry if DSN is provided
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || "development",
    tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,
    beforeSend(event) {
      // Filter out sensitive information
      if (event.request?.data) {
        const data = event.request.data;
        // Remove password fields
        if (typeof data === "object" && data !== null) {
          const dataObj = data as Record<string, unknown>;
          delete dataObj.password;
          delete dataObj.new_password;
          delete dataObj.current_password;
        }
      }
      return event;
    },
  });
}

export interface MonitoringContext {
  userId?: string;
  username?: string;
  email?: string;
  endpoint?: string;
  method?: string;
  userAgent?: string;
  ip?: string;
}

export function captureException(error: Error, context?: MonitoringContext) {
  if (process.env.SENTRY_DSN) {
    Sentry.withScope((scope) => {
      if (context) {
        scope.setUser({
          id: context.userId,
          username: context.username,
          email: context.email,
        });

        scope.setTags({
          endpoint: context.endpoint,
          method: context.method,
        });

        scope.setContext("request", {
          user_agent: context.userAgent,
          ip_address: context.ip,
        });
      }

      Sentry.captureException(error);
    });
  } else {
    // Fallback to console logging in development
    console.error("Error captured:", error);
    if (context) {
      console.error("Context:", context);
    }
  }
}

export function captureMessage(
  message: string,
  level: "info" | "warning" | "error" = "info",
  context?: MonitoringContext
) {
  if (process.env.SENTRY_DSN) {
    Sentry.withScope((scope) => {
      if (context) {
        scope.setUser({
          id: context.userId,
          username: context.username,
          email: context.email,
        });

        scope.setTags({
          endpoint: context.endpoint,
          method: context.method,
        });
      }

      Sentry.captureMessage(message, level);
    });
  } else {
    console.log(`[${level.toUpperCase()}] ${message}`);
    if (context) {
      console.log("Context:", context);
    }
  }
}

export function setUserContext(user: {
  id: string;
  username?: string;
  email?: string;
}) {
  if (process.env.SENTRY_DSN) {
    Sentry.setUser({
      id: user.id,
      username: user.username,
      email: user.email,
    });
  }
}

export function clearUserContext() {
  if (process.env.SENTRY_DSN) {
    Sentry.setUser(null);
  }
}

export function addBreadcrumb(message: string, data?: Record<string, unknown>) {
  if (process.env.SENTRY_DSN) {
    Sentry.addBreadcrumb({
      message,
      data,
      timestamp: Date.now() / 1000,
    });
  }
}

export function measurePerformance<T>(
  operation: string,
  fn: () => Promise<T>
): Promise<T> {
  return Sentry.withScope(async () => {
    const startTime = Date.now();
    try {
      const result = await fn();
      const duration = Date.now() - startTime;

      // Log slow operations
      if (duration > 1000) {
        captureMessage(
          `Slow operation: ${operation} took ${duration}ms`,
          "warning"
        );
      }

      return result;
    } catch (error) {
      captureException(error as Error, {
        endpoint: operation,
      });
      throw error;
    }
  });
}
