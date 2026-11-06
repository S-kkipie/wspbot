/**
 * Group games, against a real database. No model calls — the same spirit as `chime-check` and
 * `recap-check`: what is worth pinning down here is SQL, arithmetic and string-folding, not
 * prose. What would actually cost something if it broke:
 *
 * - **The secret never comes from the model's own say-so.** Every guess-checking function reads
 *   the `games` row it was given, never trusts an argument that claims to already know the
 *   answer. This is the property the whole design leans on — see the module comment in
 *   `lib/games.ts` — so it gets checked directly rather than assumed.
 * - **One active game per chat per type**, both as application logic (`supersede`, called before
 *   every insert) and as the database's own guarantee (`games_one_active_per_type`). Losing
 *   either would let two rounds of the same game race each other's state.
 * - **¿Quién dijo esto? only ever reads this chat's own log**, skips single-word lines, and
 *   prefers older ones when there is a choice — the three things standing between "a real quote
 *   from this group" and either an empty game or a spoiler of something said thirty seconds ago.
 * - **The daily word/challenge claim** guards the same way `recap`'s Sunday claim does: a tick
 *   firing twice in the same minute must not post the same day's word twice.
 * - **Accent-folding treats Ñ as its own letter.** "año" and "ano" are different words, and a
 *   fold that flattened one into the other would make a guess of either count as the other.
 *
 * Needs DATABASE_URL; never calls the model, so it costs nothing.
 *
 *   npm run games-check
 */

import { query } from "../lib/db.js";
import { config } from "../lib/config.js";
import * as cron from "../lib/cron.js";
import * as games from "../lib/games.js";

let failures = 0;
const check = (label: string, pass: boolean, detail = "") => {
  if (!pass) failures++;
  console.log(pass ? "  PASS" : "  FAIL", label, detail);
};

const CHAT = "000000000000000000@g.us-games-check";
const CHAT_WOD = "000000000000000001@g.us-games-check-wod";

const cleanup = async () => {
  await query("delete from games where chat = any($1)", [[CHAT, CHAT_WOD]]);
  await query("delete from logged_messages where chat = $1", [CHAT]);
  await query("delete from chime_settings where chat = any($1)", [[CHAT, CHAT_WOD]]);
};

const say = async (sender: string, senderName: string, text: string, agoMinutes: number) => {
  await query(
    `insert into logged_messages (chat, message_id, sender, sender_name, kind, text, at, urls)
     values ($1, $2, $3, $4, 'text', $5, $6, '{}')`,
    [
      CHAT,
      `games-check-${Date.now()}-${Math.random()}`,
      sender,
      senderName,
      text,
      new Date(Date.now() - agoMinutes * 60 * 1000),
    ],
  );
};

await cleanup();

