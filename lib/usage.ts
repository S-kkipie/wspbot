import "server-only";
import { query } from "./db";

/**
 * What the bot has spent.
 *
 * OpenAI does publish this — `/v1/organization/usage/completions` and `/v1/organization/costs`
 * — but both require the `api.usage.read` scope, which means an Admin key. This app holds a
 * project key and has no business holding an org-wide admin credential just to count its own
 * tokens. So it counts them itself, which is also the more useful number: what *this bot* cost,
 * not what the whole organisation did.
 *
 * Token counts are exact, straight from the API response. Money is an estimate, and only shown
 * for models whose published rates are known — a confidently wrong spend figure is worse than
 * none, because it is the kind of number people budget against.
 */

export type Kind = "reply" | "vision" | "speech" | "image" | "summary";

/**
 * Structural rather than the SDK type, because image generation reports a narrower usage shape
 * than language models do — no token details — and both need to be recordable here.
 */
type AnyUsage = {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  inputTokenDetails?: { cacheReadTokens?: number | undefined } | undefined;
};

/**
 * USD per million tokens. Gemini rates per ai.google.dev/gemini-api/docs/pricing (2026-09) —
 * note the 3.x-flash promo runs through 2026-12-31 and roughly doubles after. OpenAI rates as
 * before. Claude rates are Anthropic API list prices: through ccapi the tokens come out of a
 * Claude Code plan instead, so there they read as what the same traffic would cost on the API.
 * Override with env if they move.
 */
const RATES: Record<string, { input: number; output: number; cached?: number }> = {
  "claude-haiku-4-5": { input: 1.0, output: 5.0, cached: 0.1 },
  "claude-sonnet-5-5": { input: 2.0, output: 10.0, cached: 0.2 },
  "claude-opus-5-5": { input: 4.0, output: 20.0, cached: 0.2 },
  "gpt-5.6-sol": { input: 5.0, output: 30.0 },
  "gpt-5.6-terra": { input: 2.0, output: 12.0 },
  "gpt-5.6-luna": { input: 0.2, output: 1.2 },
  "gemini-3.8-flash": { input: 0.75, output: 3.75, cached: 0.075 },
  "gemini-3.7-flash": { input: 0.75, output: 3.75, cached: 0.075 },
  "gemini-3.6-flash": { input: 0.75, output: 3.75, cached: 0.075 },
  "gemini-3.5-flash": { input: 1.5, output: 9.0, cached: 0.15 },
  "gemini-3.5-flash-lite": { input: 0.3, output: 2.5, cached: 0.03 },
  "gemini-3.1-flash-lite": { input: 0.25, output: 1.5, cached: 0.025 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5, cached: 0.03 },
  "gemini-2.5-flash-lite": { input: 0.1, output: 0.4, cached: 0.01 },
};

/** USD per generated image, for models billed per image rather than per token. */
const IMAGE_RATES: Record<string, number> = {
  "gemini-2.5-flash-image": 0.039,
};

/**
 * A model id not in the table is left unpriced rather than guessed at. Set BOT_PRICE_INPUT and
 * BOT_PRICE_OUTPUT (USD per million tokens; the older OPENAI_PRICE_* names still work) to price
 * a model that has no built-in rate.
 */
const rateFor = (model: string): { input: number; output: number; cached?: number } | null => {
  const envIn = Number(process.env["BOT_PRICE_INPUT"] ?? process.env["OPENAI_PRICE_INPUT"]);
  const envOut = Number(process.env["BOT_PRICE_OUTPUT"] ?? process.env["OPENAI_PRICE_OUTPUT"]);
  if (envIn > 0 && envOut > 0) return { input: envIn, output: envOut };
  return RATES[model] ?? null;
};

const imageRateFor = (model: string): number | null => IMAGE_RATES[model] ?? null;

/**
 * Never let accounting break a reply. A failed insert costs a row in a report; a thrown error
 * costs the answer someone was waiting for.
 */
