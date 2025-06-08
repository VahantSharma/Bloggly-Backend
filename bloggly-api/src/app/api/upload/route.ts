// src/app/api/upload/route.ts
import { getAuthenticatedUser } from "@/lib/authHelpers";
import {
  createErrorResponse,
  createSuccessResponse,
  handleRouteError,
} from "@/lib/errorHandler";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { NextRequest } from "next/server";

const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

export async function POST(request: NextRequest) {
  try {
    const { user } = await getAuthenticatedUser(request);
    if (!user) {
      return createErrorResponse("Authentication required.", 401);
    }

    const formData = await request.formData();
    const file = formData.get("file") as File;
    const context = formData.get("context") as string; // 'post', 'avatar', 'general'

    if (!file) {
      return createErrorResponse("No file provided.", 400);
    }

    // Validate file type
    if (!ALLOWED_TYPES.includes(file.type)) {
      return createErrorResponse(
        "Invalid file type. Only JPEG, PNG, WebP, and GIF are allowed.",
        400
      );
    }

    // Validate file size
    if (file.size > MAX_FILE_SIZE) {
      return createErrorResponse(
        "File size too large. Maximum size is 5MB.",
        400
      );
    }

    // Generate unique filename
    const timestamp = Date.now();
    const randomString = Math.random().toString(36).substring(2, 15);
    const fileExtension = file.name.split(".").pop()?.toLowerCase() || "jpg";
    const fileName = `${context || "general"}/${user.id}/${timestamp}-${randomString}.${fileExtension}`;

    // Convert file to buffer
    const fileBuffer = await file.arrayBuffer();
    const buffer = new Uint8Array(fileBuffer);

    // Upload to Supabase Storage
    const { error: uploadError } = await supabaseAdmin.storage
      .from("uploads")
      .upload(fileName, buffer, {
        contentType: file.type,
        cacheControl: "3600",
        upsert: false,
      });

    if (uploadError) {
      console.error("Upload error:", uploadError);
      throw uploadError;
    }

    // Get public URL
    const {
      data: { publicUrl },
    } = supabaseAdmin.storage.from("uploads").getPublicUrl(fileName);

    // Store upload record in database
    const { data: uploadRecord, error: recordError } = await supabaseAdmin
      .from("uploads")
      .insert({
        user_id: user.id,
        filename: fileName,
        original_name: file.name,
        file_type: file.type,
        file_size: file.size,
        public_url: publicUrl,
        context: context || "general",
        created_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (recordError) {
      console.error("Record error:", recordError);
      // Try to cleanup uploaded file
      await supabaseAdmin.storage.from("uploads").remove([fileName]);
      throw recordError;
    }

    // Log activity
    await supabaseAdmin.from("activity_logs").insert({
      user_id: user.id,
      action: "file_uploaded",
      resource_type: "upload",
      resource_id: uploadRecord.id,
      metadata: {
        filename: fileName,
        file_type: file.type,
        file_size: file.size,
        context,
      },
    });

    return createSuccessResponse(
      {
        id: uploadRecord.id,
        url: publicUrl,
        filename: fileName,
        original_name: file.name,
        file_type: file.type,
        file_size: file.size,
        context,
        uploaded_at: uploadRecord.created_at,
      },
      201
    );
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function GET(request: NextRequest) {
  try {
    const { user } = await getAuthenticatedUser(request);
    if (!user) {
      return createErrorResponse("Authentication required.", 401);
    }

    const { searchParams } = new URL(request.url);
    const context = searchParams.get("context");
    const limit = Math.min(parseInt(searchParams.get("limit") || "20"), 50);

    let query = supabaseAdmin
      .from("uploads")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (context) {
      query = query.eq("context", context);
    }

    const { data: uploads, error: uploadsError } = await query;

    if (uploadsError) {
      throw uploadsError;
    }

    return createSuccessResponse({
      uploads,
      total: uploads.length,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { user } = await getAuthenticatedUser(request);
    if (!user) {
      return createErrorResponse("Authentication required.", 401);
    }

    const { searchParams } = new URL(request.url);
    const uploadId = searchParams.get("id");

    if (!uploadId) {
      return createErrorResponse("Upload ID is required.", 400);
    }

    // Get upload record
    const { data: upload, error: fetchError } = await supabaseAdmin
      .from("uploads")
      .select("*")
      .eq("id", uploadId)
      .eq("user_id", user.id)
      .single();

    if (fetchError || !upload) {
      return createErrorResponse("Upload not found.", 404);
    }

    // Delete from storage
    const { error: storageError } = await supabaseAdmin.storage
      .from("uploads")
      .remove([upload.filename]);

    if (storageError) {
      console.error("Storage deletion error:", storageError);
    }

    // Delete from database
    const { error: deleteError } = await supabaseAdmin
      .from("uploads")
      .delete()
      .eq("id", uploadId);

    if (deleteError) {
      throw deleteError;
    }

    // Log activity
    await supabaseAdmin.from("activity_logs").insert({
      user_id: user.id,
      action: "file_deleted",
      resource_type: "upload",
      resource_id: uploadId,
      metadata: {
        filename: upload.filename,
        context: upload.context,
      },
    });

    return createSuccessResponse({ message: "File deleted successfully." });
  } catch (error) {
    return handleRouteError(error);
  }
}
