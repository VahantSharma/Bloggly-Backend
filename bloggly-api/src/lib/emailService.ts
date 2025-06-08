// src/lib/emailService.ts
import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);
const fromAddress = process.env.EMAIL_FROM_ADDRESS || "noreply@bloggly.com";
const frontendBaseUrl =
  process.env.APP_FRONTEND_BASE_URL || "http://localhost:5173";

export interface EmailTemplate {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export async function sendEmail(
  template: EmailTemplate
): Promise<{ success: boolean; error?: string }> {
  try {
    if (!process.env.RESEND_API_KEY) {
      console.error("RESEND_API_KEY not configured");
      return { success: false, error: "Email service not configured" };
    }

    const { data, error } = await resend.emails.send({
      from: fromAddress,
      to: template.to,
      subject: template.subject,
      html: template.html,
      text: template.text,
    });

    if (error) {
      console.error("Failed to send email:", error);
      return { success: false, error: error.message };
    }

    console.log("Email sent successfully:", data?.id);
    return { success: true };
  } catch (error: any) {
    console.error("Email service error:", error);
    return { success: false, error: error.message };
  }
}

export function generateWelcomeEmail(
  username: string,
  email: string
): EmailTemplate {
  return {
    to: email,
    subject: "Welcome to Bloggly!",
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Welcome to Bloggly</title>
      </head>
      <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 40px 20px; text-align: center; border-radius: 8px 8px 0 0;">
          <h1 style="color: white; margin: 0; font-size: 28px;">Welcome to Bloggly!</h1>
        </div>
        <div style="background: #f8f9fa; padding: 40px 20px; border-radius: 0 0 8px 8px;">
          <h2 style="color: #495057; margin-top: 0;">Hello ${username}! 👋</h2>
          <p style="font-size: 16px; margin-bottom: 20px;">
            Thank you for joining Bloggly, the platform where your thoughts come to life and connect with readers worldwide.
          </p>
          <p style="font-size: 16px; margin-bottom: 20px;">
            You're now part of a vibrant community of writers and readers. Here's what you can do:
          </p>
          <ul style="font-size: 16px; margin-bottom: 30px; padding-left: 20px;">
            <li>Write and publish your first blog post</li>
            <li>Discover amazing content from other writers</li>
            <li>Engage with the community through comments and reactions</li>
            <li>Build your following and grow your audience</li>
          </ul>
          <div style="text-align: center; margin: 30px 0;">
            <a href="${frontendBaseUrl}/new-post" 
               style="background: #667eea; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">
              Write Your First Post
            </a>
          </div>
          <p style="font-size: 14px; color: #6c757d; text-align: center; margin-top: 30px;">
            Happy writing!<br>
            The Bloggly Team
          </p>
        </div>
      </body>
      </html>
    `,
    text: `Welcome to Bloggly, ${username}! Thank you for joining our community of writers and readers. Start writing your first post at ${frontendBaseUrl}/new-post`,
  };
}

export function generatePasswordResetEmail(
  email: string,
  resetToken: string
): EmailTemplate {
  const resetUrl = `${frontendBaseUrl}/reset-password?token=${resetToken}`;

  return {
    to: email,
    subject: "Reset Your Bloggly Password",
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Reset Your Password</title>
      </head>
      <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background: #dc3545; padding: 40px 20px; text-align: center; border-radius: 8px 8px 0 0;">
          <h1 style="color: white; margin: 0; font-size: 28px;">Password Reset</h1>
        </div>
        <div style="background: #f8f9fa; padding: 40px 20px; border-radius: 0 0 8px 8px;">
          <h2 style="color: #495057; margin-top: 0;">Reset Your Password</h2>
          <p style="font-size: 16px; margin-bottom: 20px;">
            We received a request to reset your password for your Bloggly account.
          </p>
          <p style="font-size: 16px; margin-bottom: 30px;">
            If you made this request, click the button below to reset your password:
          </p>
          <div style="text-align: center; margin: 30px 0;">
            <a href="${resetUrl}" 
               style="background: #dc3545; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">
              Reset Password
            </a>
          </div>
          <p style="font-size: 14px; color: #6c757d; margin-bottom: 20px;">
            This link will expire in 24 hours for security reasons.
          </p>
          <p style="font-size: 14px; color: #6c757d;">
            If you didn't request this password reset, you can safely ignore this email. Your password will not be changed.
          </p>
          <hr style="border: none; border-top: 1px solid #dee2e6; margin: 30px 0;">
          <p style="font-size: 12px; color: #6c757d; text-align: center;">
            The Bloggly Team
          </p>
        </div>
      </body>
      </html>
    `,
    text: `Reset your Bloggly password by visiting: ${resetUrl}. This link expires in 24 hours.`,
  };
}

export function generateCommentNotificationEmail(
  recipientEmail: string,
  recipientName: string,
  commenterName: string,
  postTitle: string,
  postSlug: string,
  commentContent: string
): EmailTemplate {
  const postUrl = `${frontendBaseUrl}/post/${postSlug}`;

  return {
    to: recipientEmail,
    subject: `New comment on "${postTitle}"`,
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>New Comment</title>
      </head>
      <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background: #28a745; padding: 40px 20px; text-align: center; border-radius: 8px 8px 0 0;">
          <h1 style="color: white; margin: 0; font-size: 28px;">New Comment</h1>
        </div>
        <div style="background: #f8f9fa; padding: 40px 20px; border-radius: 0 0 8px 8px;">
          <h2 style="color: #495057; margin-top: 0;">Hi ${recipientName}!</h2>
          <p style="font-size: 16px; margin-bottom: 20px;">
            <strong>${commenterName}</strong> commented on your post "<strong>${postTitle}</strong>":
          </p>
          <div style="background: white; padding: 20px; border-left: 4px solid #28a745; margin: 20px 0; border-radius: 4px;">
            <p style="margin: 0; font-style: italic;">"${commentContent.substring(0, 200)}${commentContent.length > 200 ? "..." : ""}"</p>
          </div>
          <div style="text-align: center; margin: 30px 0;">
            <a href="${postUrl}" 
               style="background: #28a745; color: white; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">
              View Comment
            </a>
          </div>
          <p style="font-size: 14px; color: #6c757d; text-align: center; margin-top: 30px;">
            Keep the conversation going!<br>
            The Bloggly Team
          </p>
        </div>
      </body>
      </html>
    `,
    text: `${commenterName} commented on your post "${postTitle}": "${commentContent.substring(0, 200)}${commentContent.length > 200 ? "..." : ""}" View at: ${postUrl}`,
  };
}
