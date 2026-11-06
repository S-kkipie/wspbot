import "server-only";
import { query } from "./db";
import { config } from "./config";
import * as cron from "./cron";

/**
 * Group games: quien dijo esto, palabra/reto del dia, ahorcado, adivinanzas.
 *
 * One data layer for all four, the same way `lib/chime.ts` and `lib/summaries.ts` split apart
 * from the model and wapi calls that use them — the model call for the daily word drop lives in
 * `lib/games-runner.ts`, and this file has no idea `reply()` or `wapi` exist. Everything here is
 * plain SQL and arithmetic.
 *
 * The one rule that matters more than any single game: **the secret never lives in the model's
 * memory.** A model call has no state between turns — whoever invented a hangman word or picked a
 * riddle answer forgets it the instant that turn ends — so every check of "is this guess right?"
 * reads the `games` row rather than asking the model to judge its own earlier answer. That is why
 * every guess function below takes the plain text of a guess and returns a verdict, never a tool
 * that just asks the model to decide.
 *
 * Quien dijo esto is the one game that touches somebody else's words. It reads real lines from
 * `logged_messages` — the same table `lib/chime.ts` and `lib/summaries.ts` populate — and never
 * anything else: no other chat's log, no message from the bot itself (`fromMe` messages are
 * dropped before they ever reach that table, in `lib/mentions.ts` `parse`), and only chats that
 * are already being recorded for a digest or for chiming have anything to draw from. A chat with
 * no log gets a plain explanation instead of an invented line — never a fabricated "quote".
 */

export type GameType = "who_said_it" | "word_of_day" | "hangman" | "riddle";
export type GameStatus = "active" | "finished";
/** The three that can be guessed at. word_of_day is posted, not solved. */
export type GuessableType = "who_said_it" | "hangman" | "riddle";

const LABEL: Record<GameType, string> = {
  who_said_it: "una ronda de quien dijo esto",
  word_of_day: "una palabra/reto del dia",
  hangman: "un ahorcado",
  riddle: "una adivinanza",
};

type Row = {
  id: string;
  chat: string;
  type: GameType;
  status: GameStatus;
  data: Record<string, unknown>;
  started_by: string | null;
};

/**
 * Folds a string down to something comparable: upper case, accents stripped. The letter n-with-
 * tilde is protected first and restored after — NFD decomposes it into a plain n plus a combining
 * tilde, which would fold "ANO" (year) and "ano" to the same thing, and in Spanish those are not
 * the same word. Every codepoint here is written as a `\u` escape rather than typed directly, so
 * the source file never carries a raw combining mark or a precomposed letter that an editor or a
 * pipe could silently re-encode into something that looks the same and matches nothing.
 */
const N_TILDE_UPPER = "Ñ"; // U+00D1 LATIN CAPITAL LETTER N WITH TILDE
const PLACEHOLDER = "";
const COMBINING_MARKS = /[̀-ͯ]/g; // what NFD splits an accent into

export const fold = (s: string): string =>
  s
    .trim()
    .toUpperCase()
    .split(N_TILDE_UPPER)
    .join(PLACEHOLDER)
    .normalize("NFD")
    .replace(COMBINING_MARKS, "")
    .split(PLACEHOLDER)
    .join(N_TILDE_UPPER);

/** Any active game of this type in this chat is finished off before a new one starts, which is
 * what makes "one active game per chat per type" true without ever hitting the DB constraint. */
const supersede = (chat: string, type: GameType): Promise<unknown[]> =>
  query(
    `update games
        set status = 'finished', data = data || '{"outcome":"superseded"}'::jsonb,
            finished_at = now(), updated_at = now()
      where chat = $1 and type = $2 and status = 'active'`,
    [chat, type],
  );

// -- Repeats ------------------------------------------------------------------

/**
 * Every answer here is invented by a model call that never sees the rounds before it, so left to
 * itself it reaches for the single most famous riddle, every time — one group got "un mapa" on
 * most days. What a chat already had is this table's to remember, and every game that invents an
 * answer refuses one this chat had recently, the same way `startHangman` refuses a bad word: with
 * a reason the model can act on.
 *
 * Long enough to break the habit, short enough that a good one can come back some day.
 */
