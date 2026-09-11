import "server-only";
import { query } from "./db";
import { config } from "./config";
import * as cron from "./cron";
import * as mentions from "./mentions";
import type { Window } from "./summaries";

/**
 * The weekly group recap: who was around, what the week looked like, and — when there is one — a
 * callback to something the group said a while back.
 *
 * Deliberately built on `chime_settings` rather than a schedule of its own. The groups worth
 * recapping are exactly the ones already opted into the bot reading everything and speaking
 * unprompted — a recap is just a once-a-week version of the same judgement, in the same room, off
 * the same recorded log. Inventing a second opt-in for that would ask a group to agree to being
 * read twice for one outcome. See lib/db.ts for the two columns this adds to that table.
 *
 * Unlike `lib/summaries.ts`, the cron is fixed rather than configurable: Sunday 20:00, in
 * BOT_TIMEZONE. A recap is a standing rhythm for the room it is in, not a report somebody is
 * choosing a cadence for.
 */

/** Sunday at 20:00, in whatever timezone this deployment runs in. */
export const RECAP_CRON = "0 20 * * 0";

/** A week back, for the very first recap a group ever gets. */
const FIRST_RUN_LOOKBACK_MS = 7 * 24 * 3600 * 1000;

/** Generous, but a week of a busy group still has to fit in one prompt. */
const MAX_MESSAGES = 1000;

export type Due = {
  chat: string;
  chatName: string | null;
  recappedTo: Date | null;
};

type DueRow = {
  chat: string;
  chat_name: string | null;
  recapped_to: Date | null;
  last_recap_minute: string | null;
};

/**
 * Which chime-enabled groups are due a recap right now, claimed so two overlapping ticks cannot
 * both send one. Same shape as `summaries.claimDue`: the claim is the update itself, not a check
 * before it, which is what makes it safe against a restart landing on the same minute twice.
 */
export const claimDue = async (at: Date): Promise<Due[]> => {
  const pattern = cron.parse(RECAP_CRON);
  const timeZone = config.timezone();
  if (!cron.matches(pattern, at, timeZone)) return [];

  const key = cron.minuteKey(at, timeZone);
  const rows = await query<DueRow>(
    `select chat, chat_name, recapped_to, last_recap_minute
       from chime_settings
      where enabled and (last_recap_minute is distinct from $1)`,
    [key],
  );

  const due: Due[] = [];
  for (const row of rows) {
    const claimed = await query<{ chat: string }>(
      `update chime_settings
          set last_recap_minute = $2
        where chat = $1 and (last_recap_minute is distinct from $2)
        returning chat`,
      [row.chat, key],
    );
    if (claimed.length > 0) {
      due.push({ chat: row.chat, chatName: row.chat_name, recappedTo: row.recapped_to });
    }
  }
  return due;
};

/** Everything said in the week a recap is due to cover — same shape as a digest's window. */
export const windowFor = async (chat: string, recappedTo: Date | null, until: Date): Promise<Window> => {
  const from = recappedTo ?? new Date(until.getTime() - FIRST_RUN_LOOKBACK_MS);

  const rows = await query<{
    id: number;
    at: Date;
    sender_name: string | null;
    kind: string;
    text: string;
    media_note: string | null;
    media_url: string | null;
    urls: string[];
  }>(
    `select id, at, sender_name, kind, text, media_note, media_url, urls
       from logged_messages
      where chat = $1 and at > $2 and at <= $3
      order by at
      limit $4`,
    [chat, from, until, MAX_MESSAGES],
  );

  return {
    from,
    to: until,
    messages: rows.map((r) => ({
      id: Number(r.id),
      at: r.at,
      senderName: r.sender_name,
      kind: r.kind,
      text: r.text,
      mediaNote: r.media_note,
      mediaUrl: r.media_url,
      urls: r.urls ?? [],
    })),
  };
};

type WindowMessage = Window["messages"][number];

const clock = (at: Date): string =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: config.timezone(),
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "short",
  }).format(at);

/**
 * The transcript the model reads, numbered by line rather than only by picture as a digest's
 * `summaries.render` does — a recap needs to point at *any* notable line, not only an image, so
 * it gets its own numbering rather than reusing one built for a narrower purpose.
 */
export const renderNumbered = (
  window: Window,
): { transcript: string; byNumber: Map<number, WindowMessage> } => {
  const byNumber = new Map<number, WindowMessage>();

  const lines = window.messages.map((m, i) => {
    const n = i + 1;
    byNumber.set(n, m);
    const who = m.senderName ?? "someone";
    const parts: string[] = [];
    if (m.text.trim()) parts.push(m.text.trim());
    if (m.kind !== "text") parts.push(`[${m.kind}${m.mediaNote ? `: ${m.mediaNote}` : ""}]`);
    if (m.urls.length) parts.push(`[links: ${m.urls.join(" ")}]`);
    return `${n}. ${clock(m.at)} ${who}: ${parts.join(" ") || "(sin texto)"}`;
  });

  return { transcript: lines.length ? lines.join("\n") : "(no se dijo nada)", byNumber };
};

