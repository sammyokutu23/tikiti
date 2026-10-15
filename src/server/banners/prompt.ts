/**
 * Structured prompts for AI event artwork. The model is asked for a text-free
 * background only; real event details are overlaid by compose.ts from database
 * values, because image models can't be trusted to spell names, dates or venues.
 */
import { z } from "zod";

export const BANNER_STYLES = {
  premium_nightlife: {
    label: "Premium nightlife",
    prompt: "luxurious nightclub atmosphere, deep blacks with neon magenta and electric blue accents, haze and light beams, glossy reflections, high-end and moody",
  },
  music_concert: {
    label: "Music concert",
    prompt: "live concert stage seen from the crowd, dramatic spotlights and lasers, silhouettes of raised hands, energetic and immersive",
  },
  beach_party: {
    label: "Beach party",
    prompt: "golden-hour tropical beach on the Kenyan coast, palm trees, warm sunset sky, turquoise water, festive and relaxed",
  },
  afro_tropical: {
    label: "Afro-tropical",
    prompt: "vibrant Afro-tropical art direction, bold African textile-inspired patterns, lush tropical leaves, warm saturated colours, joyful and contemporary",
  },
  corporate: {
    label: "Corporate & professional",
    prompt: "clean modern conference setting, soft natural light, refined navy and white palette with subtle geometric shapes, credible and polished",
  },
  minimal_elegant: {
    label: "Minimal & elegant",
    prompt: "minimal elegant composition, generous negative space, soft gradients, subtle texture, refined muted palette, gallery-like calm",
  },
  bold_energetic: {
    label: "Bold & energetic",
    prompt: "bold high-contrast graphic energy, dynamic diagonal shapes and motion blur, punchy saturated colours, exciting and loud",
  },
  festival_outdoor: {
    label: "Festival & outdoor",
    prompt: "open-air festival in the Kenyan countryside, colourful flags and lights, wide sky, crowd in the distance, adventurous and celebratory",
  },
} as const;
export type BannerStyle = keyof typeof BANNER_STYLES;

/**
 * Output formats. Generation always uses one of the three sizes every GPT Image
 * model supports; the final aspect ratio is produced by cropping in compose.ts.
 */
export const BANNER_FORMATS = {
  landscape: { label: "Website banner (16:9)", generateSize: "1536x1024", width: 1600, height: 900 },
  square: { label: "Square social post (1:1)", generateSize: "1024x1024", width: 1080, height: 1080 },
  portrait: { label: "Portrait poster (2:3)", generateSize: "1024x1536", width: 1080, height: 1620 },
} as const;
export type BannerFormat = keyof typeof BANNER_FORMATS;

const CATEGORY_HINTS: Record<string, string> = {
  music: "a music event",
  festival: "a festival",
  nightlife: "a night out / club night",
  conference: "a conference or business event",
  sports: "a sports event",
  workshop: "a hands-on workshop or class",
  comedy: "a comedy show",
  arts: "an arts and culture event",
};

export const MAX_BRIEF_LENGTH = 600;

export const generateBannerSchema = z.object({
  style: z.enum(Object.keys(BANNER_STYLES) as [BannerStyle, ...BannerStyle[]], { message: "Choose a style" }),
  format: z.enum(Object.keys(BANNER_FORMATS) as [BannerFormat, ...BannerFormat[]], { message: "Choose a format" }),
  category: z.enum(Object.keys(CATEGORY_HINTS) as [string, ...string[]], { message: "Choose a category" }),
  brief: z
    .string()
    .trim()
    .max(MAX_BRIEF_LENGTH, `Keep the description under ${MAX_BRIEF_LENGTH} characters`)
    .default(""),
  refinement: z.string().trim().max(300, "Keep refinements under 300 characters").default(""),
  count: z.coerce.number().int().min(1).max(4).default(1),
});
export type GenerateBannerInput = z.infer<typeof generateBannerSchema>;

/** Removes things that don't belong in an artwork brief (links, emails, phone numbers, control characters). */
export function sanitizeBrief(s: string) {
  return s
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/https?:\/\/\S+|www\.\S+/gi, "")
    .replace(/\S+@\S+\.\S+/g, "")
    .replace(/\+?\d[\d\s-]{7,}\d/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * The provider prompt. The event title is deliberately NOT included: it would
 * invite the model to render (misspelled) text, and it is overlaid exactly later.
 */
export function buildBannerPrompt(input: Pick<GenerateBannerInput, "style" | "format" | "category" | "brief" | "refinement">) {
  const style = BANNER_STYLES[input.style];
  const brief = sanitizeBrief(input.brief);
  const refinement = sanitizeBrief(input.refinement);
  const layout =
    input.format === "landscape"
      ? "Wide landscape composition. Keep the main subject in the upper and right part of the frame and leave the lower-left third calmer and darker for a text overlay."
      : input.format === "square"
        ? "Square composition. Keep the main subject in the upper half and leave the lower third calmer and darker for a text overlay."
        : "Tall portrait poster composition. Keep the main subject in the upper two thirds and leave the bottom third calmer and darker for a text overlay.";
  return [
    `Create professional promotional background artwork for ${CATEGORY_HINTS[input.category] ?? "an event"} in Kenya.`,
    `Art direction: ${style.prompt}.`,
    brief && `Organizer's description of the event and mood: "${brief}".`,
    refinement && `Adjustments requested for this version: "${refinement}".`,
    layout,
    "Important: the image must contain NO text, letters, numbers, logos, watermarks, signage or brand names of any kind — event details are added separately.",
    "Photorealistic or high-end illustrative quality, sharp focus, no borders or frames. Depict people respectfully and do not depict real, identifiable public figures.",
  ]
    .filter(Boolean)
    .join("\n");
}