const REPEAT_DAYS = 90;

const LEADING_ARTICLE = /^(EL|LA|LOS|LAS|LO|UN|UNA|UNOS|UNAS)\s+/;

/**
 * An answer reduced to what makes it the same answer: folded, punctuation gone, no leading
 * article — "Un mapa", "el mapa." and "MAPA" are one riddle. Equality only, unlike a guess: here a
 * near miss is a genuinely different answer, and "sol" must not block "girasol".
 */
const answerKey = (s: string): string =>
  fold(s)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(LEADING_ARTICLE, "");

/** The bold word a word-of-the-day post leads with — where it lives in entries saved before the
 * word was also stored as the answer. */
const boldWord = (prompt: string): string | null =>
  prompt.match(/\*+([^*\n]{2,40})\*+/)?.[1]?.trim() ?? null;

const nonEmpty = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

const answerOf = (type: GameType, data: Record<string, unknown>): string | null => {
  if (type === "hangman") return nonEmpty(data["secret"]);
  if (type === "riddle") return nonEmpty(data["answer"]);
  if (type === "word_of_day") {
    return nonEmpty(data["answer"]) ?? (data["kind"] === "word" ? boldWord(String(data["prompt"] ?? "")) : null);
  }
  return null;
};

/** What this chat already had, newest first, one per distinct answer. */
export const recentAnswers = async (chat: string): Promise<string[]> => {
  const rows = await query<{ type: GameType; data: Record<string, unknown> }>(
    `select type, data from games
      where chat = $1 and type in ('word_of_day', 'riddle', 'hangman')
        and created_at > now() - make_interval(days => $2)
      order by id desc`,
    [chat, REPEAT_DAYS],
  );
  const seen = new Set<string>();
  const answers: string[] = [];
  for (const row of rows) {
    const answer = answerOf(row.type, row.data);
    const key = answer && answerKey(answer);
    if (!answer || !key || seen.has(key)) continue;
    seen.add(key);
    answers.push(answer);
  }
  return answers;
};

/** The refusal for an answer this chat already had, or null when it is new here. */
const repeatOf = async (chat: string, answer: string | null | undefined): Promise<string | null> => {
  const key = answer ? answerKey(answer) : "";
  if (!key) return null;
  const past = await recentAnswers(chat);
  if (!past.some((a) => answerKey(a) === key)) return null;
  return `"${answer!.trim()}" ya salio en este chat hace poco. Inventa otra completamente distinta, ni esa ni una variante. Ya salieron: ${past.slice(0, 40).join(", ")}.`;
};

const activeRow = async (chat: string, type: GameType): Promise<Row | null> => {
  const rows = await query<Row>(
    `select id, chat, type, status, data, started_by
       from games where chat = $1 and type = $2 and status = 'active'
       order by id desc limit 1`,
    [chat, type],
  );
  return rows[0] ?? null;
};

// -- Quien dijo esto --------------------------------------------------------

/** How far back a line is preferred from, before recent chatter is allowed as a fallback. */
const PREFER_OLDER_THAN_HOURS = 2;
/** Long enough to rule out a bare "jaja" or a single emoji without also ruling out real lines. */
const MIN_CHARS = 8;

type CandidateRow = { id: string; sender: string; sender_name: string; text: string };

/**
 * One real line from this chat's own log — never anyone else's chat, never the bot's own words
 * (those never reach `logged_messages` in the first place). `text !~ '^\S+$'` throws out a
 * message that is a single token: one word, one emoji, one bare link. Biased toward lines older
 * than two hours so the puzzle is not just re-reading something said a minute ago, but a chat
 * with nothing older than that still gets a game rather than a refusal.
 */
const pickCandidateLine = async (chat: string): Promise<CandidateRow | null> => {
  const rows = await query<CandidateRow>(
    `select id, sender, sender_name, text
       from logged_messages
      where chat = $1
        and kind = 'text'
        and sender is not null
        and sender_name is not null
        and length(trim(text)) >= $2
        and text !~ '^\\S+$'
        and text !~* '^https?://\\S+$'
      order by (at < now() - make_interval(hours => $3)) desc, random()
      limit 1`,
    [chat, MIN_CHARS, PREFER_OLDER_THAN_HOURS],
  );
  return rows[0] ?? null;
};

