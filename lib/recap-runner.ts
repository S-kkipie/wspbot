import "server-only";
import { generateObject } from "ai";
import { chatModel, objectProviderOptions } from "./provider";
import { z } from "zod";
import { config } from "./config";
import { wapi } from "./wapi";
import * as recap from "./recap";
import * as mentions from "./mentions";
import * as features from "./features";
import * as usage from "./usage";

/**
 * Firing the weekly recap.
 *
 * Separate from `lib/recap.ts` for the reason every runner here is separate from its data layer:
 * the dashboard (via the chime page, which is what recap piggybacks on) imports the data, and it
 * has no business dragging the model and the WhatsApp client in behind it.
 *
 * Two things make a recap different from a scheduled digest:
 *
 * - **It @-mentions people.** The most active senders are named *and* attached to the send as
 *   `mentions`, the same way a normal reply mentions whoever it is answering — see
 *   `app/api/wapi/webhook/route.ts`. Naming someone in prose without the mention array is not a
 *   tag, it is just their name in a sentence nobody is notified about.
 * - **The numbers are never the model's to invent.** Total messages and who was most active are
 *   computed in SQL by `recap.activityStats` and spliced in after the model has written the
 *   prose, the same principle `lib/leaderboard.ts` applies to vote counts: arithmetic anyone
 *   could get wrong belongs to the code, not to a paragraph a model wrote.
 */

const TICK_MS = 60 * 1000;

/** Named and mentioned. Past a handful a recap stops being about people and starts being a roll call. */
const MAX_TOP = 3;

/** Kept into `notable_moments` for a future "on this day". Few, so what is kept was actually notable. */
const MAX_NOTABLE = 3;

const g = globalThis as unknown as { wspbotRecap?: NodeJS.Timeout };

const RecapSchema = z.object({
  recap: z
    .string()
    .describe(
      "El recap en sí, listo para mandar por WhatsApp. Español, informal — como alguien de Lima que estuvo leyendo el grupo toda la semana — y en el registro propio de ESTE grupo: si tiran jerga, groserías o puro chiste, no seas soso; si el grupo es seco, sé seco. Qué se habló (temas, no una transcripción) y los momentos que valieron la pena, con quién los protagonizó. *negrita* y guiones nomás, nada de headings ni tablas — WhatsApp no rinde nada más. No menciones cifras ni quién habló más: eso va aparte, ya calculado.",
    ),
  notableMomentIds: z
    .array(z.number())
    .max(MAX_NOTABLE)
    .describe(
      "Números de línea (el que abre cada línea, ej. '12.') de hasta 3 momentos que vale la pena recordar más adelante — algo gracioso, memorable, o que resume la semana. Vacío si nada destaca especialmente. No inventes uno si no hay nada que valga la pena.",
    ),
});

const INSTRUCTIONS = [
  "Eres SkkippIA, escribiendo el recap semanal de un grupo de WhatsApp para la gente que sí lo leyó toda la semana — no es un resumen para quien se lo perdió, es un repaso con la gente que ya estuvo ahí.",
  "",
  "Qué importa, en orden:",
  "- De qué se habló, en pocas líneas. Temas, no una transcripción.",
  "- Momentos que se salieron de lo normal: algo gracioso, una noticia, una decisión, un logro, un quilombo. Nombra a quién le pasó.",
  "- Nunca inventes algo que no está en la transcripción. Si la semana estuvo tranquila, dilo así de simple — no lo infles.",
  "- No abras con un preámbulo tipo 'aquí está el resumen'. Ve directo al contenido.",
  "- No repitas cifras (mensajes, quién habló más): eso se agrega aparte, ya calculado con datos reales.",
].join("\n");

const header = (chatName: string | null, chat: string, window: { from: Date; to: Date }): string => {
  const when = (d: Date) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: config.timezone(),
      day: "2-digit",
      month: "short",
    }).format(d);
  return `*${chatName ?? chat}* · recap semanal · ${when(window.from)} → ${when(window.to)}`;
};

/**
 * Write the recap prose and pick what is worth keeping long-term, without sending anything.
 * Exported so a check script can exercise the shape without a live database.
 */
