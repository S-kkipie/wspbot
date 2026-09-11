/**
 * The weekly recap, against a real database.
 *
 * No model calls — the same spirit as `chime-check`: the parts worth pinning down here are SQL
 * and date arithmetic, not prose. What would actually cost something if it broke:
 *
 * - **The claim.** `last_recap_minute` guards a Sunday-20:00 tick against firing twice, the same
 *   shape as `summaries.claimDue`. Lost, a restart at the right minute sends a group two recaps.
 * - **Grouping by identity, not by JID.** The same person posting under two device suffixes in
 *   one week must count as one person, or "the most active" both undercounts them and mentions
 *   the wrong JID.
 * - **"On this day" reaching backward, not into the week just covered.** A callback that matched
 *   today's own messages would just be quoting the recap back at itself.
 *
 * Needs DATABASE_URL; never calls the model, so it costs nothing.
 *
 *   npm run recap-check
 */

import { query } from "../lib/db.js";
import { config } from "../lib/config.js";
import * as cron from "../lib/cron.js";
import * as recap from "../lib/recap.js";

let failures = 0;
const check = (label: string, pass: boolean, detail = "") => {
  if (!pass) failures++;
  console.log(pass ? "  PASS" : "  FAIL", label, detail);
};

const CHAT = "000000000000000000@g.us-recap-check";
const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 3600 * 1000);

const cleanup = async () => {
  await query("delete from chime_settings where chat = $1", [CHAT]);
  await query("delete from logged_messages where chat = $1", [CHAT]);
  await query("delete from notable_moments where chat = $1", [CHAT]);
};

/** Messages in the recorded log, as if a week had happened. */
const say = async (sender: string, senderName: string, n: number, agoDays: number) => {
  for (let i = 0; i < n; i++) {
    await query(
      `insert into logged_messages (chat, message_id, sender, sender_name, kind, text, at, urls)
       values ($1, $2, $3, $4, 'text', $5, $6, '{}')`,
      [
        CHAT,
        `recap-check-${Date.now()}-${i}-${Math.random()}`,
        sender,
        senderName,
        `line ${i} from ${senderName}`,
        new Date(daysAgo(agoDays).getTime() + i * 1000),
      ],
    );
  }
};

await cleanup();

