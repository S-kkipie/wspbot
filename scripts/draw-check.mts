/**
 * Proves the drawn-sticker path end to end, short of sending: generate an image, run it through
 * the same transparency step `lib/provider.ts` `drawImage` and `lib/stickers.ts` `createFromPrompt`
 * use, then the sticker encoder, and confirm the result is a 512x512 WebP that actually kept its
 * alpha channel.
 *
 * Transparency is the whole point. Without it every drawn sticker arrives as a square photo on
 * a white (or, under Gemini, magenta) card, which looks broken next to real stickers — and that
 * is invisible in a unit test.
 *
 * Tests whichever provider `AI_PROVIDER` in `.env` names (default: google, matching
 * `lib/config.ts`) — OpenAI gets a real `background: "transparent"`; Gemini has no such option
 * and gets a chroma-key backdrop keyed out with `dropChromaKey` instead, so this exercises that
 * ffmpeg step for real rather than assuming it works.
 *
 * Costs one real image generation, so it is deliberately not part of `npm run smoke`:
 *   npm run draw-check
 */
import { writeFileSync } from "node:fs";
import { generateImage } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { readFileSync } from "node:fs";
import { toSticker, dropChromaKey } from "../lib/sticker-maker.js";

const env = Object.fromEntries(
  readFileSync("C:/Users/Ignac/Documentos/Github/wspbot/.env", "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.startsWith("#") && l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);

let failures = 0;
const check = (label: string, actual: unknown, expected: unknown) => {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (!pass) failures++;
  console.log(pass ? "  PASS" : "  FAIL", label, pass ? "" : `— got ${JSON.stringify(actual)}`);
};

/** Reads the WebP container directly; ffprobe cannot report alpha reliably. */
const inspect = (b: Buffer) => {
  let off = 12;
  let canvas = "?";
  let frames = 0;
  const chunks: string[] = [];
  while (off + 8 <= b.length) {
    const cc = b.toString("ascii", off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (cc === "ANMF") frames++;
    if (cc === "VP8X") {
      const p = b.subarray(off + 8, off + 8 + size);
      canvas = `${(p[4]! | (p[5]! << 8) | (p[6]! << 16)) + 1}x${(p[7]! | (p[8]! << 8) | (p[9]! << 16)) + 1}`;
      // Bit 4 of the VP8X flags is ALPHA — the authoritative signal for a lossy+alpha file.
      chunks.push((p[0]! & 0x10) !== 0 ? "FLAG:ALPHA" : "FLAG:NOALPHA");
    }
    if (!chunks.includes(cc)) chunks.push(cc);
    off += 8 + size + (size % 2);
  }
  return { canvas, frames: frames || 1, kb: +(b.length / 1024).toFixed(1), chunks };
};

const OPENAI_STYLE =
  "Sticker art: one clear subject, centred, bold clean outlines, simple flat shapes and vivid " +
  "colours. Fully transparent background. No drop shadow, no border, no frame, no background " +
  "scenery, and no text unless the request asks for words.";

const CHROMA_KEY = "0xFF00FF";

const GOOGLE_STYLE =
  "Sticker art: one clear subject, centred, bold clean outlines, simple flat shapes and vivid " +
  "colours. Background: a single solid flat colour filling every pixel behind the subject, pure " +
  "magenta, hex FF00FF, RGB 255/0/255, with no gradient, no shading, no texture and no other " +
  "colour in it anywhere. The subject itself must avoid magenta or pink tones so it stays " +
  "distinct from the background. Sharp clean edges between the subject and the background, no " +
  "soft blur. No drop shadow, no border, no frame, no other scenery, and no text unless the " +
  "request asks for words.";

const PROMPT = "a sleepy capybara wearing tiny sunglasses";

const main = async () => {
  const provider = env["AI_PROVIDER"] ?? "google";
  const isGoogle = provider === "google";
  const model =
    env["BOT_IMAGE_MODEL"] ?? (isGoogle ? "gemini-2.5-flash-image" : "gpt-image-1");
  console.log(`\ndrawing with ${provider}/${model}…`);

  let raw: Buffer;
  if (isGoogle) {
    const google = createGoogleGenerativeAI({ apiKey: env["GEMINI_API_KEY"]! });
    const result = await generateImage({
      model: google.image(model),
      prompt: `${PROMPT}\n\n${GOOGLE_STYLE}`,
      aspectRatio: "1:1",
    });
    raw = Buffer.from(result.image.uint8Array);
    console.log(`    generated ${(raw.length / 1024).toFixed(0)}KB ${result.image.mediaType}`);
    console.log(`    warnings: ${JSON.stringify(result.warnings)}`);
    console.log(`    usage: ${JSON.stringify(result.usage)}`);
  } else {
    const openai = createOpenAI({ apiKey: env["OPENAI_API_KEY"]! });
    const result = await generateImage({
      model: openai.image(model),
      prompt: `${PROMPT}\n\n${OPENAI_STYLE}`,
      size: "1024x1024",
      providerOptions: {
        openai: { background: "transparent", outputFormat: "png", quality: "medium" },
      },
    });
    raw = Buffer.from(result.image.uint8Array);
    console.log(`    generated ${(raw.length / 1024).toFixed(0)}KB ${result.image.mediaType}`);
    console.log(`    warnings: ${JSON.stringify(result.warnings)}`);
    console.log(`    usage: ${JSON.stringify(result.usage)}`);
  }

  // Gemini's raw output has no alpha at all yet — that is expected here, not a failure — so the
  // chroma-key step runs first and the alpha assertion below applies to what comes out of it,
  // exactly like lib/stickers.ts createFromPrompt does.
  const png = isGoogle ? await dropChromaKey(raw, CHROMA_KEY) : raw;
  if (isGoogle) {
    const rawOut = "C:/Users/Ignac/AppData/Local/Temp/claude/drawn-sticker-raw-chromakey.png";
    writeFileSync(rawOut, raw);
    console.log(`    wrote ${rawOut} — the pre-cutout chroma-key render, for judging edge quality`);
  }

  // A PNG keeps alpha in its colour type: 6 = RGBA, 4 = grey+alpha.
  const colourType = png[25];
  check("png has an alpha channel", colourType === 6 || colourType === 4, true);

  const webp = inspect(await toSticker(png, false));
  console.log("   ", JSON.stringify(webp));
  check("512x512", webp.canvas, "512x512");
  check("single frame", webp.frames, 1);
  check("under WhatsApp's 100KB ceiling", webp.kb < 100, true);
  check(
    "transparency survived the conversion",
    webp.chunks.includes("ALPH") || webp.chunks.includes("FLAG:ALPHA"),
    true,
  );

  const out = "C:/Users/Ignac/AppData/Local/Temp/claude/drawn-sticker.webp";
  writeFileSync(out, await toSticker(png, false));
  console.log(`\n    wrote ${out} — open it to judge how it looks`);

  console.log(failures === 0 ? "\nall checks passed\n" : `\n${failures} FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
};

void main();