export const NO_LOG_EXPLANATION =
  "No encuentro suficientes mensajes guardados de este grupo todavia. Este juego solo usa lineas reales de este chat, y este chat no tiene un historial que leer -- necesita que 'resumenes' o 'chime' esten activados para este grupo, y que haya pasado algo de conversacion real.";

export const startWhoSaidIt = async (
  chat: string,
  startedBy: string,
): Promise<{ ok: true; text: string } | { ok: false; why: string }> => {
  const candidate = await pickCandidateLine(chat);
  if (!candidate) return { ok: false, why: NO_LOG_EXPLANATION };

  await supersede(chat, "who_said_it");
  await query(
    `insert into games (chat, type, status, data, started_by)
     values ($1, 'who_said_it', 'active', $2::jsonb, $3)`,
    [
      chat,
      JSON.stringify({
        text: candidate.text,
        senderJid: candidate.sender,
        senderName: candidate.sender_name,
        loggedMessageId: candidate.id,
        guesses: [] as { by: string; guess: string; correct: boolean }[],
      }),
      startedBy,
    ],
  );
  return { ok: true, text: candidate.text };
};

/** Who has guessed right most often in this chat, as a short trailer — empty until somebody has. */
export const whoSaidItTally = async (chat: string, limit = 3): Promise<string> => {
  const rows = await query<{ winner: string; n: string }>(
    `select data->>'winnerName' as winner, count(*)::text as n
       from games
      where chat = $1 and type = 'who_said_it' and status = 'finished'
        and data->>'winnerName' is not null
      group by data->>'winnerName'
      order by count(*) desc
      limit $2`,
    [chat, limit],
  );
  if (!rows.length) return "";
  return `puntajes: ${rows.map((r) => `${r.winner} ${r.n}`).join(", ")}`;
};

type WhoSaidItData = {
  text: string;
  senderName: string;
  guesses: { by: string; guess: string; correct: boolean }[];
};

const guessWhoSaidIt = async (
  chat: string,
  guesserName: string,
  guessText: string,
): Promise<GuessResult> => {
  const row = await activeRow(chat, "who_said_it");
  if (!row) {
    return { ok: false, why: "No hay una ronda de quien dijo esto activa en este chat." };
  }
  const data = row.data as unknown as WhoSaidItData;

  const guessFold = fold(guessText);
  const targetFold = fold(data.senderName);
  const correct =
    guessFold.length > 0 &&
    (targetFold === guessFold || targetFold.includes(guessFold) || guessFold.includes(targetFold));

  const guesses = [...(data.guesses ?? []), { by: guesserName, guess: guessText, correct }].slice(-30);

  if (correct) {
    await query(
      `update games set status = 'finished', data = data || $2::jsonb, finished_at = now(), updated_at = now()
        where id = $1`,
      [row.id, JSON.stringify({ guesses, outcome: "won", winnerName: guesserName })],
    );
    const tally = await whoSaidItTally(chat);
    return {
      ok: true,
      correct: true,
      over: true,
      message: `Correcto! Fue ${data.senderName}: "${data.text}"${tally ? ` -- ${tally}` : ""}`,
    };
  }

  await query(`update games set data = data || $2::jsonb, updated_at = now() where id = $1`, [
    row.id,
    JSON.stringify({ guesses }),
  ]);
  return { ok: true, correct: false, over: false, message: `No, no fue ${guessText}.` };
};

// -- Palabra / reto del dia ---------------------------------------------------

export type WordOfDayEntry = { kind: "word" | "challenge"; prompt: string; answer?: string };

/** Whether this chat's last word/challenge was a word or a challenge, so the next can be the other. */
export const lastWordOfDayKind = async (chat: string): Promise<WordOfDayEntry["kind"] | null> => {
  const rows = await query<{ kind: string | null }>(
    `select data->>'kind' as kind from games
      where chat = $1 and type = 'word_of_day'
      order by id desc limit 1`,
    [chat],
  );
  const kind = rows[0]?.kind;
  return kind === "word" || kind === "challenge" ? kind : null;
};

