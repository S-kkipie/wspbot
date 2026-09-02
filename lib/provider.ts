import "server-only";
import type { Tool } from "ai";
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