export type ActiveSender = { jid: string; name: string; count: number };

export type ActivityStats = {
  total: number;
  /** Most active first. */
  top: ActiveSender[];
};

/**
 * Who talked, and how much. Grouped by `identityKey` rather than the raw `sender` column, because
 * the same person's JID can carry a different device suffix message to message — counting the raw
 * value would split one person into several rows in the busiest group of the week, which is
 * exactly the wrong place to be wrong.
 */
export const activityStats = async (chat: string, from: Date, to: Date): Promise<ActivityStats> => {
  const [totalRow] = await query<{ n: string }>(
    "select count(*)::text as n from logged_messages where chat = $1 and at > $2 and at <= $3",
    [chat, from, to],
  );

  const rows = await query<{ sender: string | null; sender_name: string | null; n: string }>(
    `select sender, sender_name, count(*)::text as n
       from logged_messages
      where chat = $1 and at > $2 and at <= $3 and sender is not null
      group by sender, sender_name
      order by n desc`,
    [chat, from, to],
  );

  const byIdentity = new Map<
    string,
    { jid: string; jidCount: number; names: Map<string, number>; count: number }
  >();
  for (const row of rows) {
    if (!row.sender) continue;
    const id = mentions.identityKey(row.sender);
    const count = Number(row.n);
    const entry = byIdentity.get(id) ?? { jid: row.sender, jidCount: 0, names: new Map(), count: 0 };
    entry.count += count;
    // The representative JID is whichever exact value carried the most messages, so a mention
    // targets the device suffix WhatsApp has seen most often from this person this week.
    if (count > entry.jidCount) {
      entry.jid = row.sender;
      entry.jidCount = count;
    }
    if (row.sender_name) entry.names.set(row.sender_name, (entry.names.get(row.sender_name) ?? 0) + count);
    byIdentity.set(id, entry);
  }

  const top: ActiveSender[] = [...byIdentity.values()]
    .map((entry) => {
      const bestName = [...entry.names.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "alguien";
      return { jid: entry.jid, name: bestName, count: entry.count };
    })
    .sort((a, b) => b.count - a.count);

  return { total: Number(totalRow?.n ?? 0), top };
};

export type NotableMoment = { text: string; senderName: string | null; saidAt: Date };

/** Kept for as long as the deployment lives — this is the whole point of the table. */
export const recordNotableMoments = async (chat: string, moments: NotableMoment[]): Promise<void> => {
  for (const m of moments) {
    const text = m.text.trim();
    if (!text) continue;
    await query(
      `insert into notable_moments (chat, text, sender_name, said_at) values ($1, $2, $3, $4)`,
      [chat, text.slice(0, 1000), m.senderName, m.saidAt],
    );
  }
};

export type OnThisDay = { text: string; senderName: string | null; label: string };

/**
 * A callback to something worth remembering, on roughly the anniversary of when it happened.
 * Longest ago first: a year-old callback is more of a moment than a week-old one, so given a
 * choice, that is the one worth surfacing.
 *
 * Graceful by construction — every deployment starts with an empty `notable_moments`, and this
 * simply finds nothing until a few recaps have run and written some.
 */
const CANDIDATES: { label: string; days: number; toleranceDays: number }[] = [
  { label: "hace un año", days: 365, toleranceDays: 10 },
  { label: "hace 6 meses", days: 182, toleranceDays: 7 },
  { label: "hace un mes", days: 30, toleranceDays: 4 },
  { label: "hace una semana", days: 7, toleranceDays: 2 },
];

export const onThisDay = async (chat: string, now: Date): Promise<OnThisDay | null> => {
  for (const c of CANDIDATES) {
    const target = new Date(now.getTime() - c.days * 24 * 3600 * 1000);
    const from = new Date(target.getTime() - c.toleranceDays * 24 * 3600 * 1000);
    const to = new Date(target.getTime() + c.toleranceDays * 24 * 3600 * 1000);

    const rows = await query<{ text: string; sender_name: string | null }>(
      `select text, sender_name
         from notable_moments
        where chat = $1 and said_at between $2 and $3
        order by abs(extract(epoch from (said_at - $4::timestamptz)))
        limit 1`,
      [chat, from, to, target],
    );
    if (rows[0]) return { text: rows[0].text, senderName: rows[0].sender_name, label: c.label };
  }
  return null;
};

/** Only on success — a failed run should cover the same week again, not skip it. */
export const markRecapped = (chat: string, upTo: Date): Promise<unknown[]> =>
  query("update chime_settings set recapped_to = $2, last_error = null where chat = $1", [
    chat,
    upTo,
  ]);

export const markFailed = (chat: string, why: string): Promise<unknown[]> =>
  query("update chime_settings set last_error = $2 where chat = $1", [chat, why.slice(0, 500)]);
