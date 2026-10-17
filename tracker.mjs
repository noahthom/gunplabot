import fs from "node:fs";
import Anthropic from "@anthropic-ai/sdk";

// Pages to check. Swap in any release-news pages you like.
const SOURCES = [
  "https://www.toy-people.com/en/",
  "https://essential-japan.com/news/",
];
const GRADES = ["HG", "MG", "RG"];
const SEEN_FILE = "seen.json";
const MODEL = "claude-sonnet-5-5";
const LOOKUP_DATES = true; // web-search for release dates the pages don't give
const MAX_LOOKUPS = 5; // per run, to cap cost
const client = new Anthropic(); // reads ANTHROPIC_API_KEY

const textOf = (res) =>
  res.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();

async function getText(url) {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  const html = await res.text();
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, 60000);
}

async function extract(text) {
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 4000,
    system:
      "You extract Gunpla release info from web page text. Reply with ONLY a JSON array, no markdown. " +
      "Each item: {name, grade (HG|MG|RG|other), " +
      "release (date or month as written, e.g. 'Oct 31, 2026' or 'Dec 2026'; null if the page gives none), " +
      "price (as written, or null), " +
      "summary (1-2 plain sentences on what the kit is: the series or character, and anything notable like a new color scheme or transformation, using only what the page says; null if the page says nothing), " +
      "exclusive (true if Premium Bandai, Gundam Base limited, or any other exclusive)}. " +
      "Only include kits that are upcoming or newly announced. Return [] if none.",
    messages: [{ role: "user", content: text }],
  });
  const raw = textOf(res).replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

// Asks Claude to web-search for a release date. Returns null if none found.
async function lookupRelease(k) {
  try {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 500,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }],
      system:
        "Find the release date for a Gunpla kit. Reply with ONLY the date or month as written " +
        "(e.g. 'Nov 14, 2026' or 'Dec 2026'), or the single word 'unknown' if you cannot find one.",
      messages: [{ role: "user", content: `${k.name} (${k.grade}) Bandai release date` }],
    });
    const t = textOf(res);
    return t && t.length < 40 && !/unknown/i.test(t) ? t : null;
  } catch (e) {
    console.error("Lookup failed:", k.name, e.message);
    return null;
  }
}

// Sends blocks to Discord, splitting into several messages if too long.
async function notify(blocks) {
  const chunks = [];
  let cur = "";
  for (const b of blocks) {
    if (cur && (cur + "\n\n" + b).length > 1900) {
      chunks.push(cur);
      cur = b;
    } else {
      cur = cur ? cur + "\n\n" + b : b;
    }
  }
  if (cur) chunks.push(cur);
  for (const c of chunks) {
    await fetch(process.env.DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: c.slice(0, 1990) }),
    });
  }
}

const seen = fs.existsSync(SEEN_FILE)
  ? JSON.parse(fs.readFileSync(SEEN_FILE, "utf8"))
  : null;

const found = {};
for (const url of SOURCES) {
  try {
    for (const k of await extract(await getText(url))) {
      if (!k?.name || !GRADES.includes(k.grade) || k.exclusive) continue;
      found[k.name.toLowerCase().trim()] = k;
    }
  } catch (e) {
    console.error("Failed:", url, e.message);
  }
}

// Keep details we already knew if today's pages don't repeat them
for (const [key, k] of Object.entries(found)) {
  const old = seen?.[key];
  if (old) {
    k.release ||= old.release;
    k.summary ||= old.summary;
    k.price ||= old.price;
  }
}

const fresh = Object.entries(found).filter(
  ([key, k]) => !seen?.[key] || seen[key].release !== k.release
);

// Try to fill in missing release dates for new kits (not on the first run)
if (seen && LOOKUP_DATES) {
  let n = 0;
  for (const [, k] of fresh) {
    if (k.release || n >= MAX_LOOKUPS) continue;
    n++;
    k.release = await lookupRelease(k);
  }
}

if (!seen) {
  await notify([
    `Gunpla tracker is live. Tracking ${Object.keys(found).length} upcoming HG/MG/RG kits.`,
  ]);
} else if (fresh.length) {
  const blocks = fresh.map(([key, k]) => {
    const old = seen[key];
    const tag = !old ? "New" : old.release ? "Date changed" : "Date announced";
    const when = k.release ? `Release: ${k.release}` : "Release: date not announced yet";
    return (
      `**${tag}: ${k.name}** (${k.grade})\n${when}` +
      (k.price ? ` · ${k.price}` : "") +
      (k.summary ? `\n${k.summary}` : "")
    );
  });
  await notify(blocks);
}

// Merge so a failed source never wipes history
fs.writeFileSync(SEEN_FILE, JSON.stringify({ ...(seen || {}), ...found }, null, 2));
console.log(`Found ${Object.keys(found).length}, notified ${fresh.length}`);
