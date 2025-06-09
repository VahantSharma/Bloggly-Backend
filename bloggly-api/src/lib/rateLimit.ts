// src/lib/rateLimit.ts
import { supabaseAdmin } from "./supabaseAdmin";

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetTime: number; // seconds until reset
}

// Rate limit configuration interface (used by rateLimitConfigs)
interface RateLimitConfig {
  windowMs: number; // window size in milliseconds
  maxAttempts: number; // max attempts per window
  blockDurationMs: number; // how long to block after limit exceeded
}

const rateLimitConfigs: Record<string, RateLimitConfig> = {
  auth: {
    windowMs: 15 * 60 * 1000, // 15 minutes
    maxAttempts: 5, // 5 attempts per 15 minutes
    blockDurationMs: 60 * 60 * 1000, // 1 hour block
  },
  password_reset: {
    windowMs: 60 * 60 * 1000, // 1 hour
    maxAttempts: 3, // 3 attempts per hour
    blockDurationMs: 24 * 60 * 60 * 1000, // 24 hour block
  },
  api_general: {
    windowMs: 60 * 1000, // 1 minute
    maxAttempts: 100, // 100 requests per minute
    blockDurationMs: 5 * 60 * 1000, // 5 minute block
  },
};

export async function rateLimitAuth(
  identifier: string,
  success: boolean = true,
  type: keyof typeof rateLimitConfigs = "auth"
): Promise<RateLimitResult> {
  return rateLimit(identifier, success, type);
}

export async function rateLimitAPI(
  identifier: string,
  success: boolean = true
): Promise<RateLimitResult> {
  return rateLimit(identifier, success, "api_general");
}

async function rateLimit(
  identifier: string,
  success: boolean = true,
  type: keyof typeof rateLimitConfigs = "auth"
): Promise<RateLimitResult> {
  const config = rateLimitConfigs[type];
  const now = new Date();
  const windowStart = new Date(now.getTime() - config.windowMs);
  const key = `${type}_${identifier}`;

  try {
    // Clean up old entries
    await supabaseAdmin
      .from("rate_limit_logs")
      .delete()
      .lt(
        "created_at",
        new Date(now.getTime() - config.blockDurationMs).toISOString()
      );

    // Check if currently blocked
    const { data: blockEntry } = await supabaseAdmin
      .from("rate_limit_logs")
      .select("*")
      .eq("identifier", key)
      .eq("blocked", true)
      .gte(
        "created_at",
        new Date(now.getTime() - config.blockDurationMs).toISOString()
      )
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (blockEntry) {
      const resetTime = Math.ceil(
        (new Date(blockEntry.created_at).getTime() +
          config.blockDurationMs -
          now.getTime()) /
          1000
      );
      return {
        allowed: false,
        remaining: 0,
        resetTime: Math.max(resetTime, 0),
      };
    }

    // Count recent attempts
    const { count } = await supabaseAdmin
      .from("rate_limit_logs")
      .select("*", { count: "exact" })
      .eq("identifier", key)
      .eq("blocked", false)
      .gte("created_at", windowStart.toISOString());

    const currentCount = count || 0;

    // Record this attempt
    if (!success) {
      await supabaseAdmin.from("rate_limit_logs").insert({
        identifier: key,
        attempt_count: currentCount + 1,
        blocked: false,
        created_at: now.toISOString(),
      });
    }

    // Check if limit exceeded
    if (!success && currentCount + 1 >= config.maxAttempts) {
      // Block the identifier
      await supabaseAdmin.from("rate_limit_logs").insert({
        identifier: key,
        attempt_count: currentCount + 1,
        blocked: true,
        created_at: now.toISOString(),
      });

      return {
        allowed: false,
        remaining: 0,
        resetTime: Math.ceil(config.blockDurationMs / 1000),
      };
    }

    // Allow the request
    if (success) {
      // Reset counter on successful attempt
      await supabaseAdmin
        .from("rate_limit_logs")
        .delete()
        .eq("identifier", key)
        .eq("blocked", false);
    }

    return {
      allowed: true,
      remaining: Math.max(
        0,
        config.maxAttempts - (currentCount + (success ? 0 : 1))
      ),
      resetTime: Math.ceil(config.windowMs / 1000),
    };
  } catch (error) {
    console.error("Rate limiting error:", error);
    // Allow request if rate limiting fails to avoid blocking legitimate users
    return {
      allowed: true,
      remaining: config.maxAttempts,
      resetTime: Math.ceil(config.windowMs / 1000),
    };
  }
}

// Middleware helper for rate limiting
export function createRateLimitMiddleware(
  type: keyof typeof rateLimitConfigs = "api_general"
) {
  return async (identifier: string): Promise<RateLimitResult> => {
    return rateLimit(identifier, true, type);
  };
}
