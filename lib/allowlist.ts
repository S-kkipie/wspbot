/**
 * Which chats the bot is allowed to act in at all — decided before tagging, before rate limits,
 * before anything else.
 *
 * Groups are opt-in: an empty allowlist blocks every group rather than none of them, so a fresh
 * deployment stays silent everywhere until somebody deliberately turns a group on. A JID that
 * simply is not a group (a DM, a broadcast, a status update) is never treated as one just
 * because it is missing from the list.
 *
 * DMs are not governed by this list at all — that is `BOT_REPLY_TO_DMS`'s job, unrelated to which
 * groups are configured, so `isDm` short-circuits before the group check runs.
 *
 * Pure, and deliberately free of `"server-only"`: it needs no database, no WhatsApp session and
 * no API key, so `scripts/allowlist-check.mts` can exercise it directly — same reason
 * `lib/oauth-state.ts` and `lib/mentions.ts` stay plain.
 */
export function isAllowedChat(
  jid: string,
  allow: string[],
  isDm: boolean,
  replyToDms: boolean,
): boolean {
  if (isDm) return replyToDms;
  const isGroup = jid.endsWith("@g.us");
  if (!isGroup) return false;
  return allow.includes(jid);
}