/** Posted content, not a guessed one — starting a new day's entry always supersedes yesterday's. */
export const startWordOfDay = async (
  chat: string,
  startedBy: string,
  entry: WordOfDayEntry,
): Promise<{ ok: true } | { ok: false; why: string }> => {
  const repeat = await repeatOf(chat, entry.answer ?? (entry.kind === "word" ? boldWord(entry.prompt) : null));
  if (repeat) return { ok: false, why: repeat };
  await supersede(chat, "word_of_day");
  await query(
    `insert into games (chat, type, status, data, started_by)
     values ($1, 'word_of_day', 'active', $2::jsonb, $3)`,
    [chat, JSON.stringify({ kind: entry.kind, prompt: entry.prompt, answer: entry.answer ?? null }), startedBy],
  );  return { ok: true };
};

/**
 * The claim for the once-a-day drop, on `chime_settings` — see the comment on
 * `games_word_last_minute` in lib/db.ts for why it lives there rather than a table of its own.
 * Fixed cron, the same design choice `lib/recap.ts` makes and for the same reason: this is a
 * standing daily rhythm for a room, not something each group configures a cadence for.
 */
export const WORD_OF_DAY_CRON = "0 9 * * *";

export type WordOfDayDue = { chat: string; chatName: string | null };

export const claimWordOfDayDue = async (at: Date): Promise<WordOfDayDue[]> => {
  const pattern = cron.parse(WORD_OF_DAY_CRON);
  const timeZone = config.timezone();
  if (!cron.matches(pattern, at, timeZone)) return [];

  const key = cron.minuteKey(at, timeZone);
  const rows = await query<{ chat: string; chat_name: string | null }>(
    `select chat, chat_name from chime_settings
      where enabled and (games_word_last_minute is distinct from $1)`,
    [key],
  );

  const due: WordOfDayDue[] = [];
  for (const row of rows) {
    const claimed = await query<{ chat: string }>(
      `update chime_settings
          set games_word_last_minute = $2
        where chat = $1 and (games_word_last_minute is distinct from $2)
        returning chat`,
      [row.chat, key],
    );
    if (claimed.length > 0) due.push({ chat: row.chat, chatName: row.chat_name });
  }
  return due;
};

// -- Ahorcado -----------------------------------------------------------------

/** Letters only (any script), 3 to 20 of them — no spaces, digits or punctuation to hide behind. */
const WORD_RE = /^[\p{L}]{3,20}$/u;
const MAX_HANGMAN_MISSES = 6;

type HangmanData = { secret: string; guessedLetters: string[]; misses: number; maxMisses: number };

export const startHangman = async (
  chat: string,
  startedBy: string,
  secretWord: string,
): Promise<{ ok: true } | { ok: false; why: string }> => {
  const word = secretWord.trim();
  if (!WORD_RE.test(word)) {
    return {
      ok: false,
      why: "Esa no sirve como palabra de ahorcado: tiene que ser de 3 a 20 letras, sin espacios, numeros ni signos. Inventa una que si cumpla.",
    };
  }
  const repeat = await repeatOf(chat, word);
  if (repeat) return { ok: false, why: repeat };
  await supersede(chat, "hangman");
  await query(
    `insert into games (chat, type, status, data, started_by)
     values ($1, 'hangman', 'active', $2::jsonb, $3)`,
    [
      chat,
      JSON.stringify({ secret: word, guessedLetters: [], misses: 0, maxMisses: MAX_HANGMAN_MISSES }),
      startedBy,
    ],
  );
  return { ok: true };
};

const renderHangman = (data: HangmanData): string => {
  const guessed = new Set(data.guessedLetters);
  const masked = [...data.secret].map((ch) => (guessed.has(fold(ch)) ? ch : "_")).join(" ");
  const letters = data.guessedLetters.length ? data.guessedLetters.join(", ") : "ninguna";
  return `${masked}\nLetras probadas: ${letters}\nFallos: ${data.misses}/${data.maxMisses}`;
};

