import "server-only";
import { config } from "./config";
import { identityKey } from "./mentions";

/**
 * A speaker's name as the model reads it, with the owner marked as the bot's creator.
 *
 * Marked by WhatsApp identity, never by display name: anyone can call themselves anything, and
 * the owner's own WhatsApp name need not be the name the bot knows them by. Takes a full JID or
 * the numeric key `mentions.identityKey` makes of one, since the turn carries the key and the
 * recorded log carries the JID.
 *
 * Its own module so both the turn (`lib/agent.ts`) and the chime transcript (`lib/chime.ts`) can
 * use it without the data layer importing the agent.
 */
export const speaker = (name: string | null, id: string | null | undefined): string => {
  // Brackets are the mark's own syntax: a display name carrying them could forge it.
  const shown = (name ?? "someone").replace(/[[\]]/g, "").trim() || "someone";
  return id && config.isOwner(identityKey(id)) ? `${shown} [${config.ownerName()}, your creator]` : shown;
};
