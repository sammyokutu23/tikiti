/**
 * OpenAI Image API adapter (server-only). The API key is read here and never
 * leaves the server: it isn't a NEXT_PUBLIC_ variable, it's never logged, and
 * no provider response is forwarded to the browser.
 *
 * Source of truth: https://developers.openai.com/api/docs/guides/image-generation
 *  - GPT Image models return base64 data (`data[].b64_json`).
 *  - 1024x1024, 1536x1024 and 1024x1536 are supported by every GPT Image model;
 *    we only request those and crop to other formats ourselves.
 *  - User/quota errors must not be retried blindly; rate limits and 5xx may be.
 */
import OpenAI, { APIConnectionTimeoutError, APIError, APIConnectionError } from "openai";
import { createHash } from "node:crypto";
import { sniffImage } from "../storage";

export class BannerConfigError extends Error {}

export type BannerErrorCategory =
  | "config"
  | "moderation"
  | "invalid_request"
  | "rate_limited"
  | "quota"
  | "timeout"
  | "provider_unavailable"
  | "invalid_output";

export class BannerGenerationError extends Error {
  constructor(
    message: string,
    readonly category: BannerErrorCategory,
    /** Customer-safe explanation (never the provider's raw message). */
    readonly userMessage: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

const QUALITIES = ["low", "medium", "high", "auto"] as const;
export type ImageQuality = (typeof QUALITIES)[number];

export type ImageApiConfig = { apiKey: string; model: string; quality: ImageQuality; timeoutMs: number };

export function imageApiConfig(source: Record<string, string | undefined> = process.env): ImageApiConfig {
  const apiKey = source.OPENAI_API_KEY?.trim();
  const model = source.OPENAI_IMAGE_MODEL?.trim();
  if (!apiKey) throw new BannerConfigError("OPENAI_API_KEY is not set");
  if (!/^sk-[\w-]{20,}$/.test(apiKey)) throw new BannerConfigError("OPENAI_API_KEY doesn't look like an OpenAI API key");
  if (!model) throw new BannerConfigError("OPENAI_IMAGE_MODEL is not set (use a current GPT Image model from the OpenAI docs)");
  // Only GPT Image models return base64 JPEG/WebP with the parameters used here (DALL·E models don't).
  if (!/^gpt-image-[\w.-]+$/.test(model)) throw new BannerConfigError(`OPENAI_IMAGE_MODEL must be a GPT Image model (got "${model}")`);
  const quality = (source.OPENAI_IMAGE_QUALITY?.trim() || "medium") as ImageQuality;
  if (!QUALITIES.includes(quality)) throw new BannerConfigError(`OPENAI_IMAGE_QUALITY must be one of ${QUALITIES.join(", ")}`);
  const timeoutMs = Number(source.OPENAI_IMAGE_TIMEOUT_MS ?? 120_000);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 280_000) throw new BannerConfigError("OPENAI_IMAGE_TIMEOUT_MS must be between 10000 and 280000");
  return { apiKey, model, quality, timeoutMs };
}

/** Status for admin screens: never includes the key. */
export function imageApiStatus(): { configured: true; model: string; quality: string } | { configured: false; problem: string } {
  try {
    const c = imageApiConfig();
    return { configured: true, model: c.model, quality: c.quality };
  } catch (err) {
    return { configured: false, problem: (err as Error).message };
  }
}

export type GenerateImagesRequest = { prompt: string; size: string; n: number; endUser: string };
export type GeneratedImage = { bytes: Uint8Array; mime: string };

/** The provider call, swappable in tests. */
export type ImageGenerator = (cfg: ImageApiConfig, req: GenerateImagesRequest) => Promise<{ b64: string[] }>;

const openAiGenerator: ImageGenerator = async (cfg, req) => {
  const client = new OpenAI({ apiKey: cfg.apiKey, timeout: cfg.timeoutMs, maxRetries: 1 });
  const res = await client.images.generate({
    model: cfg.model,
    prompt: req.prompt,
    size: req.size as "1536x1024",
    n: req.n,
    quality: cfg.quality,
    output_format: "jpeg",
    output_compression: 90,
    moderation: "auto",
    // A stable, non-identifying end-user id helps OpenAI detect abuse per organizer.
    user: req.endUser,
  });
  return { b64: (res.data ?? []).map((d) => d.b64_json).filter((x): x is string => typeof x === "string" && x.length > 0) };
};

let generatorOverride: ImageGenerator | null = null;
export function setImageGeneratorOverride(fn: ImageGenerator | null) {
  generatorOverride = fn;
}

export const endUserId = (organizerId: string) => `tikiti-org-${createHash("sha256").update(organizerId).digest("hex").slice(0, 24)}`;

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

export async function generateImages(cfg: ImageApiConfig, req: GenerateImagesRequest): Promise<GeneratedImage[]> {
  let out: { b64: string[] };
  try {
    out = await (generatorOverride ?? openAiGenerator)(cfg, req);
  } catch (err) {
    throw classifyOpenAiError(err);
  }
  if (out.b64.length === 0) throw new BannerGenerationError("Provider returned no images", "invalid_output", "No image came back. Please try again.", true);
  return out.b64.slice(0, req.n).map((b64) => {
    const bytes = new Uint8Array(Buffer.from(b64, "base64"));
    const kind = sniffImage(bytes);
    if (!kind || bytes.length < 1024 || bytes.length > MAX_IMAGE_BYTES) {
      throw new BannerGenerationError("Provider returned an invalid image", "invalid_output", "The generated image was invalid. Please try again.", true);
    }
    return { bytes, mime: kind.mime };
  });
}

export function classifyOpenAiError(err: unknown): BannerGenerationError {
  if (err instanceof BannerGenerationError) return err;
  if (err instanceof APIConnectionTimeoutError) {
    return new BannerGenerationError("OpenAI request timed out", "timeout", "Image generation took too long. Please try again.", true);
  }
  if (err instanceof APIConnectionError) {
    return new BannerGenerationError("Could not reach OpenAI", "provider_unavailable", "The image service is unreachable right now. Please try again shortly.", true);
  }
  if (err instanceof APIError) {
    const code = String(err.code ?? "");
    const type = String(err.type ?? "");
    const status = err.status ?? 0;
    if (code === "moderation_blocked" || type === "image_generation_user_error" || /safety|moderation/i.test(code)) {
      return new BannerGenerationError(`Request blocked by moderation (${code || type})`, "moderation", "This description can't be used for image generation. Please rephrase it and try again.", false);
    }
    if (status === 401 || status === 403) {
      return new BannerGenerationError(`OpenAI rejected the credentials (${status})`, "config", "AI banners are temporarily unavailable. Please upload your own image for now.", false);
    }
    if (status === 404) {
      return new BannerGenerationError(`Model not found (${code || status})`, "config", "AI banners are temporarily unavailable. Please upload your own image for now.", false);
    }
    if (status === 429) {
      if (code === "insufficient_quota" || /quota|billing/i.test(err.message)) {
        return new BannerGenerationError("OpenAI quota exhausted", "quota", "AI banners are temporarily unavailable. Please upload your own image for now.", false);
      }
      return new BannerGenerationError("OpenAI rate limit", "rate_limited", "The image service is busy. Please wait a minute and try again.", true);
    }
    if (status === 400) {
      return new BannerGenerationError(`OpenAI rejected the request (${code || "bad_request"})`, "invalid_request", "That request couldn't be processed. Try a shorter or simpler description.", false);
    }
    if (status >= 500) {
      return new BannerGenerationError(`OpenAI server error (${status})`, "provider_unavailable", "The image service had a problem. Please try again shortly.", true);
    }
  }
  return new BannerGenerationError(`Unexpected image generation error: ${(err as Error)?.name ?? "unknown"}`, "provider_unavailable", "Something went wrong while generating. Please try again.", true);
}
