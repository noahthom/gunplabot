import fs from "node:fs";
import Anthropic from "@anthropic-ai/sdk";

// Pages to check. Swap in any release-news pages you like.
const SOURCES = [
  "https://www.toy-people.com/en/",
  "https://essential-japan.com/news/",
];
const GRADES = ["HG", "MG", "RG"];
const SEEN_FILE = "seen.json";
const client = new Anthropic(); // reads ANTHROPIC_API_KEY

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
    model: "claude-sonnet-5-5",
    max_tokens: 4000,
    system:
      "You extract Gunpla release info from web page text. Reply with ONLY a JSON array, no markdown. " +
      "Each item: {name, grade (HG|MG|RG|other), release (as written, e.g. 'Oct 31, 2026' or 'Dec 2026'), " +
      "price (as written, or null), exclusive (true if Premium Bandai, Gundam Base limited, or any other exclusive)}. " +
      "Only include kits that are upcoming or newly announced. Return [] if none.",
    messages: [{ role: "user", content: text }],
  });
  const raw = res.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .replace(/```json|```/g, "")
    .trim();
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function notify(content) {
  await fetch(process.env.DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: content.slice(0, 1900) }),
  });
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

const fresh = Object.entries(found).filter(
  ([key, k]) => !seen?.[key] || seen[key].release !== k.release
);

if (!seen) {
  await notify(`Gunpla tracker is live. Tracking ${Object.keys(found).length} upcoming HG/MG/RG kits.`);
} else if (fresh.length) {
  const lines = fresh.map(([key, k]) => {
    const tag = seen[key] ? "Date changed" : "New";
    return `${tag}: ${k.name} (${k.grade}), ${k.release}${k.price ? ", " + k.price : ""}`;
  });
  await notify(lines.join("\n"));
}

// Merge so a failed source never wipes history
fs.writeFileSync(SEEN_FILE, JSON.stringify({ ...(seen || {}), ...found }, null, 2));
console.log(`Found ${Object.keys(found).length}, notified ${fresh.length}`);
