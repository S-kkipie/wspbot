import "server-only";
import { generateObject } from "ai";
import { z } from "zod";
import { chatModel } from "./provider";
import { config } from "./config";
import { wapi } from "./wapi";
import * as games from "./games";
import * as features from "./features";
import * as usage from "./usage";

/**
 * Firing the daily palabra/reto del dia drop.
 *
 * Separate from `lib/games.ts` for the reason every runner here is separate from its data layer:
 * the interactive game tools in `lib/agent.ts` only ever need the data functions, and dragging
 * the model and wapi in behind them would mean every tool call paid for imports it never uses.
 *
 * Piggybacks on `chime_settings` exactly the way `lib/recap-runner.ts` does, and for the same
 * reason: the groups worth dropping one more unprompted message into are exactly the ones that
 * already agreed to the bot reading along and speaking without being tagged. A dedicated opt-in
 * column was the other option on the table — it would let a chime-enabled group skip just this
 * without leaving chime entirely, which nobody has asked for yet, and it is a one-line addition
 * to `chime_settings` the day somebody does. Reusing the existing opt-in is the least-duplicative
 * choice today.
 */

const TICK_MS = 60 * 1000;

const g = globalThis as unknown as { wspbotGamesWord?: NodeJS.Timeout };

const WordOfDaySchema = z.object({
  kind: z
    .enum(["word", "challenge"])
    .describe(
      "'word' for a word-of-the-day (a real word, its meaning, an example). 'challenge' for a short daily challenge or riddle-style acertijo, with a definite answer.",
    ),
  prompt: z
    .string()
    .describe(
      "Listo para mandar por WhatsApp, en espanol informal (jerga peruana si encaja), un par de lineas. Para 'word': la palabra en *negrita*, su significado en una linea, y un ejemplo de uso. Para 'challenge': el reto o acertijo planteado, sin revelar la respuesta. Nada de headings ni tablas -- WhatsApp no las muestra.",
    ),
  answer: z
    .string()
    .optional()
    .describe("Solo para 'challenge': la respuesta, para revelarla mas tarde. Omite si no aplica."),
});

const INSTRUCTIONS = [
  "Eres SkkippIA, y vas a postear la palabra o el reto del dia en un grupo de WhatsApp.",
  "Alterna el tipo de cosa que sale: a veces una palabra interesante (rebuscada, un peruanismo, algo en otro idioma) con su significado y un ejemplo de uso; otras veces un reto corto o un acertijo con una respuesta concreta.",
  "Espanol informal y breve -- esto es un chat de WhatsApp, no un diccionario. Una o dos lineas basta.",
  "Nunca repitas exactamente lo mismo de una vez a otra; inventa algo fresco cada vez que te lo piden.",
].join("\n");

/**
 * Compose one day's entry. Exported so a check script can exercise the shape without going
 * through the tick or a live database — same spirit as `recap-runner.ts` `compose`.
 */
export const compose = async (chat: string): Promise<games.WordOfDayEntry> => {
  const result = await generateObject({
    model: chatModel(config.summaryModel()),
    schema: WordOfDaySchema,
    system: INSTRUCTIONS,
    prompt: "Dame la palabra o el reto de hoy.",
  });

  await usage.record({ kind: "summary", model: config.summaryModel(), chat, usage: result.usage });

  return result.object;
};

const HEADER = "*Palabra/reto del dia*";

const run = async (due: games.WordOfDayDue): Promise<void> => {
  const entry = await compose(due.chat);
  await games.startWordOfDay(due.chat, "SkkippIA", entry);
  await wapi.sendText(due.chat, `${HEADER}\n\n${entry.prompt}`);
};

const tick = async (): Promise<void> => {
  try {
    if (!(await features.enabled()).has("games")) return;

    const due = await games.claimWordOfDayDue(new Date());
    // Sequential: several groups due the same minute should not race each other's sends.
    for (const d of due) {
      try {
        await run(d);
        console.log(`[games] posted the word/challenge of the day in ${d.chatName ?? d.chat}`);
      } catch (err) {
        console.error(
          `[games] word-of-day for ${d.chat} failed:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  } catch (err) {
    console.error("[games] word-of-day tick failed:", err instanceof Error ? err.message : err);
  }
};

export const startGames = (): void => {
  if (g.wspbotGamesWord) return;
  console.log(`[games] checking every ${TICK_MS / 1000}s for the daily word/challenge drop`);
  const timer = setInterval(() => void tick(), TICK_MS);
  timer.unref?.();
  g.wspbotGamesWord = timer;
};
