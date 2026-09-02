/**
 * Checks that the configured models exist and accept the exact parameters this app sends.
 *
 * Switching models is cheap to do and easy to get subtly wrong: a tier may not be enabled on the
 * account, or may reject `reasoningEffort`, `textVerbosity`, structured output, image input, or —
 * under Gemini — the flat chroma-key backdrop `lib/provider.ts` `drawImage` relies on for
 * transparency. Each of those fails at the worst moment — mid-conversation — so they are
 * exercised here instead.
 *
 * Tests whichever provider `AI_PROVIDER` in `.env` names (default: google, matching
 * `lib/config.ts`). The two providers do not accept the same shape of call — Gemini rejects
 * combining its own tools with function tools in one request, and has no
 * transparent-background option at all — so the checks below branch rather than pretending one
 * shape covers both.
 *
 * Costs a few small calls plus one image generation, so it is opt-in:
 *   npm run models-check
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateText, generateObject, generateImage, tool, stepCountIs } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { z } from "zod";
import { dropChromaKey } from "../lib/sticker-maker.js";

const env = Object.fromEntries(
  readFileSync("C:/Users/Ignac/Documentos/Github/wspbot/.env", "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.startsWith("#") && l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);

const PROVIDER = env["AI_PROVIDER"] ?? "google";
const isGoogle = PROVIDER === "google";

const openai = createOpenAI({ apiKey: env["OPENAI_API_KEY"] ?? "" });
const google = createGoogleGenerativeAI({ apiKey: env["GEMINI_API_KEY"] ?? "" });
const chat = (id: string) => (isGoogle ? google(id) : openai(id));

const CHAT = env["BOT_MODEL"] ?? (isGoogle ? "gemini-2.5-flash" : "gpt-5.6");
const VISION = env["BOT_VISION_MODEL"] ?? CHAT;
const IMAGE = env["BOT_IMAGE_MODEL"] ?? (isGoogle ? "gemini-2.5-flash-image" : "gpt-image-1");

const CHROMA_KEY = "0xFF00FF";
const GOOGLE_IMAGE_STYLE =
  "Background: a single solid flat colour filling every pixel behind the subject, pure magenta, " +
  "hex FF00FF, RGB 255/0/255, with no gradient, no shading and no other colour in it anywhere.";

let failures = 0;
const ok = (label: string, detail = "") => console.log("  PASS", label, detail);
const bad = (label: string, err: unknown) => {
  failures++;
  console.log("  FAIL", label, "—", err instanceof Error ? err.message.slice(0, 160) : String(err));
};

const main = async () => {
  console.log(`\nprovider: ${PROVIDER}`);

  console.log(`\nchat model: ${CHAT}`);
  try {
    const ping = tool({
      description: "Returns pong.",
      inputSchema: z.object({}),
      execute: async () => "pong",
    });
    /**
     * The same shape a real turn sends — but the shape differs by provider. OpenAI rides its own
     * web-search tool alongside the model's function tools in one call; Gemini rejects that
     * combination outright, which is why `lib/provider.ts` `webSearchTool` wraps Gemini's search
     * (Exa, or an isolated grounding sub-call) behind a normal function tool rather than handing
     * the model `google.tools.googleSearch` directly. So the Google branch tests what the app
     * actually sends in the outer turn: function tools and a thinking budget, no provider-defined
     * tool riding along.
     */
    const result = isGoogle
      ? await generateText({
          model: chat(CHAT),
          system: "You are terse.",
          messages: [{ role: "user", content: "Use the ping tool, then say the word done." }],
          tools: { ping },
          stopWhen: stepCountIs(4),
          providerOptions: { google: { thinkingConfig: { thinkingBudget: 1024 } } },
        })
      : await generateText({
          model: chat(CHAT),
          system: "You are terse.",
          messages: [{ role: "user", content: "Use the ping tool, then say the word done." }],
          tools: { web_search: openai.tools.webSearch({ searchContextSize: "medium" }), ping },
          stopWhen: stepCountIs(4),
          providerOptions: {
            openai: { reasoningEffort: env["BOT_EFFORT"] ?? "low", textVerbosity: "low" },
          },
        });
    ok(
      isGoogle
        ? "accepts function tools and a thinking budget"
        : "accepts tools, web search, effort and verbosity",
      `(${result.usage.outputTokens} out)`,
    );
    if (result.text.trim()) ok("produced text after the tool call", JSON.stringify(result.text.slice(0, 40)));
    else bad("produced text after the tool call", "empty");
  } catch (err) {
    bad("chat model", err);
  }

  console.log(`\nvision model: ${VISION}`);
  try {
    const dir = mkdtempSync(join(tmpdir(), "models-check-"));
    const png = join(dir, "in.png");
    execFileSync("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc=size=256x256:rate=1:duration=1",
      "-frames:v", "1", png,
    ]);
    // Exactly the sticker-description call: structured output over an image.
    const { object, usage } = await generateObject({
      model: chat(VISION),
      schema: z.object({ label: z.string(), description: z.string() }),
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Name and describe this image in a few words." },
            { type: "file", data: readFileSync(png), mediaType: "image/png" },
          ],
        },
      ],
    });
    ok("accepts image input with structured output", `(${usage.outputTokens} out)`);
    ok("returned an object", JSON.stringify(object.label.slice(0, 30)));
  } catch (err) {
    bad("vision model", err);
  }

  console.log(`\nimage model: ${IMAGE}`);
  try {
    if (isGoogle) {
      // Gemini has no transparent-background option at all — see lib/provider.ts drawImage and
      // AGENTS.md — so the real check is whether dropChromaKey can actually recover alpha from
      // whatever this model painted, not whether the model claims to support transparency.
      const result = await generateImage({
        model: google.image(IMAGE),
        prompt: `a small red circle, sticker art, flat colour\n\n${GOOGLE_IMAGE_STYLE}`,
        aspectRatio: "1:1",
      });
      const raw = Buffer.from(result.image.uint8Array);
      ok("generated an image", `${(raw.length / 1024).toFixed(0)}KB`);
      const png = await dropChromaKey(raw, CHROMA_KEY);
      const colourType = png[25];
      if (colourType === 6 || colourType === 4) ok("alpha recovered by dropChromaKey");
      else bad("alpha recovered by dropChromaKey", `png colour type ${colourType} after cutout`);
      if (result.warnings.length) console.log("    warnings:", JSON.stringify(result.warnings));
    } else {
      const result = await generateImage({
        model: openai.image(IMAGE),
        prompt: "a small red circle, sticker art, flat colour",
        size: "1024x1024",
        providerOptions: {
          openai: { background: "transparent", outputFormat: "png", quality: "medium" },
        },
      });
      const png = Buffer.from(result.image.uint8Array);
      // Colour type 6 is RGBA, 4 is grey+alpha; anything else means the background is opaque.
      const colourType = png[25];
      ok("generated an image", `${(png.length / 1024).toFixed(0)}KB`);
      if (colourType === 6 || colourType === 4) ok("transparent background supported");
      else bad("transparent background", `png colour type ${colourType}`);
      if (result.warnings.length) console.log("    warnings:", JSON.stringify(result.warnings));
    }
  } catch (err) {
    bad("image model", err);
  }

  console.log(failures === 0 ? "\nall models usable\n" : `\n${failures} FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
};

void main();
