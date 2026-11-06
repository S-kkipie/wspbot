import type { Metadata } from "next";
import Link from "next/link";
import { FEATURES, ALWAYS } from "@/lib/features";
import * as roadmap from "@/lib/roadmap";

/**
 * wspbot's own mark — the same speech bubble as the favicon and the app icon, drawn inline.
 *
 * Without its tile: the icon carries an obsidian tile so it reads as an app icon on someone
 * else's home screen, and this page is already obsidian, so the tile would only be a square of
 * the background sitting inside the background.
 */
function AppIcon({ size = 22 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label="wspbot"
      style={{ display: "block", flex: "none", color: "var(--gold)" }}
    >
      <path d="M6 4H18A3 3 0 0 1 21 7V13A3 3 0 0 1 18 16H14L9 20V16H6A3 3 0 0 1 3 13V7A3 3 0 0 1 6 4Z" />
    </svg>
  );
}
import "./landing.css";

/**
 * The public landing page — the one page in this app that is not behind the sign-in.
 *
 * Forged gold as the only accent, obsidian and titanium as the resting state, Geist throughout,
 * and one motion rule, which is a real constraint
 * rather than a slogan — *motion reveals state, never decorates*. So the hero stages a
 * conversation the way one actually happens rather than animating for its own sake, and the only
 * thing that keeps moving is the status dot, because that reports something true.
 *
 * The capability list is read from `lib/features.ts` rather than written out again here. That
 * registry already exists to stop this exact list rotting in three places at once; a landing page
 * quietly advertising an ability that was removed is the same bug wearing a nicer typeface.
 */

export const metadata: Metadata = {
  title: "wspbot — tag it, it answers",
  description:
    "A WhatsApp bot for group chats. It searches, remembers, makes stickers, keeps the checklist, and posts a digest of what you missed. Made by Skkippie.",
  openGraph: {
    title: "wspbot — tag it, it answers",
    description:
      "A WhatsApp bot for group chats. It searches, remembers, makes stickers, keeps the checklist, and posts a digest of what you missed.",
    url: "https://wspbot.aido.lat",
    siteName: "wspbot",
    type: "website",
  },
};

/**
 * The vote counts make this page database-backed, where it used to be fully static. Five minutes
 * of staleness on a tally is invisible; what it buys is that the landing page stays fast and
 * stays up when Postgres does not — which matters, because it is the one route that has no other
 * job than being readable.
 */
export const revalidate = 300;

const SOURCE = "https://github.com/S-kkipie/wspbot";

/** The bot is open source. */
const REPOS: { name: string; href: string; body: string }[] = [
  {
    name: "S-kkipie/wspbot",
    href: SOURCE,
    body: "This bot. The webhook, the turn, every tool, the dashboard and the checks that keep it honest.",
  },
];

/** The conversation in the hero. Every line is something the bot genuinely does. */
const THREAD: { who?: string; bot?: boolean; digest?: boolean; body: React.ReactNode }[] = [
  {
    who: "Ana",
    body: (
      <>
        <span className="tag">@wspbot</span> ¿va a llover el viernes en Lima?
      </>
    ),
  },
  { bot: true, body: "Nublado, 18–22°C. Sin lluvia prevista." },
  {
    who: "Beto",
    body: (
      <>
        <span className="tag">@wspbot</span> recuérdame a las 9 mandar la factura
      </>
    ),
  },
  { bot: true, body: "Listo — mañana 09:00." },
  {
    bot: true,
    digest: true,
    body: (
      <>
        <b>Ayer en Deploy</b>
        {"\n"}· Ana arregla el bug del login hoy
        {"\n"}· Deploy confirmado: viernes 15:00
        {"\n"}· Abierto: ¿migramos la base antes?
      </>
    ),
  },
];

const STEPS: { title: string; body: string }[] = [
  {
    title: "Add it to a group",
    body: "It sits there quietly. No tag, no reply — a bot that answers everything is a bot people mute.",
  },
  {
    title: "Tag it",
    body: "Ask in plain language, in your language. Reply to a message and tag it, and it reads what you pointed at — the picture included.",
  },
  {
    title: "It gets on with it",
    body: "Searching, remembering, drawing a sticker, setting a reminder, writing the digest. You configure what it may do from the dashboard.",
  },
];

