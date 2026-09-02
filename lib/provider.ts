import "server-only";
import type { Tool } from "ai";
import { generateImage, generateSpeech } from "ai";
import { openai } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { config } from "./config";

/**
 * Provider abstraction: everywhere else in the app reads a model through `chatModel`, its
 * reasoning knob through `reasoningProviderOptions`, and its web-search tool through
 * `webSearchTool` — none of it imports `@ai-sdk/openai` or `@ai-sdk/google` directly. That is
 * what makes `AI_PROVIDER` a single switch instead of a search-and-replace across the codebase.
 *
 * Built once at module load, not per call: `createGoogleGenerativeAI` just closes over the key,
 * it does not connect to anything, so there is nothing to gain by deferring it.
 */
const google = createGoogleGenerativeAI({ apiKey: config.geminiApiKey() ?? "" });

const isGoogle = () => config.aiProvider() === "google";

/**
 * A minimal stand-in for the AI SDK's own (internal, unexported) `JSONObject` — just enough
 * structure for `reasoningProviderOptions`'s two branches to type-check as one shape rather than
 * as a union of two disjoint object literals, which is what `generateText`'s `providerOptions`
 * needs to accept either of them.
 */
type JsonRecord = { [key: string]: string | number | boolean | null | JsonRecord | undefined };

/** Any model id the selected provider can reach. */
export function chatModel(id: string) {
  return isGoogle() ? google(id) : openai(id);
}

/**
 * `BOT_EFFORT` mapped onto whatever reasoning knob the provider actually exposes. OpenAI takes a
 * named tier; Gemini takes a thinking-token budget, so the tiers below are a rough equivalence,
 * not a translation — there is no exact mapping between the two.
 */
export function reasoningProviderOptions(effort: string): Record<string, JsonRecord> {
  if (isGoogle()) {
    const thinkingBudgets: Record<string, number> = {
      minimal: 0,
      low: 1024,
      medium: 8192,
      high: 24576,
    };
    return {
      google: {
        thinkingConfig: { thinkingBudget: thinkingBudgets[effort] ?? thinkingBudgets.low },
      },
    };
  }
  return {
    openai: {
      reasoningEffort: effort,
      // A WhatsApp reply that needs scrolling has already failed.
      textVerbosity: "low",
    },
  };
}

/**
 * Provider-executed web search — both sides run the search themselves and hand back grounded
 * text, so there is no result shape for this codebase to parse and nothing here for a provider
 * switch to break beyond this one factory call.
 */
export function webSearchTool(): Tool {
  /**
   * Both factories return a `ProviderExecutedTool`, but with different (and mutually
   * incompatible) generic parameters — Google's takes an options object, OpenAI's takes none —
   * so TypeScript cannot unify the ternary's two branches into one assignable type on its own.
   * The cast is exactly that unification: both sides really are opaque, provider-run tools, and
   * `toolsFor`'s callers only ever pass this straight into `tools:`, never read its shape.
   */
  return (
    isGoogle()
      ? google.tools.googleSearch({})
      : openai.tools.webSearch({ searchContextSize: "medium" })
  ) as Tool;
}

/**
 * Steers each provider toward something that reads as a sticker rather than a photo. The
 * background instruction is the part that actually differs: gpt-image-* takes a real
 * `background: "transparent"` option below, but Gemini's image models have no such option — there
 * is no field for it in the AI SDK's `GoogleImageModelOptions`, and asking in plain English for a
 * "transparent background" gets a literal painted checkerboard back, not alpha. So the Gemini
 * prompt asks for a flat magenta backdrop instead, which `drawImage` cuts out afterwards with
 * `lib/sticker-maker.ts` `dropChromaKey`. Magenta over the more common green-screen choice:
 * a WhatsApp sticker's subject is far more likely to *need* green — a cactus, a dinosaur, a
 * dollar bill, a Minecraft creeper — than magenta, and keying out a colour the subject also wears
 * eats holes in it.
 */
const OPENAI_STICKER_STYLE =
  "Sticker art: one clear subject, centred, bold clean outlines, simple flat shapes and vivid " +
  "colours. Fully transparent background. No drop shadow, no border, no frame, no background " +
  "scenery, and no text unless the request asks for words.";

const CHROMA_KEY = "0xFF00FF";

const GOOGLE_STICKER_STYLE =
  "Sticker art: one clear subject, centred, bold clean outlines, simple flat shapes and vivid " +
  "colours. Background: a single solid flat colour filling every pixel behind the subject, pure " +
  "magenta, hex FF00FF, RGB 255/0/255, with no gradient, no shading, no texture and no other " +
  "colour in it anywhere. The subject itself must avoid magenta or pink tones so it stays " +
  "distinct from the background. Sharp clean edges between the subject and the background, no " +
  "soft blur. No drop shadow, no border, no frame, no other scenery, and no text unless the " +
  "request asks for words.";

