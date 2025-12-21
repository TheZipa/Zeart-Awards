// tools/build_config.js
// Node 18+

import fs from "fs";

const token = process.env.DISCORD_BOT_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID;

if (!token || !guildId) {
  console.error("Missing DISCORD_BOT_TOKEN or DISCORD_GUILD_ID");
  process.exit(1);
}

function avatarUrl(userId, avatarHash) {
  if (!avatarHash) return "https://cdn.discordapp.com/embed/avatars/0.png";
  const ext = avatarHash.startsWith("a_") ? "gif" : "png";
  return `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.${ext}?size=256`;
}

async function api(path) {
  const res = await fetch(`https://discord.com/api/v10${path}`, {
    headers: { Authorization: `Bot ${token}` },
  });
  if (!res.ok) throw new Error(`Discord API ${res.status}: ${await res.text()}`);
  return res.json();
}

// GET /guilds/{guild.id}/members/{user.id}
async function fetchMember(userId) {
  const m = await api(`/guilds/${guildId}/members/${userId}`);
  const u = m.user || {};
  const display = m.nick || u.global_name || u.username || userId;

  return {
    id: u.id,
    name: display,
    tag: u.username ? `@${u.username}` : "",
    avatarUrl: avatarUrl(u.id, u.avatar),
  };
}

async function main() {
  const src = JSON.parse(fs.readFileSync("config.source.json", "utf8"));

  for (const nom of src.nominations || []) {
    const out = [];
    for (const n of nom.nominees || []) {
      // n может быть {id} или уже заполненным объектом
      if (!n?.id) continue;
      const member = await fetchMember(n.id);
      out.push({ ...n, ...member });
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