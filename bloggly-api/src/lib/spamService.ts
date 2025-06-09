// src/lib/spamService.ts
import AkismetAPI from "akismet-api";

interface SpamCheckOptions {
  content: string;
  authorName?: string;
  authorEmail?: string;
  userAgent?: string;
  referrer?: string;
  userIP?: string;
}

interface SpamCheckResult {
  isSpam: boolean;
  confidence?: number;
  error?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let akismetClient: any = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getAkismetClient(): any {
  if (!process.env.AKISMET_API_KEY || !process.env.AKISMET_BLOG_URL) {
    console.warn(
      "Akismet not configured - AKISMET_API_KEY or AKISMET_BLOG_URL missing"
    );
    return null;
  }

  if (!akismetClient) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    akismetClient = new (AkismetAPI as any)({
      blog: process.env.AKISMET_BLOG_URL,
      apiKey: process.env.AKISMET_API_KEY,
    });
  }

  return akismetClient;
}

export async function checkSpam(
  options: SpamCheckOptions
): Promise<SpamCheckResult> {
  const client = getAkismetClient();

  if (!client) {
    // If Akismet is not configured, assume content is not spam
    return { isSpam: false };
  }

  try {
    // Verify API key first (cache this result in production)
    const isValidKey = await client.verifyKey();
    if (!isValidKey) {
      console.error("Invalid Akismet API key");
      return { isSpam: false, error: "Invalid API key" };
    }

    const spamCheck = await client.checkSpam({
      user_ip: options.userIP || "127.0.0.1",
      user_agent: options.userAgent || "Bloggly Bot",
      referrer: options.referrer || "",
      comment_type: "comment",
      comment_author: options.authorName || "",
      comment_author_email: options.authorEmail || "",
      comment_content: options.content,
      blog_lang: "en",
      blog_charset: "UTF-8",
    });

    return {
      isSpam: spamCheck,
      confidence: spamCheck ? 0.9 : 0.1, // Simple confidence scoring
    };
  } catch (error) {
    console.error("Akismet spam check failed:", error);
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    return { isSpam: false, error: errorMessage };
  }
}

export async function submitSpam(options: SpamCheckOptions): Promise<boolean> {
  const client = getAkismetClient();

  if (!client) {
    return false;
  }

  try {
    await client.submitSpam({
      user_ip: options.userIP || "127.0.0.1",
      user_agent: options.userAgent || "Bloggly Bot",
      referrer: options.referrer || "",
      comment_type: "comment",
      comment_author: options.authorName || "",
      comment_author_email: options.authorEmail || "",
      comment_content: options.content,
    });

    return true;
  } catch (error) {
    console.error("Failed to submit spam to Akismet:", error);
    return false;
  }
}

export async function submitHam(options: SpamCheckOptions): Promise<boolean> {
  const client = getAkismetClient();

  if (!client) {
    return false;
  }

  try {
    await client.submitHam({
      user_ip: options.userIP || "127.0.0.1",
      user_agent: options.userAgent || "Bloggly Bot",
      referrer: options.referrer || "",
      comment_type: "comment",
      comment_author: options.authorName || "",
      comment_author_email: options.authorEmail || "",
      comment_content: options.content,
    });

    return true;
  } catch (error) {
    console.error("Failed to submit ham to Akismet:", error);
    return false;
  }
}