try {
  // -- accent folding --------------------------------------------------
  console.log("\nfolding accents:");
  check("strips an ordinary accent", games.fold("café") === "CAFE");
  check("keeps N-with-tilde distinct from a plain N", games.fold("año") !== games.fold("ano"));
  check("case-insensitive", games.fold("José") === games.fold("JOSE"));
  check("trims whitespace", games.fold("  hola  ") === "HOLA");

  // -- who said it: no log yet ------------------------------------------
  console.log("\nwho said it, with nothing logged yet:");
  const emptyStart = await games.startWhoSaidIt(CHAT, "tester");
  check("refuses rather than inventing a line", !emptyStart.ok);

  // -- who said it: picking a line ---------------------------------------
  console.log("\nwho said it, picking a real line:");
  await say("111@s.whatsapp.net", "Ana", "jaja", 200); // trivial, one token — must be skipped
  await say("222@s.whatsapp.net", "Beto", "https://example.com/x", 200); // a bare link — skipped
  await say("333@s.whatsapp.net", "Cami", "hoy si hizo un calor tremendo en el centro", 200); // old, real
  await say("444@s.whatsapp.net", "Deyvis", "recien llegue a la casa cansadisimo", 1); // recent, real

  const started = await games.startWhoSaidIt(CHAT, "tester");
  check("finds a real line once one exists", started.ok);
  if (started.ok) {
    check(
      "never picks the trivial one-word line",
      started.text !== "jaja",
      `— picked "${started.text}"`,
    );
    check(
      "never picks the bare link",
      started.text !== "https://example.com/x",
      `— picked "${started.text}"`,
    );
    check(
      "prefers the older real line over the fresh one when both qualify",
      started.text === "hoy si hizo un calor tremendo en el centro",
      `— picked "${started.text}"`,
    );
  }

  const activeRows = await query<{ id: string }>(
    "select id from games where chat = $1 and type = 'who_said_it' and status = 'active'",
    [CHAT],
  );
  check("exactly one active round after starting", activeRows.length === 1);

  // -- who said it: guessing -----------------------------------------------
  console.log("\nwho said it, guessing:");
  const wrongGuess = await games.guessGame(CHAT, "who_said_it", "Zoe", "Beto");
  check("a wrong guess is rejected", wrongGuess.ok && !wrongGuess.correct);
  const stillActive = await query<{ id: string }>(
    "select id from games where chat = $1 and type = 'who_said_it' and status = 'active'",
    [CHAT],
  );
  check("a wrong guess does not end the round", stillActive.length === 1);

  const rightGuess = await games.guessGame(CHAT, "who_said_it", "Zoe", "cami");
  check(
    "a correct guess is accepted, case-insensitive and by first name",
    rightGuess.ok && rightGuess.correct,
    `— ${JSON.stringify(rightGuess)}`,
  );
  const finishedRows = await query<{ status: string }>(
    "select status from games where chat = $1 and type = 'who_said_it' order by id desc limit 1",
    [CHAT],
  );
  check("the round is finished after a correct guess", finishedRows[0]?.status === "finished");

  const tally = await games.whoSaidItTally(CHAT);
  check("the tally now credits the winner", tally.includes("Zoe"), `— "${tally}"`);

  // -- one active per type: starting again supersedes --------------------
  console.log("\nsuperseding on restart:");
  await say("333@s.whatsapp.net", "Cami", "otra frase larga que sirve como segunda linea", 200);
  await games.startWhoSaidIt(CHAT, "tester");
  const afterRestart = await query<{ status: string }>(
    "select status from games where chat = $1 and type = 'who_said_it' order by id",
    [CHAT],
  );
  check(
    "exactly one active row, the rest finished",
    afterRestart.filter((r) => r.status === "active").length === 1,
    `— ${JSON.stringify(afterRestart.map((r) => r.status))}`,
  );

  // -- the database's own guarantee ---------------------------------------
  console.log("\nthe unique index itself:");
  let constraintHeld = false;
  try {
    await query(
      `insert into games (chat, type, status, data) values ($1, 'who_said_it', 'active', '{}'::jsonb)`,
      [CHAT],
    );
  } catch (err) {
    constraintHeld = /duplicate key|unique/i.test(err instanceof Error ? err.message : String(err));
  }
  check("a second active row of the same type is rejected at the database", constraintHeld);

  // -- hangman ---------------------------------------------------------------
  console.log("\nhangman:");
  const badWord = await games.startHangman(CHAT, "tester", "dos palabras");
  check("refuses a word with a space", !badWord.ok);
  const okWord = await games.startHangman(CHAT, "tester", "manzana");
  check("accepts a real word", okWord.ok);

  const beforeAnyGuess = await games.gameStatus(CHAT, "hangman");
  check("starts fully blank", !beforeAnyGuess.message.includes("m"), beforeAnyGuess.message);

  const hitLetter = await games.guessGame(CHAT, "hangman", "tester", "a");
  check("a letter that is in the word is a hit", hitLetter.ok && hitLetter.correct);
  const repeatLetter = await games.guessGame(CHAT, "hangman", "tester", "a");
  check("guessing the same letter again does not cost a miss", repeatLetter.ok);
  const missRow1 = await query<{ data: { misses: number } }>(
    "select data from games where chat = $1 and type = 'hangman' and status = 'active'",
    [CHAT],
  );
  check("misses did not increase on the repeat", missRow1[0]?.data.misses === 0, `— ${JSON.stringify(missRow1[0]?.data)}`);

  const missLetter = await games.guessGame(CHAT, "hangman", "tester", "k");
  check("a letter that is not in the word is a miss", missLetter.ok && !missLetter.correct);
  const missRow2 = await query<{ data: { misses: number } }>(
    "select data from games where chat = $1 and type = 'hangman' and status = 'active'",
    [CHAT],
  );
  check("misses increased by one", missRow2[0]?.data.misses === 1, `— ${JSON.stringify(missRow2[0]?.data)}`);

  const wholeWordWin = await games.guessGame(CHAT, "hangman", "tester", "manzana");
  check("guessing the whole word right wins outright", wholeWordWin.ok && wholeWordWin.correct && wholeWordWin.over);
  const wonRow = await query<{ status: string }>(
    "select status from games where chat = $1 and type = 'hangman' order by id desc limit 1",
    [CHAT],
  );
  check("the round is marked finished", wonRow[0]?.status === "finished");

  console.log("\nhangman, losing:");
  await games.startHangman(CHAT, "tester", "xilofono");
  for (const letter of ["q", "w", "k", "j", "v", "b"]) {
    await games.guessGame(CHAT, "hangman", "tester", letter);
  }
  const lostRow = await query<{ status: string; data: { outcome: string; misses: number } }>(
    "select status, data from games where chat = $1 and type = 'hangman' order by id desc limit 1",
    [CHAT],
  );
  check(
    "six misses ends the round as a loss",
    lostRow[0]?.status === "finished" && lostRow[0]?.data.outcome === "lost",
    `— ${JSON.stringify(lostRow[0])}`,
  );
  const statusAfterLoss = await games.gameStatus(CHAT, "hangman");
  check("no active hangman remains to ask about", !statusAfterLoss.active);

  // -- riddle -----------------------------------------------------------------
  console.log("\nriddle:");
  await games.startRiddle(CHAT, "tester", "Vuela sin alas, silba sin boca.", "el viento", "es invisible");
  const wrongRiddle = await games.guessGame(CHAT, "riddle", "tester", "un pajaro");
  check("a wrong answer is rejected", wrongRiddle.ok && !wrongRiddle.correct);
  const rightRiddle = await games.guessGame(CHAT, "riddle", "tester", "viento");
  check(
    "a right answer is accepted even without the article",
    rightRiddle.ok && rightRiddle.correct,
    `— ${JSON.stringify(rightRiddle)}`,
  );

  // -- ending and status ---------------------------------------------------
  console.log("\nending a game:");
  await games.startRiddle(CHAT, "tester", "Otra adivinanza cualquiera.", "una respuesta");
  const ended = await games.endGame(CHAT, "riddle");
  check("ending reveals the answer", ended.ok && ended.message.includes("una respuesta"), `— ${JSON.stringify(ended)}`);
  const endedTwice = await games.endGame(CHAT, "riddle");
  check("ending again finds nothing to end", !endedTwice.ok);

  // -- word of day -------------------------------------------------------------
  console.log("\npalabra/reto del dia:");
  await games.startWordOfDay(CHAT, "SkkippIA", { kind: "word", prompt: "hoy: *jarana* — una fiesta con musica y baile." });
  const wodStatus = await games.gameStatus(CHAT, "word_of_day");
  check("shows today's entry", wodStatus.message.includes("jarana"));
  await games.endGame(CHAT, "word_of_day");
  const wodAfterEnd = await games.gameStatus(CHAT, "word_of_day");
  check(
    "still shows the same entry once closed, rather than 'nothing active'",
    wodAfterEnd.message.includes("jarana") && !wodAfterEnd.active,
    `— ${JSON.stringify(wodAfterEnd)}`,
  );

  // -- repeats -------------------------------------------------------------------
  /*
   * Every round is invented by a model that never sees the earlier ones, so left alone it posts
   * the single most famous riddle again and again ("un mapa" was most days in one group). What
   * this chat already had is the database's to remember, and a repeat is refused the same way a
   * bad hangman word is: with a reason the model can act on.
   */
  console.log("\nrepeats:");
  const answers = await games.recentAnswers(CHAT);
  check(
    "recent answers cover riddles, hangman and the word of the day",
    ["el viento", "manzana", "jarana"].every((a) => answers.includes(a)),
    `— ${JSON.stringify(answers)}`,
  );
  const sameRiddle = await games.startRiddle(CHAT, "tester", "Sopla y no se ve.", "Viento");
  check("a riddle with an answer this chat already had is refused", !sameRiddle.ok, `— ${JSON.stringify(sameRiddle)}`);
  check(
    "and the refusal names what to avoid",
    !sameRiddle.ok && sameRiddle.why.includes("viento"),
    `— ${JSON.stringify(sameRiddle)}`,
  );
  const sameWord = await games.startWordOfDay(CHAT, "SkkippIA", { kind: "word", prompt: "*Jarana*: fiesta, juerga." });
  check("so is a word of the day this chat already had, read from its bold", !sameWord.ok);
  const sameChallenge = await games.startWordOfDay(CHAT, "SkkippIA", {
    kind: "challenge",
    prompt: "¿Qué sopla sin boca?",
    answer: "El viento.",
  });
  check("and a challenge whose answer was a riddle's, article and full stop aside", !sameChallenge.ok);
  const sameSecret = await games.startHangman(CHAT, "tester", "MANZANA");
  check("and a hangman word used before", !sameSecret.ok);
  const fresh = await games.startRiddle(CHAT, "tester", "Tiene dientes y no come.", "el peine");
  check("a new answer is still welcome", fresh.ok, `— ${JSON.stringify(fresh)}`);
  const elsewhere = await games.recentAnswers(CHAT_WOD);
  check("and one chat's history never limits another's", !elsewhere.includes("el peine"));

  // -- the daily claim -----------------------------------------------------------
  console.log("\nthe daily word/challenge claim:");
  await query(
    `insert into chime_settings (chat, chat_name) values ($1, 'games-check-wod') on conflict (chat) do nothing`,
    [CHAT_WOD],
  );
  const pattern = cron.parse(games.WORD_OF_DAY_CRON);
  const next9am = cron.nextRuns(pattern, config.timezone(), 1)[0]!;

  const firstClaim = await games.claimWordOfDayDue(next9am);
  check("a chime-enabled group is due at the next 09:00", firstClaim.some((d) => d.chat === CHAT_WOD));

  const secondClaim = await games.claimWordOfDayDue(next9am);
  check("claiming the same minute again finds nothing", !secondClaim.some((d) => d.chat === CHAT_WOD));

  const fiveMinutesLater = new Date(next9am.getTime() + 5 * 60 * 1000);
  const offMinute = await games.claimWordOfDayDue(fiveMinutesLater);
  check("five minutes later the pattern no longer matches", !offMinute.some((d) => d.chat === CHAT_WOD));

  await query("update chime_settings set enabled = false where chat = $1", [CHAT_WOD]);
  const nextDay = new Date(next9am.getTime() + 24 * 3600 * 1000);
  const disabledClaim = await games.claimWordOfDayDue(nextDay);
  check("a disabled group is never claimed", !disabledClaim.some((d) => d.chat === CHAT_WOD));
} finally {
  await cleanup();
  console.log("cleaned up");
}

console.log(failures === 0 ? "\nall checks passed\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
