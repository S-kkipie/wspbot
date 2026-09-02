import "server-only";
import type { Tool } from "ai";
import { generateImage, generateSpeech, generateText, tool } from "ai";
import { z } from "zod";
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
 * Exa's REST search — a purpose-built search API, and the preferred backend for `web_search`
 * under Gemini when `EXA_API_KEY` is configured (see `webSearchTool` below). Formats results
 * into a compact block the model can read and cite: a title, the bare URL, and a short snippet
 * per result. Throws on any failure; `webSearchTool`'s `execute` is what turns that into a
 * string handed back to the model, per this app's convention of returning tool failures rather
 * than throwing them into the turn.
 */
async function exaSearch(searchQuery: string): Promise<string> {
  const res = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: {
      "x-api-key": config.exaApiKey()!,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query: searchQuery,
      numResults: 5,
      type: "auto",
      contents: { text: { maxCharacters: 1200 } },
    }),
  });
  if (!res.ok) {
    throw new Error(`Exa returned ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as {
    results?: Array<{ title?: string; url: string; text?: string }>;
  };
  const results = data.results ?? [];
  if (!results.length) return "No results found.";
  return results
    .map(({ title, url, text }) => {
      const snippet = text?.trim();
      return `${title || url}\n${url}${snippet ? `\n${snippet}` : ""}`;
    })
    .join("\n\n");
}

/**
 * Gemini's own grounding — `google.tools.googleSearch` — cannot ride alongside this app's
 * function tools in one request: Gemini rejects "combination of function and provider-defined
 * tools" outside the Gemini 3 family. Rather than withdraw search under Gemini entirely, this
 * runs it in an ISOLATED sub-call that has only the provider-defined search tool and none of
 * this app's other tools, so the restriction never applies. `webSearchTool` wraps this as a
 * normal function tool, which is what lets it coexist with everything else in the outer turn.
 *
 * Falls back to this when `EXA_API_KEY` is unset; see `exaSearch` above for the preferred path.
 */
async function groundedSearch(searchQuery: string): Promise<string> {
  const result = await generateText({
    model: google(config.model()),
    prompt:
      "Search the web and answer the following question directly and concisely, using what " +
      `you find. Question: ${searchQuery}`,
    /**
     * Cast for the same reason the old `webSearchTool` cast existed: `googleSearch`'s factory
     * returns a `ProviderExecutedTool` whose generics `generateText`'s `tools:` cannot unify on
     * their own. It really is a plain, opaque provider-run tool underneath.
     */
    tools: { google_search: google.tools.googleSearch({}) as Tool },
  });

  /**
   * `result.sources` is `LanguageModelV4Source[]` (via `@ai-sdk/provider`), built by
   * `@ai-sdk/google`'s `extractSources` from `groundingMetadata.groundingChunks` — verified
   * against `node_modules/@ai-sdk/google/src/google-language-model.ts`. Only `sourceType:
   * "url"` sources carry a `url` field (the other variant, `"document"`, does not), so that is
   * the only kind appended here — bare URLs, one per line, for the outer model to cite.
   */
  const urls = result.sources
    .filter((source) => source.sourceType === "url")
    .map((source) => source.url);

  return urls.length ? `${result.text}\n\nSources:\n${urls.join("\n")}` : result.text;
}

/**
 * `web_search`, as a normal function tool on both providers — never the provider-defined
 * `googleSearch` tool directly, which is what let it collide with the rest of this app's tools
 * under Gemini in the first place (see `groundedSearch` above). OpenAI's hosted web-search tool
 * has no such restriction and is passed straight through unchanged.
 */
export function webSearchTool(): Tool {
  if (isGoogle()) {
    return tool({
      description:
        "Search the web for anything current, factual, or specific enough that being wrong " +
        "would matter. Returns a written answer with source URLs to cite.",
      inputSchema: z.object({
        query: z.string().describe("What to search for."),
      }),
      execute: async ({ query }) => {
        try {
          return config.exaApiKey() ? await exaSearch(query) : await groundedSearch(query);
        } catch (err) {
          const why = err instanceof Error ? err.message : String(err);
          console.error("[web_search] failed:", why);
          return `Search failed: ${why}`;
        }
      },
    }) as Tool;
  }
  return openai.tools.webSearch({ searchContextSize: "medium" }) as Tool;
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