const guessHangman = async (chat: string, guessText: string): Promise<GuessResult> => {
  const row = await activeRow(chat, "hangman");
  if (!row) return { ok: false, why: "No hay ahorcado activo en este chat." };

  const data = row.data as unknown as HangmanData;
  const secretFold = fold(data.secret);
  const guessFold = fold(guessText);
  if (!guessFold) return { ok: false, why: "Manda una letra o intenta la palabra completa." };

  // A single letter.
  if ([...guessFold].length === 1) {
    if (data.guessedLetters.includes(guessFold)) {
      return {
        ok: true,
        correct: true,
        over: false,
        message: `Esa letra ya la habian probado.\n${renderHangman(data)}`,
      };
    }
    const hit = secretFold.includes(guessFold);
    const guessedLetters = [...data.guessedLetters, guessFold];
    const misses = hit ? data.misses : data.misses + 1;
    const updated: HangmanData = { ...data, guessedLetters, misses };
    const won = [...secretFold].every((ch) => guessedLetters.includes(ch));
    const lost = !won && misses >= data.maxMisses;

    if (won || lost) {
      await query(
        `update games set status = 'finished', data = $2::jsonb, finished_at = now(), updated_at = now() where id = $1`,
        [row.id, JSON.stringify({ ...updated, outcome: won ? "won" : "lost" })],
      );
      return {
        ok: true,
        correct: hit,
        over: true,
        message: won
          ? `La sacaron! Era ${data.secret}.\n${renderHangman(updated)}`
          : `Se acabaron los intentos. Era ${data.secret}.\n${renderHangman(updated)}`,
      };
    }

    await query(`update games set data = $2::jsonb, updated_at = now() where id = $1`, [
      row.id,
      JSON.stringify(updated),
    ]);
    return { ok: true, correct: hit, over: false, message: renderHangman(updated) };
  }

  // A whole-word guess.
  if (guessFold === secretFold) {
    const updated: HangmanData = { ...data, guessedLetters: [...secretFold] };
    await query(
      `update games set status = 'finished', data = $2::jsonb, finished_at = now(), updated_at = now() where id = $1`,
      [row.id, JSON.stringify({ ...updated, outcome: "won" })],
    );
    return { ok: true, correct: true, over: true, message: `Si! Era ${data.secret}.` };
  }

  const misses = data.misses + 1;
  const lost = misses >= data.maxMisses;
  const updated: HangmanData = { ...data, misses };
  if (lost) {
    await query(
      `update games set status = 'finished', data = $2::jsonb, finished_at = now(), updated_at = now() where id = $1`,
      [row.id, JSON.stringify({ ...updated, outcome: "lost" })],
    );
    return { ok: true, correct: false, over: true, message: `No. Se acabaron los intentos -- era ${data.secret}.` };
  }
  await query(`update games set data = $2::jsonb, updated_at = now() where id = $1`, [
    row.id,
    JSON.stringify(updated),
  ]);
  return { ok: true, correct: false, over: false, message: `Esa palabra no es.\n${renderHangman(updated)}` };
};

// -- Adivinanzas ----------------------------------------------------------------

type RiddleData = { riddle: string; answer: string; hint: string | null; attempts: number };

export const startRiddle = async (
  chat: string,
  startedBy: string,
  riddle: string,
  answer: string,
  hint?: string,
): Promise<{ ok: true } | { ok: false; why: string }> => {
  const repeat = await repeatOf(chat, answer);
  if (repeat) return { ok: false, why: repeat };
  await supersede(chat, "riddle");
  await query(
    `insert into games (chat, type, status, data, started_by)
     values ($1, 'riddle', 'active', $2::jsonb, $3)`,
    [chat, JSON.stringify({ riddle, answer, hint: hint ?? null, attempts: 0 }), startedBy],
  );
  return { ok: true };
};

const guessRiddle = async (chat: string, guessText: string): Promise<GuessResult> => {
  const row = await activeRow(chat, "riddle");
  if (!row) return { ok: false, why: "No hay una adivinanza activa en este chat." };

  const data = row.data as unknown as RiddleData;
  const guessFold = fold(guessText);
  const answerFold = fold(data.answer);
  /**
   * A riddle's answer is a word or two, and a real answer rarely arrives spelled exactly like it
   * was stored — "el sol" versus "sol". Equality or containment either way covers the common
   * case; it is deliberately not a semantic check, so a genuinely different word that happens to
   * share a substring can pass. Light, on purpose — see the module note.
   */
  const correct =
    guessFold.length >= 3 &&
    (guessFold === answerFold || answerFold.includes(guessFold) || guessFold.includes(answerFold));

  if (correct) {
    await query(
      `update games set status = 'finished', data = data || '{"outcome":"won"}'::jsonb, finished_at = now(), updated_at = now()
        where id = $1`,
      [row.id],
    );
    return { ok: true, correct: true, over: true, message: `Correcto! Era: ${data.answer}` };
  }

  const attempts = (data.attempts ?? 0) + 1;
  await query(`update games set data = data || $2::jsonb, updated_at = now() where id = $1`, [
    row.id,
    JSON.stringify({ attempts }),
  ]);
  return { ok: true, correct: false, over: false, message: "No es esa. Sigue intentando." };
};

