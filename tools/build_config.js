// tools/build_config.js
// Node 18+
//
// Generates ./config.json from ./config.source.json
// - Resolves Discord members by id via Bot token
// - Supports nominees types:
//   - discord: {id} or {type:"discord", id}
//   - custom: only image path -> {type:"custom", imageUrl:"assets/game.jpg"}
//            (also supports shorthand string "assets/game.jpg")
//   - video:  {type:"video", videoUrl:"assets/clip.mp4", posterUrl?: "...", title?: "..."}
// - Adds/normalizes intro/outro fields:
//   prefaceTitle, prefaceText, afterwordTitle, afterwordText
//
// Env required:
//   DISCORD_BOT_TOKEN
//   DISCORD_GUILD_ID

import fs from "fs";

const token = process.env.DISCORD_BOT_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID;

if (!token || !guildId) {
  console.error("Missing DISCORD_BOT_TOKEN or DISCORD_GUILD_ID");
  process.exit(1);
}

const DEFAULT_TEXTS = {
  siteTitle: "Zeart Awards 2025",
  siteSubtitle: "Годовые номинации участников Zeart",

  prefaceTitle: "Добро пожаловать на Zeart Awards 2025",
  prefaceText:
    "Здесь собраны годовые номинации участников Zeart. Листай вниз и выбирай свою любимую номинацию — а мы устроим праздник при каждом открытии.",

  afterwordTitle: "Спасибо, что были с Zeart!",
  afterwordText:
    "Это был мощный год. Увидимся на следующих номинациях — и да начнётся новый сезон легенд ✨",
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Very small pacing between requests (Discord still rate-limits per route).
// This helps avoid bursts in GitHub Actions where many nominees are resolved at once.
let lastApiCallAt = 0;
const MIN_API_INTERVAL_MS = Number(process.env.DISCORD_MIN_API_INTERVAL_MS || 120);

async function pace() {
  const now = Date.now();
  const wait = lastApiCallAt + MIN_API_INTERVAL_MS - now;
  if (wait > 0) await sleep(wait);
  lastApiCallAt = Date.now();
}


function avatarUrl(userId, avatarHash) {
  if (!avatarHash) return "https://cdn.discordapp.com/embed/avatars/0.png";
  const ext = avatarHash.startsWith("a_") ? "gif" : "png";
  return `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.${ext}?size=256`;
}

async function api(path, { retries = 10 } = {}) {
  const url = `https://discord.com/api/v10${path}`;

  for (let attempt = 0; attempt <= retries; attempt++) {
    await pace();

    const res = await fetch(url, {
      headers: {
        Authorization: `Bot ${token}`,
        "User-Agent": "Zeart-Awards-Config-Builder (GitHub Actions)",
      },
    });

    if (res.status === 429) {
      // Discord returns JSON with retry_after (seconds)
      let retryAfterSec = 1;
      try {
        const body = await res.json();
        if (typeof body?.retry_after === "number") retryAfterSec = body.retry_after;
      } catch {
        // ignore
      }

      // Add a tiny jitter so multiple retries don't align
      const jitterMs = 50 + Math.floor(Math.random() * 120);
      const waitMs = Math.ceil(retryAfterSec * 1000) + jitterMs;

      if (attempt >= retries) {
        throw new Error(`Discord API 429 after ${retries + 1} attempts on ${path}`);
      }

      await sleep(waitMs);
      continue;
    }

    // Retry transient server errors
    if (res.status >= 500 && res.status <= 599) {
      if (attempt >= retries) {
        throw new Error(`Discord API ${res.status}: ${await res.text()}`);
      }
      const backoffMs = 250 * (attempt + 1);
      await sleep(backoffMs);
      continue;
    }

    if (!res.ok) throw new Error(`Discord API ${res.status}: ${await res.text()}`);
    return res.json();
  }

  throw new Error(`Discord API failed unexpectedly for ${path}`);
}


const memberCache = new Map();

// GET /guilds/{guild.id}/members/{user.id}
async function fetchMember(userId) {
  const key = String(userId);

  // Deduplicate / cache requests within a single run to reduce rate-limit hits
  if (memberCache.has(key)) return await memberCache.get(key);

  const p = (async () => {
    const m = await api(`/guilds/${guildId}/members/${key}`);
    const u = m.user || {};
    const display = m.nick || u.global_name || u.username || key;

    return {
      type: "discord",
      id: u.id,
      name: display,
      tag: u.username ? `@${u.username}` : "",
      avatarUrl: avatarUrl(u.id, u.avatar),
    };
  })();

  memberCache.set(key, p);
  try {
    return await p;
  } catch (e) {
    memberCache.delete(key);
    throw e;
  }
}

function normalizeTexts(src) {
  // Optional nested format support:
  //   preface: { title, text }
  //   afterword: { title, text }
  if (src?.preface && typeof src.preface === "object") {
    src.prefaceTitle ??= src.preface.title;
    src.prefaceText ??= src.preface.text;
  }
  if (src?.afterword && typeof src.afterword === "object") {
    src.afterwordTitle ??= src.afterword.title;
    src.afterwordText ??= src.afterword.text;
  }

  // Defaults so config.json always contains these fields
  src.siteTitle ??= DEFAULT_TEXTS.siteTitle;
  src.siteSubtitle ??= DEFAULT_TEXTS.siteSubtitle;

  src.prefaceTitle ??= DEFAULT_TEXTS.prefaceTitle;
  src.prefaceText ??= DEFAULT_TEXTS.prefaceText;

  src.afterwordTitle ??= DEFAULT_TEXTS.afterwordTitle;
  src.afterwordText ??= DEFAULT_TEXTS.afterwordText;

  // Keep config clean (optional)
  delete src.preface;
  delete src.afterword;

  return src;
}

function looksLikeImagePath(s) {
  return typeof s === "string" && /\.(png|jpg|jpeg|webp|gif|svg)$/i.test(s.trim());
}

async function resolveNominee(n) {
  if (!n) return null;

  // Shorthand: "assets/game.jpg" -> custom (+ title from filename)
  if (looksLikeImagePath(n)) {
    const imageUrl = String(n).trim();
    const base = imageUrl.split("/").pop() || imageUrl;
    const title = base.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
    return { type: "custom", imageUrl, title: title || undefined };
  }

  if (typeof n !== "object") return null;
  if (Object.keys(n).length === 0) return null;

  const type = (n.type || "").toLowerCase();

  // Legacy or explicit discord
  if ((type === "" || type === "discord" || type === "member") && n.id) {
    const member = await fetchMember(n.id);
    return {
      ...member,
      ...n,
      type: "discord",
      id: member.id,
      name: n.name ?? member.name,
      tag: n.tag ?? member.tag,
      avatarUrl: n.avatarUrl ?? member.avatarUrl,
    };
  }

  // Custom nominee:
  // - With image: {type:"custom", imageUrl:"assets/game.jpg", title?: "..."}
  // - Title-only: {type:"custom", title:"Game of the Year"} (no imageUrl)
  // NOTE: Custom/video nominees must not have tag/avatarUrl (index.html ignores them anyway).
  if (type === "custom") {
    const imageUrl = n.imageUrl ?? n.path ?? n.src ?? n.url;
    let title = n.title ?? n.name ?? n.text;

    // If no imageUrl, allow title-only custom nominee.
    // If BOTH are missing, treat as empty entry and skip instead of failing the workflow.
    if (!imageUrl) {
      if (!title) return null;
      return { type: "custom", title: String(title).trim() };
    }

    // If image exists but title missing, derive from filename
    if (!title) {
      const base = String(imageUrl).split("/").pop() || String(imageUrl);
      title = base.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
    }

    const out = { type: "custom", imageUrl: String(imageUrl) };
    if (title) out.title = String(title).trim();
    return out;
  }

  // Video nominee (inline player on the site) + optional title/poster
  if (type === "video") {
    const videoUrl = n.videoUrl;
    if (!videoUrl) throw new Error(`Video nominee is missing "videoUrl"`);

    const out = { type: "video", videoUrl: String(videoUrl) };
    if (n.posterUrl) out.posterUrl = String(n.posterUrl);

    let title = n.title;
    if (!title) {
      const base = String(videoUrl).split("/").pop() || String(videoUrl);
      title = base.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim();
    }
    if (title) out.title = String(title);

    return out;
  }

  // Unknown: pass through
  return { ...n, type: type || "unknown" };
}

async function main() {
  const src = JSON.parse(fs.readFileSync("config.source.json", "utf8"));
  normalizeTexts(src);

  for (const nom of src.nominations || []) {
    const out = [];
    for (const n of nom.nominees || []) {
      const resolved = await resolveNominee(n);
      if (resolved) out.push(resolved);
    }
    nom.nominees = out;
  }

  fs.writeFileSync("config.json", JSON.stringify(src, null, 2), "utf8");
  console.log("✅ config.json generated");
}

main().catch((e) => {
  console.error("❌", e);
  process.exit(1);
});