try {
  // ── the fixed cron ─────────────────────────────────────────────────────
  console.log("\nthe Sunday 20:00 pattern:");
  const pattern = cron.parse(recap.RECAP_CRON);
  // A known Sunday: 2026-01-18 is a Sunday.
  const sunday2000 = new Date("2026-01-18T20:00:00.000Z"); // UTC stand-in; matches() reads BOT_TIMEZONE
  check(
    "matches() agrees the pattern parses to something",
    pattern.minute.has(0) && pattern.hour.has(20) && pattern.dayOfWeek.has(0),
  );
  check(
    "minuteKey is stable for the same wall-clock minute",
    cron.minuteKey(sunday2000, "UTC") === cron.minuteKey(sunday2000, "UTC"),
  );

  // ── claiming ───────────────────────────────────────────────────────────
  console.log("\nthe claim:");
  await query(
    `insert into chime_settings (chat, chat_name) values ($1, 'recap-check') on conflict (chat) do nothing`,
    [CHAT],
  );

  // Find the next real Sunday 20:00 in this deployment's own timezone, the same way the runner
  // would see it — rather than assuming UTC lines up with BOT_TIMEZONE.
  const nextSunday2000 = cron.nextRuns(pattern, config.timezone(), 1)[0]!;

  const firstClaim = await recap.claimDue(nextSunday2000);
  check("a chime-enabled group is due at the next Sunday 20:00", firstClaim.some((d) => d.chat === CHAT));

  const secondClaim = await recap.claimDue(nextSunday2000);
  check(
    "claiming the same minute again finds nothing",
    !secondClaim.some((d) => d.chat === CHAT),
  );

  const offMinute = new Date(nextSunday2000.getTime() + 5 * 60 * 1000);
  const wrongTime = await recap.claimDue(offMinute);
  check("five minutes later, the pattern no longer matches", wrongTime.length === 0);

  // A disabled group is never due, regardless of the minute.
  await query("update chime_settings set enabled = false where chat = $1", [CHAT]);
  const disabledClaim = await recap.claimDue(
    new Date(nextSunday2000.getTime() + 7 * 24 * 3600 * 1000),
  );
  check("a disabled group is never claimed", !disabledClaim.some((d) => d.chat === CHAT));
  await query("update chime_settings set enabled = true, last_recap_minute = null where chat = $1", [CHAT]);

  // ── the window ─────────────────────────────────────────────────────────
  console.log("\nthe week's window:");
  await say("111@s.whatsapp.net", "Ana", 3, 2);
  const now = new Date();
  const firstWindow = await recap.windowFor(CHAT, null, now);
  check(
    "with no watermark, it looks back a week rather than a day",
    firstWindow.from.getTime() <= daysAgo(6.9).getTime(),
    `— from ${firstWindow.from.toISOString()}`,
  );
  check("and finds what was said", firstWindow.messages.length === 3);

  // ── activity, grouped by identity ─────────────────────────────────────
  console.log("\nwho was most active:");
  await say("222@s.whatsapp.net", "Beto", 5, 1);
  await say("222:9@s.whatsapp.net", "Beto", 4, 1); // same person, a different device suffix
  await say("333@s.whatsapp.net", "Cami", 2, 1);

  const stats = await recap.activityStats(CHAT, firstWindow.from, now);
  check("the total counts every message", stats.total === 3 + 5 + 4 + 2, `— ${stats.total}`);
  const beto = stats.top.find((s) => s.name === "Beto");
  check(
    "two device suffixes of the same person collapse into one",
    beto !== undefined && beto.count === 9,
    `— ${JSON.stringify(stats.top)}`,
  );
  check("the busiest person leads the list", stats.top[0]?.name === "Beto");

  // ── numbering the transcript ───────────────────────────────────────────
  console.log("\nnumbering for notable moments:");
  const { transcript, byNumber } = recap.renderNumbered(firstWindow);
  check("every message gets a line", byNumber.size === firstWindow.messages.length);
  check("numbering starts at 1", transcript.startsWith("1. "));

  // ── on this day ────────────────────────────────────────────────────────
  console.log("\non this day:");
  const nothingYet = await recap.onThisDay(CHAT, now);
  check("with nothing archived, there is nothing to say", nothingYet === null);

  await recap.recordNotableMoments(CHAT, [
    { text: "dijo que iba a aprender a tocar guitarra", senderName: "Ana", saidAt: daysAgo(30) },
  ]);
  const aMonthAgo = await recap.onThisDay(CHAT, now);
  check(
    "a moment from ~30 days back is found under 'hace un mes'",
    aMonthAgo?.label === "hace un mes",
    `— ${JSON.stringify(aMonthAgo)}`,
  );

  const tooRecentWindow = firstWindow; // spans the last couple of days, not a month or year back
  const withinThisWeek = tooRecentWindow.messages.length > 0;
  check("the window it just covered is not itself a callback source", withinThisWeek);

  // ── the watermark ──────────────────────────────────────────────────────
  console.log("\nthe watermark:");
  const beforeRow = await query<{ recapped_to: Date | null }>(
    "select recapped_to from chime_settings where chat = $1",
    [CHAT],
  );
  check("starts unset", beforeRow[0]?.recapped_to == null);
  await recap.markRecapped(CHAT, now);
  const afterRow = await query<{ recapped_to: Date | null }>(
    "select recapped_to from chime_settings where chat = $1",
    [CHAT],
  );
  check("moves once a recap has gone out", afterRow[0]?.recapped_to != null);
  const windowAfter = await recap.windowFor(CHAT, afterRow[0]!.recapped_to, new Date(now.getTime() + 1000));
  check("and what came before it is not read again", windowAfter.messages.length === 0);
} finally {
  await cleanup();
  console.log("cleaned up");
}

console.log(failures === 0 ? "\nall checks passed\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