export const compose = async (
  chat: string,
  window: Awaited<ReturnType<typeof recap.windowFor>>,
): Promise<{ text: string; notable: recap.NotableMoment[] }> => {
  const { transcript, byNumber } = recap.renderNumbered(window);

  const result = await generateObject({
    model: chatModel(config.summaryModel()),
    providerOptions: objectProviderOptions(config.summaryModel()),
    schema: RecapSchema,
    system: INSTRUCTIONS,
    prompt: [
      `Grupo: ${chat}`,
      `${window.messages.length} mensajes esta semana.`,
      "",
      "Transcripción:",
      transcript,
    ].join("\n"),
  });

  await usage.record({
    kind: "summary",
    model: config.summaryModel(),
    chat,
    usage: result.usage,
  });

  const notable: recap.NotableMoment[] = result.object.notableMomentIds
    .map((n) => byNumber.get(n))
    .filter((m): m is NonNullable<typeof m> => m !== undefined && m.text.trim().length > 0)
    .slice(0, MAX_NOTABLE)
    .map((m) => ({ text: m.text.trim(), senderName: m.senderName, saidAt: m.at }));

  return { text: result.object.recap.trim(), notable };
};

/** The stats line, computed rather than written — see the module comment. */
const statsLine = (stats: recap.ActivityStats): { text: string; jids: string[] } => {
  const top = stats.top.slice(0, MAX_TOP);
  const jids = top.map((s) => s.jid);
  const who = top
    .map((s) => `@${mentions.identityKey(s.jid)} (${s.count})`)
    .join(", ");
  const text = `📊 ${stats.total} mensaje${stats.total === 1 ? "" : "s"} esta semana.${
    who ? ` Los más activos: ${who}` : ""
  }`;
  return { text, jids };
};

const onThisDayLine = (found: recap.OnThisDay | null): string =>
  found ? `📼 ${found.label}, ${found.senderName ?? "alguien"} dijo: "${found.text}"` : "";

/** One group, one recap. */
const run = async (due: recap.Due): Promise<void> => {
  const until = new Date();
  const window = await recap.windowFor(due.chat, due.recappedTo, until);

  if (window.messages.length === 0) {
    await wapi.sendText(due.chat, `${header(due.chatName, due.chat, window)}\n\nNadie dijo nada esta semana.`);
    await recap.markRecapped(due.chat, until);
    return;
  }

  const [{ text, notable }, stats, onThisDay] = await Promise.all([
    compose(due.chat, window),
    recap.activityStats(due.chat, window.from, window.to),
    /*
     * Genuinely optional — a callback is a nice extra, not the point of the recap — so a failure
     * here (or simply nothing archived yet) must never be the reason a group's recap does not go
     * out at all.
     */
    recap
      .onThisDay(due.chat, until)
      .catch((err) => {
        console.warn(
          "[recap] on-this-day lookup failed:",
          err instanceof Error ? err.message : err,
        );
        return null;
      }),
  ]);

  const { text: statsText, jids } = statsLine(stats);
  const callback = onThisDayLine(onThisDay);

  const full = [header(due.chatName, due.chat, window), "", text, "", statsText, callback]
    .filter(Boolean)
    .join("\n");

  await wapi.sendText(due.chat, full, jids.length ? { mentions: jids } : {});

  // Best-effort: a recap that sent but failed to archive its callbacks is still a recap that sent.
  await recap.recordNotableMoments(due.chat, notable).catch((err) =>
    console.warn("[recap] could not record notable moments:", err instanceof Error ? err.message : err),
  );

  await recap.markRecapped(due.chat, until);
};

const tick = async (): Promise<void> => {
  try {
    /*
     * Gated on the same "chime" switch the population is drawn from — a recap is the weekly
     * shape of the same permission a group already gave for the bot to read along and speak
     * unprompted, so there is no separate switch to keep in sync with it.
     */
    if (!(await features.enabled()).has("chime")) return;

    const due = await recap.claimDue(new Date());
    // Sequential: several groups due the same Sunday minute should not race each other's sends.
    for (const d of due) {
      try {
        await run(d);
        console.log(`[recap] sent a recap for ${d.chatName ?? d.chat}`);
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        console.error(`[recap] ${d.chat} failed:`, why);
        await recap.markFailed(d.chat, why);
      }
    }
  } catch (err) {
    console.error("[recap] tick failed:", err instanceof Error ? err.message : err);
  }
};

export const startRecap = (): void => {
  if (g.wspbotRecap) return;
  console.log(`[recap] checking every ${TICK_MS / 1000}s, due Sunday 20:00 ${config.timezone()}`);
  const timer = setInterval(() => void tick(), TICK_MS);
  timer.unref?.();
  g.wspbotRecap = timer;
};
