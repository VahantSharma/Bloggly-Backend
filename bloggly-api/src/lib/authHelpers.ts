// src/lib/authHelpers.ts
import { User } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { supabaseAdmin } from "./supabaseAdmin";
import { ApiErrorPayload, Profile } from "./types";

export async function getAuthenticatedUser(
  request: Request
): Promise<{ user: User | null; error: ApiErrorPayload | null }> {
  try {
    const authHeader = request.headers.get("authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return {
        user: null,
        error: { message: "No authorization token provided." },
      };
    }

    const token = authHeader.replace("Bearer ", "");
    const {
      data: { user },
      error: sessionError,
    } = await supabaseAdmin.auth.getUser(token);

    if (sessionError) {
      console.error("Error getting authenticated user:", sessionError.message);
      return { user: null, error: { message: "Invalid or expired token." } };
    }

    if (!user) {
      return { user: null, error: { message: "User not authenticated." } };
    }

    return { user, error: null };
  } catch (error) {
    console.error("Error in getAuthenticatedUser:", error);
    return { user: null, error: { message: "Authentication error occurred." } };
  }
}

export function isPlatformAdmin(user: User | null): boolean {
  if (!user || !process.env.YOUR_PLATFORM_ADMIN_USER_ID) {
    return false;
  }
  return user.id === process.env.YOUR_PLATFORM_ADMIN_USER_ID;
}

export async function getUserProfile(
  userId: string
): Promise<{ profile: Profile | null; error: ApiErrorPayload | null }> {
  try {
    const { data: profile, error } = await supabaseAdmin
      .from("profiles")
      .select("*")
      .eq("id", userId)
      .single();

    if (error) {
      console.error("Error fetching user profile:", error);
      return {
        profile: null,
        error: { message: "Failed to fetch user profile." },
      };
    }

    return { profile, error: null };
  } catch (error) {
    console.error("Error in getUserProfile:", error);
    return {
      profile: null,
      error: { message: "Error occurred while fetching profile." },
    };
  }
}

export async function checkPostAuthorization(
  userId: string,
  postId: number,
  requiredRole: "author" | "editor" | "any" = "any"
): Promise<{ authorized: boolean; error: ApiErrorPayload | null }> {
  try {
    // First check if user is post author
    const { data: post, error: postError } = await supabaseAdmin
      .from("posts")
      .select("id")
      .eq("id", postId)
      .eq("author_id", userId)
      .single();

    if (!postError && post) {
      return { authorized: true, error: null };
    }

    // If not author, check collaborator status
    if (requiredRole !== "author") {
      const { data: collaborator, error: collabError } = await supabaseAdmin
        .from("post_collaborators")
        .select("role, accepted_at")
        .eq("post_id", postId)
        .eq("user_id", userId)
        .not("accepted_at", "is", null) // accepted_at IS NOT NULL
        .single();

      if (!collabError && collaborator) {
        if (requiredRole === "any" || collaborator.role === requiredRole) {
          return { authorized: true, error: null };
        }
      }
    }

    return {
      authorized: false,
      error: { message: "Insufficient permissions for this post." },
    };
  } catch (error) {
    console.error("Error in checkPostAuthorization:", error);
    return {
      authorized: false,
      error: { message: "Authorization check failed." },
    };
  }
}

export async function getAuthenticatedUserWithProfile(
  request: Request
): Promise<{
  user: User | null;
  profile: Profile | null;
  error: ApiErrorPayload | null;
}> {
  try {
    const { user, error: authError } = await getAuthenticatedUser(request);

    if (authError || !user) {
      return { user, profile: null, error: authError };
    }

    const { profile, error: profileError } = await getUserProfile(user.id);

    if (profileError) {
      return { user, profile: null, error: profileError };
    }

    return { user, profile, error: null };
  } catch (error) {
    console.error("Error in getAuthenticatedUserWithProfile:", error);
    return {
      user: null,
      profile: null,
      error: { message: "Authentication error occurred." },
    };
  }
}

export async function validateToken(
  request: NextRequest,
  required: boolean = true
): Promise<User | null> {
  try {
    const authHeader = request.headers.get("authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      if (required) {
        throw new Error("No authorization token provided");
      }
      return null;
    }

    const token = authHeader.replace("Bearer ", "");
    const {
      data: { user },
      error: sessionError,
    } = await supabaseAdmin.auth.getUser(token);

    if (sessionError) {
      console.error("Error validating token:", sessionError.message);
      if (required) {
        throw new Error("Invalid or expired token");
      }
      return null;
    }

    if (!user && required) {
      throw new Error("User not authenticated");
    }

    return user;
  } catch (error) {
    console.error("Error in validateToken:", error);
    if (required) {
      throw error;
    }
    return null;
  }
}