export const record = async (entry: {
  kind: Kind;
  model: string;
  chat?: string;
  usage?: AnyUsage;
  characters?: number;
}): Promise<void> => {
  try {
    await query(
      `insert into model_usage (kind, model, input_tokens, output_tokens, cached_tokens, characters, chat)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        entry.kind,
        entry.model,
        entry.usage?.inputTokens ?? 0,
        entry.usage?.outputTokens ?? 0,
        entry.usage?.inputTokenDetails?.cacheReadTokens ?? 0,
        entry.characters ?? 0,
        entry.chat ?? null,
      ],
    );
  } catch (err) {
    console.warn("[usage] could not record:", err instanceof Error ? err.message : err);
  }
};

export type Totals = {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  characters: number;
  /** Images drawn. Billed per image, not per token, so they are counted rather than priced. */
  images: number;
  /** null when no rate is known for the language models involved. */
  estimatedUsd: number | null;
};

type Row = {
  model: string;
  kind: string;
  calls: string;
  input_tokens: string;
  output_tokens: string;
  cached_tokens: string;
  characters: string;
};

/**
 * Grouped by model *and* kind, because the three kinds are billed in different units: language
 * calls per token, speech per character, images per image. Lumping them together produced a
 * subtly wrong picture — an image model has no per-token rate, so its rows alone were enough to
 * void the whole estimate, which read as "cost unknown" for everything.
 */
const totalsSince = async (interval: string): Promise<Totals> => {
  const rows = await query<Row>(
    `select model, kind,
            count(*)                  as calls,
            sum(input_tokens)::text   as input_tokens,
            sum(output_tokens)::text  as output_tokens,
            sum(cached_tokens)::text  as cached_tokens,
            sum(characters)::text     as characters
       from model_usage
      where at > now() - $1::interval
      group by model, kind`,
    [interval],
  );

  const totals: Totals = {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    characters: 0,
    images: 0,
    estimatedUsd: 0,
  };
  let priced = true;

  for (const row of rows) {
    const calls = Number(row.calls);
    totals.calls += calls;

    if (row.kind === "image") {
      totals.images += calls;
      const imgRate = imageRateFor(row.model);
      if (!imgRate && calls > 0) priced = false;
      if (imgRate && totals.estimatedUsd !== null) totals.estimatedUsd += calls * imgRate;
      continue;
    }
    if (row.kind === "speech") {
      totals.characters += Number(row.characters ?? 0);
      continue;
    }

    const input = Number(row.input_tokens ?? 0);
    const output = Number(row.output_tokens ?? 0);
    const cached = Number(row.cached_tokens ?? 0);
    totals.inputTokens += input;
    totals.outputTokens += output;
    totals.cachedTokens += cached;

    const rate = rateFor(row.model);
    if (!rate && input + output > 0) priced = false;
    if (rate && totals.estimatedUsd !== null) {
      // Cached input is a subset of input, billed at the cheaper cache rate (falls back to the
      // input rate when a model publishes no separate cache price).
      const nonCached = Math.max(0, input - cached);
      totals.estimatedUsd +=
        (nonCached / 1e6) * rate.input +
        (cached / 1e6) * (rate.cached ?? rate.input) +
        (output / 1e6) * rate.output;
    }
  }

  if (!priced) totals.estimatedUsd = null;
  return totals;
};

export const summary = async (): Promise<{
  today: Totals;
  week: Totals;
  allTime: Totals;
}> => {
  const [today, week, allTime] = await Promise.all([
    totalsSince("1 day"),
    totalsSince("7 days"),
    totalsSince("100 years"),
  ]);
  return { today, week, allTime };
};

const money = (usd: number | null): string =>
  usd === null
    ? "cost unknown for this model — set BOT_PRICE_INPUT and BOT_PRICE_OUTPUT to price it"
    : usd < 0.01
      ? "under $0.01"
      : `about $${usd.toFixed(2)}`;

const thousands = (n: number): string => n.toLocaleString("en-US");

const line = (label: string, t: Totals): string =>
  `${label}: ${thousands(t.inputTokens + t.outputTokens)} tokens over ${t.calls} calls ` +
  `(${thousands(t.inputTokens)} in, ${thousands(t.outputTokens)} out` +
  `${t.cachedTokens > 0 ? `, ${thousands(t.cachedTokens)} cached` : ""}) — ${money(t.estimatedUsd)}`;

/** Plain prose, because it is read out loud into a chat rather than rendered as a table. */
export const report = async (): Promise<string> => {
  const { today, week, allTime } = await summary();
  if (allTime.calls === 0) return "Nothing recorded yet.";
  return [
    line("Today", today),
    line("Last 7 days", week),
    line("All time", allTime),
    // Both are billed in their own units, so they sit outside the token figures rather than
    // being folded in at a made-up conversion.
    allTime.characters > 0
      ? `Voice notes: ${thousands(allTime.characters)} characters spoken, billed separately.`
      : "",
    allTime.images > 0
      ? `Stickers drawn: ${allTime.images}, billed per image (folded into the estimate).`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
};