// -- Shared: guessing, ending, status -------------------------------------------

export type GuessResult =
  | { ok: false; why: string }
  | { ok: true; correct: boolean; over: boolean; message: string };

/**
 * Dispatches to the right game's guess-checking, and nowhere else decides whether a guess is
 * right — every branch above reads the row this function reads, never the model's own say-so.
 */
export const guessGame = (
  chat: string,
  type: GuessableType,
  guesserName: string,
  guessText: string,
): Promise<GuessResult> => {
  if (type === "who_said_it") return guessWhoSaidIt(chat, guesserName, guessText);
  if (type === "hangman") return guessHangman(chat, guessText);
  return guessRiddle(chat, guessText);
};

/** Give up, or force a reveal. Always ends the round and always says what the answer was. */
export const endGame = async (
  chat: string,
  type: GameType,
): Promise<{ ok: true; message: string } | { ok: false; why: string }> => {
  const row = await activeRow(chat, type);
  if (!row) return { ok: false, why: `No hay ${LABEL[type]} activo en este chat.` };

  let message: string;
  if (type === "who_said_it") {
    const data = row.data as unknown as WhoSaidItData;
    message = `Nadie la saco. Era ${data.senderName}: "${data.text}"`;
  } else if (type === "hangman") {
    const data = row.data as unknown as HangmanData;
    message = `Ahorcado cerrado. La palabra era ${data.secret}.`;
  } else if (type === "riddle") {
    const data = row.data as unknown as RiddleData;
    message = `Adivinanza cerrada. La respuesta era: ${data.answer}`;
  } else {
    const data = row.data as unknown as WordOfDayEntry;
    message = data.answer ? `Cerrado. La respuesta era: ${data.answer}` : "Cerrado.";
  }

  await query(
    `update games set status = 'finished', data = data || '{"outcome":"revealed"}'::jsonb, finished_at = now(), updated_at = now()
      where id = $1`,
    [row.id],
  );
  return { ok: true, message };
};

/** A read-only look at whatever is going on for this type, without changing anything. */
export const gameStatus = async (
  chat: string,
  type: GameType,
): Promise<{ active: boolean; message: string }> => {
  const row = await activeRow(chat, type);

  if (!row) {
    // Worth showing even once closed, so "cual era la palabra de hoy?" still works after a
    // reveal — nothing else about word_of_day is guessable, so this is not a spoiler.
    if (type === "word_of_day") {
      const rows = await query<Row>(
        `select id, chat, type, status, data, started_by
           from games where chat = $1 and type = 'word_of_day'
           order by id desc limit 1`,
        [chat],
      );
      const last = rows[0];
      if (last) {
        const data = last.data as unknown as WordOfDayEntry;
        return { active: last.status === "active", message: data.prompt };
      }
    }
    return { active: false, message: `No hay ${LABEL[type]} activo en este chat.` };
  }

  if (type === "hangman") {
    return { active: true, message: renderHangman(row.data as unknown as HangmanData) };
  }
  if (type === "riddle") {
    const data = row.data as unknown as RiddleData;
    return { active: true, message: `${data.riddle}${data.hint ? `\nPista: ${data.hint}` : ""}` };
  }
  if (type === "who_said_it") {
    const data = row.data as unknown as WhoSaidItData;
    return {
      active: true,
      message: `"${data.text}"\n${(data.guesses ?? []).length} intento(s) hasta ahora.`,
    };
  }
  const data = row.data as unknown as WordOfDayEntry;
  return { active: true, message: data.prompt };
};
