import "server-only";
import { generateObject } from "ai";
import { z } from "zod";
import { chatModel, objectProviderOptions } from "./provider";
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
  prompt: z
    .string()
    .describe(
      "Listo para mandar por WhatsApp, en espanol informal (jerga peruana si encaja), un par de lineas. Para una palabra: la palabra en *negrita*, su significado en una linea, y un ejemplo de uso. Para un reto: el reto o acertijo planteado, sin revelar la respuesta. Nada de headings ni tablas -- WhatsApp no las muestra.",
    ),
  answer: z
    .string()
    .describe("Para una palabra, la palabra misma. Para un reto, su respuesta, para revelarla mas tarde."),
});

const INSTRUCTIONS = [
  "Eres SkkippIA, y vas a postear la palabra o el reto del dia en un grupo de WhatsApp.",
  "Una palabra es una palabra o expresion popular que la gente de verdad usa (jerga del dia a dia, algo de internet o de memes) con su significado y un ejemplo de uso; un reto es un desafio corto o un acertijo con una respuesta concreta.",
  "Todo de cultura popular, facil de pillar en un grupo de amigos: nada rebuscado, academico ni de otros idiomas.",
  "Espanol informal y breve -- esto es un chat de WhatsApp, no un diccionario. Una o dos lineas basta.",
].join("\n");

/**
 * A different corner to start from each day. The model cannot see yesterday, and without a push
 * somewhere else it lands on the same famous riddle almost every time — the theme is that push.
 */
const THEMES = [
  "futbol", "musica del momento", "series y peliculas", "videojuegos", "memes e internet", "redes sociales",
  "comida y comida rapida", "el celular y las apps", "famosos y farandula", "anime", "superheroes",
  "la fiesta y el tono", "el colegio y la universidad", "la chamba", "el gym", "las citas y el amor",
  "plata y compras", "viajes y la playa", "mascotas", "el trafico y el transporte", "deportes", "musica urbana",
]

/** The well-worn answers the model reaches for first, named so it stops reaching for them. */
const CLASSICS = "el mapa, la vela, el eco, la sombra, la aguja, el huevo, el silencio, la letra E";

/** Every attempt that repeats something this chat already had is refused and retried this many times. */
const MAX_ATTEMPTS = 3;

/**
 * Compose one day's entry. The kind alternates with whatever this chat had last, and the model is
 * shown every answer the chat already had — it has no other way of knowing. `rejected` carries the
 * refusal of a previous attempt, when there was one. Exported so a check script can exercise the
 * shape without going through the tick — same spirit as `recap-runner.ts` `compose`.
 */
export const compose = async (chat: string, rejected: string | null = null): Promise<games.WordOfDayEntry> => {
  const kind = (await games.lastWordOfDayKind(chat)) === "word" ? "challenge" : "word";
  const past = await games.recentAnswers(chat);
  const theme = THEMES[Math.floor(Math.random() * THEMES.length)]!;

  const result = await generateObject({
    model: chatModel(config.summaryModel()),
    providerOptions: objectProviderOptions(config.summaryModel()),
    schema: WordOfDaySchema,
    system: INSTRUCTIONS,
    prompt: [
      kind === "word" ? "Hoy toca una palabra." : `Hoy toca un reto. Que sea tuyo, no un acertijo clasico (${CLASSICS}).`,
      `Tema de hoy, para salir de lo de siempre: ${theme}.`,
      ...(past.length ? [`Ya salieron en este grupo, no repitas ninguna ni una variante: ${past.join(", ")}.`] : []),
      ...(rejected ? [`El intento anterior no sirvio: ${rejected}`] : []),
    ].join("\n"),
  });

  await usage.record({ kind: "summary", model: config.summaryModel(), chat, usage: result.usage });

  return { kind, ...result.object };
};

const HEADER = "*Palabra/reto del dia*";

const run = async (due: games.WordOfDayDue): Promise<void> => {
  let rejected: string | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const entry = await compose(due.chat, rejected);
    const started = await games.startWordOfDay(due.chat, "SkkippIA", entry);
    if (started.ok) {
      await wapi.sendText(due.chat, `${HEADER}\n\n${entry.prompt}`);
      return;
    }
    rejected = started.why;
  }
  throw new Error(`every attempt repeated something this chat already had — ${rejected}`);
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