export type DrawnImage = {
  png: Buffer;
  model: string;
  usage: { inputTokens?: number; outputTokens?: number } | undefined;
  /**
   * Set only for Gemini: the hex chroma-key colour the backdrop was painted in, so the caller
   * knows to run it through `dropChromaKey` before treating it as a real transparent PNG.
   * `undefined` means the bytes already have real alpha.
   */
  chromaKey: string | undefined;
};

/** Draw a sticker-style image from a plain description. See the style constants above for why
 * the two branches ask for such different backgrounds. */
export async function drawImage(prompt: string): Promise<DrawnImage> {
  if (isGoogle()) {
    const model = config.imageModel();
    const result = await generateImage({
      model: google.image(model),
      prompt: `${prompt}\n\n${GOOGLE_STICKER_STYLE}`,
      // Gemini image models reject `size`; square is set with the aspect ratio instead.
      aspectRatio: "1:1",
    });
    return {
      png: Buffer.from(result.image.uint8Array),
      model,
      usage: result.usage,
      chromaKey: CHROMA_KEY,
    };
  }
  const model = config.imageModel();
  const result = await generateImage({
    model: openai.image(model),
    prompt: `${prompt}\n\n${OPENAI_STICKER_STYLE}`,
    // Square in, square out — ffmpeg only has to scale, never pad.
    size: "1024x1024",
    providerOptions: {
      openai: {
        background: "transparent",
        // png keeps the alpha channel intact on the way into ffmpeg.
        outputFormat: "png",
        quality: "medium",
      },
    },
  });
  return {
    png: Buffer.from(result.image.uint8Array),
    model,
    usage: result.usage,
    chromaKey: undefined,
  };
}

const OPENAI_SPEECH_MODEL = "gpt-4o-mini-tts";
const GOOGLE_SPEECH_MODEL = "gemini-2.5-flash-preview-tts";

/**
 * OpenAI's voice presets, mapped onto a Gemini prebuilt voice with a roughly similar character —
 * Gemini does not recognise "alloy" and friends, and there is no principled translation between
 * two different voice libraries, just an attempt at a similar register. Google's own one-word
 * tag for each is in the comment. Keeping `send_voice_note`'s tool schema in the OpenAI names
 * (rather than exposing Gemini's) is what lets the model keep using a vocabulary it already knows
 * regardless of which provider is actually configured.
 */
const GOOGLE_VOICE: Record<string, string> = {
  alloy: "Charon", // Informative
  echo: "Orus", // Firm
  fable: "Achird", // Friendly
  onyx: "Alnilam", // Firm, deeper
  nova: "Aoede", // Breezy
  shimmer: "Autonoe", // Bright
};

/** The TTS model name in play right now — `lib/about.ts` reads this for its self-description. */
export const speechModelName = (): string => (isGoogle() ? GOOGLE_SPEECH_MODEL : OPENAI_SPEECH_MODEL);

/**
 * Speak text aloud. Both providers hand back a container ffmpeg can read directly — OpenAI as
 * whatever `outputFormat` asks for (wav here, deliberately, never mp3 — see `lib/audio.ts`), and
 * Gemini's provider wraps its raw PCM in a real WAV header by default. Either way the caller is
 * expected to re-encode the result with `lib/audio.ts` `toVoiceNote` before sending it; this
 * function only gets audio out of a model, it does not make it a valid WhatsApp voice note.
 */
export async function speak(
  text: string,
  opts: { voice?: string; instructions?: string } = {},
): Promise<{ audio: Buffer; model: string }> {
  if (isGoogle()) {
    const voice = (opts.voice && GOOGLE_VOICE[opts.voice]) || "Kore";
    const result = await generateSpeech({
      model: google.speech(GOOGLE_SPEECH_MODEL),
      text,
      voice,
      outputFormat: "wav",
      ...(opts.instructions ? { instructions: opts.instructions } : {}),
    });
    return { audio: Buffer.from(result.audio.uint8Array), model: GOOGLE_SPEECH_MODEL };
  }
  const result = await generateSpeech({
    model: openai.speech(OPENAI_SPEECH_MODEL),
    text,
    voice: opts.voice ?? "alloy",
    outputFormat: "wav",
    ...(opts.instructions ? { instructions: opts.instructions } : {}),
  });
  return { audio: Buffer.from(result.audio.uint8Array), model: OPENAI_SPEECH_MODEL };
}