export default async function Landing() {
  /*
   * Never fatal: a landing page that 500s because the roadmap could not be read would be a worse
   * outcome than one that simply does not show it.
   */
  const items = await roadmap.list().catch(() => []);
  const open = items.filter((i) => i.state === "open").slice(0, 5);
  const shipped = items.filter((i) => i.state === "shipped").slice(0, 3);
  const most = Math.max(1, ...open.map((i) => i.weight));

  return (
    <div className="lp">
      <div className="lp-wrap">
        <header className="lp-nav">
          <span className="lp-mark">
            <AppIcon size={22} />
            wspbot<span className="lp-dot">.</span>
          </span>
          <nav>
            <a href={SOURCE} target="_blank" rel="noreferrer">
              Source
            </a>
            <Link href="/dashboard" className="lp-signin">
              Sign in
            </Link>
          </nav>
        </header>

        <section className="lp-hero">
          <div className="lp-hero-copy">
            <p className="lp-eyebrow" style={{ "--i": 0 } as React.CSSProperties}>
              Skkippie · WhatsApp
            </p>
            <h1 className="lp-display" style={{ "--i": 1 } as React.CSSProperties}>
              Tag it.
              <br />
              It answers<span className="lp-dot">.</span>
            </h1>
            <p className="lp-sub" style={{ "--i": 2 } as React.CSSProperties}>
              A bot that earns its place in the group chat. It searches when being wrong would
              matter, remembers what you tell it to, makes the sticker, keeps the list — and
              posts a digest of everything you missed.
            </p>
            <div className="lp-actions" style={{ "--i": 3 } as React.CSSProperties}>
              <Link href="/dashboard" className="lp-btn">
                Open the dashboard
              </Link>
              <a href={SOURCE} className="lp-btn ghost" target="_blank" rel="noreferrer">
                Read the source
              </a>
            </div>
            <p className="lp-status" style={{ "--i": 4 } as React.CSSProperties}>
              <span className="lp-pulse" aria-hidden="true" />
              running at wspbot.aido.lat
            </p>
          </div>

          <div className="lp-thread" aria-label="An example conversation">
            <div className="lp-thread-head">
              <span className="lp-avatar">
                <AppIcon size={16} />
              </span>
              Deploy · 6 members
            </div>
            {THREAD.map((m, i) => (
              <div
                key={i}
                className={`lp-msg${m.bot ? " bot" : ""}${m.digest ? " digest" : ""}`}
                style={{ "--i": i } as React.CSSProperties}
              >
                {m.who && <span className="who">{m.who}</span>}
                {m.body}
              </div>
            ))}
          </div>
        </section>
      </div>

      <div className="lp-wrap">
        <section className="lp-section lp-reveal">
          <p className="lp-kicker">What it does</p>
          <h2 className="lp-h2">Everything, switchable, one at a time.</h2>
          <p className="lp-lead">
            Each of these is a switch on the dashboard. Turning one off takes its tools away from
            the model and the instructions with them, so the bot says the thing is off rather
            than offering to do it.
          </p>
          <ul className="lp-grid">
            {ALWAYS.map((f) => (
              <li key={f.title} className="core">
                <h3>{f.title}</h3>
                <p>{f.detail}</p>
              </li>
            ))}
            {FEATURES.map((f) => (
              <li key={f.key}>
                <h3>{f.title}</h3>
                <p>{f.detail}</p>
              </li>
            ))}
          </ul>
        </section>

        <section className="lp-section lp-reveal">
          <p className="lp-kicker">How it works</p>
          <h2 className="lp-h2">Three steps, then it is somebody else&apos;s problem.</h2>
          <ol className="lp-steps">
            {STEPS.map((s) => (
              <li key={s.title}>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
              </li>
            ))}
          </ol>
          <div className="lp-pipeline">
            {"WhatsApp  ──▶  "}
            <b>wapi</b>
            {"  ──▶  webhook  ──▶  "}
            <b>the model</b>
            {"  ──▶  back to the chat\n"}
            {"                            └─▶  Postgres · ffmpeg · web search"}
          </div>
        </section>

        {(open.length > 0 || shipped.length > 0) && (
          <section className="lp-section lp-reveal">
            <p className="lp-kicker">What's next</p>
            <h2 className="lp-h2">Supporters decide the order.</h2>
            <p className="lp-lead">
              Anyone who has chipped in can back what gets built next, weighted by how much — and
              capped, so nobody owns the list. Vote by asking the bot.
            </p>

            {open.length > 0 && (
              <ul className="lp-roadmap">
                {open.map((item) => (
                  <li key={item.id}>
                    <div className="lp-road-head">
                      <span>{item.title}</span>
                      <span className="lp-road-count">
                        {item.weight} <span aria-hidden="true">★</span>
                      </span>
                    </div>
                    {/* Relative to the leader, so the bars compare rather than measure. */}
                    <div className="lp-bar">
                      <span style={{ width: `${Math.round((item.weight / most) * 100)}%` }} />
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {shipped.length > 0 && (
              <p className="lp-shipped">
                Shipped:{" "}
                {shipped.map((s, i) => (
                  <span key={s.id}>
                    {i > 0 && " · "}
                    {s.title}
                  </span>
                ))}
              </p>
            )}
          </section>
        )}

        <section className="lp-section lp-reveal">
          <p className="lp-kicker">Open source</p>
          <h2 className="lp-h2">Both halves are yours to read.</h2>
          <p className="lp-lead">
            Run your own, take a piece, or send a change. A star is the only thing either project
            asks for.
          </p>
          <ul className="lp-repos">
            {REPOS.map((r) => (
              <li key={r.name}>
                <a href={r.href} target="_blank" rel="noreferrer">
                  <span className="lp-repo-name">
                    {r.name}
                    <span className="lp-star" aria-hidden="true">
                      ★
                    </span>
                  </span>
                  <span>{r.body}</span>
                </a>
              </li>
            ))}
          </ul>

        </section>

        <footer className="lp-footer">
          <span>Made by Skkippie, in Lima.</span>
          <span>
            <a href={SOURCE} target="_blank" rel="noreferrer">
              github.com/S-kkipie/wspbot
            </a>
          </span>
        </footer>
      </div>
    </div>
  );
}
