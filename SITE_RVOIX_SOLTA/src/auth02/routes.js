const axios = require("axios");
const crypto = require("crypto");
const express = require("express");
const {
  countUsers,
  getBot,
  getUser,
  initDb,
  listBots,
  listUsers,
  storageStatus,
  updateBotGeneral,
  updateUserTokens,
  upsertBot,
  upsertUser,
} = require("./db");

const DISCORD_API = "https://discord.com/api/v10";
const DISCORD_OAUTH_TOKEN = "https://discord.com/api/oauth2/token";
const WEBHOOK_LOG_NAME = "Rovix Applications";

const router = express.Router();
router.use(express.json({ limit: "1mb" }));

let dbReady = false;
let lastDbError = null;
let initDbPromise = null;

async function ensureDb() {
  if (dbReady) return true;
  if (!initDbPromise) {
    initDbPromise = initDb()
      .then(() => {
        dbReady = true;
        lastDbError = storageStatus().mysql_error;
        if (storageStatus().mode === "mysql") {
          console.log("[Auth v2 API] banco conectado e tabelas verificadas.");
        } else {
          console.log("[Auth v2 API] armazenamento local ativo.");
        }
        return true;
      })
      .catch(err => {
        dbReady = false;
        lastDbError = err.message;
        initDbPromise = null;
        console.error("[Auth v2 API] falha no banco:", err.message);
        return false;
      });
  }

  return initDbPromise;
}

async function requireDb(_req, res, next) {
  const ok = await ensureDb();
  if (!ok) {
    return res.status(503).json({
      sucesso: false,
      message: "Armazenamento indisponivel.",
      error: lastDbError,
    });
  }

  return next();
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Variavel ${name} nao configurada.`);
  return value;
}

function publicUrl() {
  const value = process.env.PUBLIC_URL || process.env.PUBLIC_BASE_URL || process.env.BASE_URL;
  if (!value) throw new Error("Variavel PUBLIC_URL ou PUBLIC_BASE_URL nao configurada.");
  return String(value).replace(/\/+$/, "");
}

function redirectUri() {
  const customRedirect = process.env.AUTH02_REDIRECT_URI || process.env.AUTH02_CALLBACK_URL || process.env.REDIRECT_URI;
  if (customRedirect) return String(customRedirect).trim();
  return `${publicUrl()}/auth02/verify`;
}

function callbackUriFromRequest(req) {
  const callbackPath = String(req.path || req.route?.path || "").split("?")[0];
  const knownCallbacks = new Set([
    "/auth02/verify",
    "/api/auth/discord/callback",
    "/api/auth/callback",
    "/auth/discord/callback",
    "/callback",
  ]);

  if (knownCallbacks.has(callbackPath)) {
    return `${publicUrl()}${callbackPath}`;
  }

  return redirectUri();
}

function uniqueValues(values) {
  return Array.from(new Set(values.map(value => String(value || "").trim()).filter(Boolean)));
}

function fromBase64Url(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Buffer.from(padded, "base64").toString("utf8");
}

function configuredReturnHosts() {
  const hosts = new Set();
  const envUrls = [
    process.env.PUBLIC_URL,
    process.env.PUBLIC_BASE_URL,
    process.env.BASE_URL,
    process.env.SITE_URL,
    process.env.PUBLIC_SITE_URL,
    process.env.SUCCESS_REDIRECT_URL,
  ];

  for (const value of envUrls) {
    try {
      if (value) hosts.add(new URL(value).hostname);
    } catch (_) {}
  }

  for (const host of String(process.env.ALLOWED_RETURN_HOSTS || "").split(",")) {
    const cleanHost = host.trim();
    if (cleanHost) hosts.add(cleanHost);
  }

  return hosts;
}

function safeReturnUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    if (process.env.ALLOW_ANY_RETURN_URL === "true") return url.toString();
    if (["localhost", "127.0.0.1", "::1"].includes(url.hostname)) return url.toString();
    if (configuredReturnHosts().has(url.hostname)) return url.toString();
  } catch (_) {}

  return null;
}

function appendQuery(url, params) {
  const parsed = new URL(url);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      parsed.searchParams.set(key, value);
    }
  }

  return parsed.toString();
}

function parseOAuthState(value) {
  const raw = String(value || "").trim();
  if (!raw) return { botId: "" };

  const candidates = [raw];
  try {
    candidates.push(fromBase64Url(raw));
  } catch (_) {}

  for (const candidate of candidates) {
    const text = String(candidate || "").trim();
    if (!text.startsWith("{")) continue;

    try {
      const data = JSON.parse(text);
      const botId = String(data.bot_id || data.botId || data.bot || "").trim();

      if (botId) {
        return {
          botId,
          guildId: data.guild_id || data.guildId || data.guild ? String(data.guild_id || data.guildId || data.guild).trim() : null,
          roleId: data.role_id || data.roleId || data.role ? String(data.role_id || data.roleId || data.role).trim() : null,
          plan: data.plan ? String(data.plan).slice(0, 40) : null,
          ref: data.ref ? String(data.ref).slice(0, 80) : null,
          returnUrl: safeReturnUrl(data.return_url || data.returnUrl),
        };
      }
    } catch (_) {}
  }

  return { botId: raw };
}

async function exchangeOAuthCode(bot, code, req) {
  const redirects = uniqueValues([
    callbackUriFromRequest(req),
    bot.redirect_uri,
    redirectUri(),
  ]);

  let lastError = null;
  for (const redirect of redirects) {
    try {
      return await axios.post(
        DISCORD_OAUTH_TOKEN,
        new URLSearchParams({
          client_id: bot.bot_id,
          client_secret: bot.client_secret,
          code,
          grant_type: "authorization_code",
          redirect_uri: redirect,
          scope: "identify email guilds guilds.join",
        }),
        { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 15000 }
      );
    } catch (err) {
      lastError = err;
      const status = err.response?.status;
      const oauthError = err.response?.data?.error;
      if (status === 400 && oauthError === "invalid_grant") continue;
      throw err;
    }
  }

  throw lastError || new Error("Falha ao trocar codigo OAuth2.");
}

function assertApiKey(req, res, next) {
  const expected = process.env.API_KEY;
  const got = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");

  if (!expected || got !== expected) {
    return res.status(401).json({ sucesso: false, message: "API key invalida." });
  }

  return next();
}

function ipHash(req) {
  const ip = clientIp(req);
  return crypto.createHash("sha256").update(`${ip}:${process.env.API_KEY || ""}`).digest("hex");
}

function clientIp(req) {
  const forwarded = String(req.headers["cf-connecting-ip"] || req.headers["x-real-ip"] || req.headers["x-forwarded-for"] || "");
  const ip = forwarded.split(",")[0].trim() || req.ip || req.socket?.remoteAddress || "";
  return String(ip).replace(/^::ffff:/, "");
}

function maskIp(ip) {
  const value = String(ip || "");
  if (!value) return null;

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
    const parts = value.split(".");
    return `${parts[0]}.${parts[1]}.${parts[2]}.x`;
  }

  if (value.includes(":")) {
    return `${value.split(":").slice(0, 4).join(":")}::`;
  }

  return value.slice(0, 8) + "...";
}

function isPublicIp(ip) {
  const value = String(ip || "");
  if (!value || value === "::1" || value === "127.0.0.1") return false;
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(value)) return false;
  return true;
}

function proxyType(security) {
  if (!security || typeof security !== "object") return "Nenhum";
  const detected = [];
  if (security.vpn) detected.push("VPN");
  if (security.proxy) detected.push("Proxy");
  if (security.tor) detected.push("Tor");
  if (security.hosting) detected.push("Hosting");
  return detected.length ? detected.join(", ") : "Nenhum";
}

function proxyProbability(security) {
  return proxyType(security) === "Nenhum" ? "0% (Baixa)" : "100% (Alta)";
}

async function getIpGeo(ip) {
  if (!isPublicIp(ip)) return {};

  try {
    const response = await axios.get(`https://ipwho.is/${encodeURIComponent(ip)}`, {
      timeout: 5000,
      params: {
        fields: "success,country,region,city,latitude,longitude,connection,timezone,security",
      },
    });

    if (!response.data?.success) return {};

    return {
      ip_country: response.data.country || null,
      ip_region: response.data.region || null,
      ip_city: response.data.city || null,
      ip_org: response.data.connection?.org || response.data.connection?.isp || null,
      ip_asn: response.data.connection?.asn || null,
      ip_isp: response.data.connection?.isp || null,
      ip_latitude: response.data.latitude ?? null,
      ip_longitude: response.data.longitude ?? null,
      ip_timezone: response.data.timezone?.id || null,
      ip_proxy_type: proxyType(response.data.security),
      ip_proxy_probability: proxyProbability(response.data.security),
    };
  } catch (_) {
    return {};
  }
}

async function getUserGuildCount(accessToken) {
  try {
    const response = await axios.get(`${DISCORD_API}/users/@me/guilds`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 10000,
    });

    return Array.isArray(response.data) ? response.data.length : null;
  } catch (_) {
    return null;
  }
}

function avatarUrl(user) {
  if (!user?.avatar) return null;
  const ext = user.avatar.startsWith("a_") ? "gif" : "png";
  return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${ext}?size=128`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function maskEmail(email) {
  const value = String(email || "");
  const [name, domain] = value.split("@");
  if (!name || !domain) return "Nao informado";
  return `${name.slice(0, 2)}***@${domain}`;
}

function discordAccountCreatedAt(userId) {
  try {
    const timestamp = Number((BigInt(String(userId)) >> 22n) + 1420070400000n);
    return new Date(timestamp);
  } catch (_) {
    return null;
  }
}

function formatDateTimeBR(date = new Date()) {
  const value = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(value.getTime())) return "N/A";

  return value.toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatAccountAge(userId) {
  const createdAt = discordAccountCreatedAt(userId);
  if (!createdAt) return "N/A";

  const years = Math.floor((Date.now() - createdAt.getTime()) / (365.25 * 24 * 60 * 60 * 1000));
  if (years > 0) return `ha ${years} ${years === 1 ? "ano" : "anos"}`;
  return formatDateTimeBR(createdAt);
}

function fieldCode(value) {
  const text = String(value || "N/A").slice(0, 900);
  return `\`${text.replace(/`/g, "'")}\``;
}

function defaultWebhookLogs() {
  return String(process.env.AUTH02_WEBHOOK_LOGS || process.env.AUTH02_LOG_WEBHOOK_URL || "").trim();
}

function resolveWebhookLogs(bot) {
  return String(bot?.webhook_logs || defaultWebhookLogs()).trim();
}

function compactLocation(meta) {
  return [meta.ip_city, meta.ip_region, meta.ip_country].filter(Boolean).join(", ") || "Indisponivel";
}

function verificationLocation(meta) {
  const cityRegion = [meta.ip_city, meta.ip_region].filter(Boolean).join(", ");
  if (cityRegion && meta.ip_country) return `${cityRegion} - ${meta.ip_country}`;
  return cityRegion || meta.ip_country || "Indisponivel";
}

function formatCoordinates(meta) {
  const lat = Number(meta.ip_latitude);
  const lon = Number(meta.ip_longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return "Indisponivel";
  return `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
}

function formatConnection(meta) {
  const org = meta.ip_org || meta.ip_isp;
  const asn = meta.ip_asn ? `AS${meta.ip_asn}` : null;
  if (org && asn) return `${org} (${asn}${meta.ip_isp && meta.ip_isp !== org ? ` ${meta.ip_isp}` : ""})`;
  return org || asn || "Indisponivel";
}

function formatVerificationDateBR(date = new Date()) {
  const parts = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const get = (type) => parts.find((part) => part.type === type)?.value || "";
  return `${get("weekday")}, ${get("day")} de ${get("month")} de ${get("year")} ${get("hour")}:${get("minute")}`;
}

async function getBotGuildName(bot, guildId) {
  if (!guildId) return "Nao configurado";

  try {
    const response = await axios.get(`${DISCORD_API}/guilds/${guildId}`, {
      headers: { Authorization: `Bot ${bot.bot_token}` },
      timeout: 10000,
    });

    return response.data?.name || String(guildId);
  } catch (_) {
    return String(guildId);
  }
}

function buildVerificationLogEmbed({ bot, user, guildCount, meta, memberStatus, guildName }) {
  const userTag = user.discriminator && user.discriminator !== "0"
    ? `${user.username}#${user.discriminator}`
    : (user.username || user.global_name || user.id);
  const verifiedAt = new Date();

  return {
    title: "\u2705 Nova Verifica\u00e7\u00e3o OAuth2",
    color: 0x00ff3c,
    description: [
      `\u{1F464} **Usu\u00e1rio:** <@${user.id}> ${fieldCode(user.id)}`,
      `\u{1F4E7} **E-mail:** ${fieldCode(user.email || "Indisponivel")}`,
      `\u{1F310} **IP:** ${fieldCode(meta.ip || meta.ip_masked || "Indisponivel")}`,
      `\u{1F4CD} **Localiza\u00e7\u00e3o:** ${verificationLocation(meta)}`,
      `\u{1F5FA}\uFE0F **Coordenadas:** ${formatCoordinates(meta)}`,
      `\u{1F4E1} **Conex\u00e3o:** ${formatConnection(meta)}`,
      `\u{1F551} **Data:** ${fieldCode(formatVerificationDateBR(verifiedAt))}`,
    ].join("\n"),
    timestamp: verifiedAt.toISOString(),
  };
}

function successPage({ bot, user, siteUrl }) {
  const botName = bot.bot_username || "Rovix Applications";
  const avatar = avatarUrl(user);
  const guildUrl = bot.guild_id ? `https://discord.com/channels/${bot.guild_id}` : "https://discord.com/app";
  const returnUrl = siteUrl || guildUrl;
  const returnLabel = siteUrl ? "Voltar para o site" : "Voltar para o servidor";

  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Verificacao concluida</title>
  <style>
    :root { color-scheme: dark; --bg:#07090d; --panel:#10141b; --line:#202733; --text:#f4f7fb; --muted:#9aa6b2; --green:#16c784; --blue:#6d7cff; }
    * { box-sizing: border-box; }
    body { margin:0; min-height:100vh; display:grid; place-items:center; font-family:Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Arial, sans-serif; color:var(--text); background: radial-gradient(circle at 50% 10%, rgba(22,199,132,.14), transparent 32%), radial-gradient(circle at 80% 80%, rgba(109,124,255,.10), transparent 28%), var(--bg); }
    main { width:min(92vw, 520px); text-align:center; }
    .brand { display:flex; flex-direction:column; align-items:center; gap:14px; margin-bottom:28px; }
    .logo { width:82px; height:82px; border-radius:24px; display:grid; place-items:center; background:#fff; color:#111; font-size:40px; font-weight:900; box-shadow:0 0 0 1px rgba(255,255,255,.16), 0 0 42px rgba(22,199,132,.24); position:relative; overflow:hidden; }
    .logo img { width:100%; height:100%; object-fit:cover; }
    .check { position:absolute; right:-4px; bottom:-4px; width:32px; height:32px; border-radius:999px; display:grid; place-items:center; background:var(--green); border:4px solid var(--bg); font-weight:900; }
    h1 { margin:0; font-size:28px; letter-spacing:0; }
    .card { border:1px solid var(--line); background:linear-gradient(180deg, rgba(255,255,255,.045), rgba(255,255,255,.015)); border-radius:8px; padding:28px; box-shadow:0 24px 80px rgba(0,0,0,.38); }
    .shield { width:76px; height:76px; margin:0 auto 18px; border-radius:999px; display:grid; place-items:center; background:rgba(22,199,132,.10); color:var(--green); border:1px solid rgba(22,199,132,.24); font-size:38px; }
    h2 { margin:0 0 8px; font-size:22px; }
    p { margin:0; color:var(--muted); line-height:1.55; }
    .action { margin-top:30px; display:grid; gap:10px; }
    a { height:48px; display:flex; align-items:center; justify-content:center; gap:10px; border-radius:8px; background:#fff; color:#0b0d12; text-decoration:none; font-weight:800; transition:.18s ease; }
    a.secondary { background:transparent; color:var(--text); border:1px solid var(--line); }
    a:hover { transform:translateY(-1px); box-shadow:0 12px 36px rgba(255,255,255,.12); }
  </style>
</head>
<body>
  <main>
    <section class="brand">
      <div class="logo">${avatar ? `<img src="${escapeHtml(avatar)}" alt="">` : "R"}<div class="check">&#10003;</div></div>
      <h1>${escapeHtml(botName)}</h1>
    </section>

    <section class="card">
      <div class="shield">&#10003;</div>
      <h2>Acesso confirmado</h2>
      <p>Sua verificacao foi concluida com sucesso. Voce ja pode voltar para continuar seu pedido.</p>

      <div class="action">
        <a href="${escapeHtml(returnUrl)}">&larr; ${escapeHtml(returnLabel)}</a>
        <a class="secondary" href="${escapeHtml(guildUrl)}">Abrir servidor no Discord</a>
      </div>
    </section>
  </main>
</body>
</html>`;
}

function expiresAt(seconds) {
  if (!seconds) return null;
  return new Date(Date.now() + Number(seconds) * 1000).toISOString().slice(0, 19).replace("T", " ");
}

async function validateBotToken(token) {
  const response = await axios.get(`${DISCORD_API}/users/@me`, {
    headers: { Authorization: `Bot ${token}` },
    timeout: 15000,
  });

  if (!response.data?.bot) throw new Error("O token informado nao pertence a um bot.");
  return response.data;
}

async function refreshAccessToken(bot, user) {
  if (!user.refresh_token) return user.access_token;

  const response = await axios.post(
    DISCORD_OAUTH_TOKEN,
    new URLSearchParams({
      client_id: bot.bot_id,
      client_secret: bot.client_secret,
      grant_type: "refresh_token",
      refresh_token: user.refresh_token,
    }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 15000 }
  );

  const accessToken = response.data.access_token;
  const refreshToken = response.data.refresh_token || user.refresh_token;

  await updateUserTokens(bot.bot_id, user.user_id, {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: expiresAt(response.data.expires_in),
  });

  return accessToken;
}

async function addMember(bot, guildId, user) {
  const headers = { Authorization: `Bot ${bot.bot_token}` };

  try {
    await axios.put(
      `${DISCORD_API}/guilds/${guildId}/members/${user.user_id}`,
      { access_token: user.access_token },
      { headers, timeout: 15000 }
    );
  } catch (err) {
    if (err.response?.status !== 401) throw err;

    const accessToken = await refreshAccessToken(bot, user);
    await axios.put(
      `${DISCORD_API}/guilds/${guildId}/members/${user.user_id}`,
      { access_token: accessToken },
      { headers, timeout: 15000 }
    );
  }

  if (bot.role_id) {
    await axios.put(
      `${DISCORD_API}/guilds/${guildId}/members/${user.user_id}/roles/${bot.role_id}`,
      {},
      { headers, timeout: 15000 }
    ).catch(() => {});
  }
}

router.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "auth-v2-camposcloud-api",
    db: dbReady,
    db_error: lastDbError,
    storage: storageStatus(),
  });
});

router.get(["/health", "/_health", "/healthz"], async (_req, res) => {
  res.json({ ok: true, db: dbReady, db_error: lastDbError, storage: storageStatus() });
});

router.get("/health/db", async (_req, res) => {
  await ensureDb();
  res.json({ ok: true, db: dbReady, db_error: lastDbError, storage: storageStatus() });
});

router.post("/api/auth02/configurar", assertApiKey, requireDb, async (req, res) => {
  try {
    const token = String(req.body.token || "").trim();
    const clientSecret = String(req.body.client_secret || req.body.secret || "").trim();
    const guildId = req.body.guild_id ? String(req.body.guild_id).trim() : null;

    if (!token || !clientSecret) {
      return res.status(400).json({ sucesso: false, message: "token e client_secret sao obrigatorios." });
    }

    const botInfo = await validateBotToken(token);
    const botConfig = {
      bot_id: botInfo.id,
      bot_username: botInfo.username,
      bot_token: token,
      client_secret: clientSecret,
      guild_id: guildId,
      role_id: req.body.role_id || null,
      webhook_logs: req.body.webhook_url || req.body.webhook_logs || defaultWebhookLogs() || null,
      public_url: publicUrl(),
      redirect_uri: redirectUri(),
    };

    await upsertBot(botConfig);

    return res.json({
      sucesso: true,
      bot_id: botInfo.id,
      bot_username: botInfo.username,
      redirect_uri: redirectUri(),
    });
  } catch (err) {
    return res.status(err.response?.status || 500).json({
      sucesso: false,
      message: err.response?.data?.message || err.message,
    });
  }
});

router.post("/api/auth02/configurar-geral", assertApiKey, requireDb, async (req, res) => {
  try {
    const botId = String(req.body.bot_id || "").trim();
    if (!botId) return res.status(400).json({ sucesso: false, message: "bot_id obrigatorio." });

    const bot = await getBot(botId);
    if (!bot) return res.status(404).json({ sucesso: false, message: "Bot nao configurado." });

    await updateBotGeneral(botId, {
      guild_id: req.body.guild_id ? String(req.body.guild_id).trim() : null,
      role_id: req.body.role_id ? String(req.body.role_id).trim() : null,
      webhook_logs: req.body.webhook_url || req.body.webhook_logs || defaultWebhookLogs() || null,
      public_url: publicUrl(),
      redirect_uri: redirectUri(),
    });

    return res.json({ sucesso: true });
  } catch (err) {
    return res.status(500).json({ sucesso: false, message: err.message });
  }
});

router.get("/api/auth02/info/:botId", assertApiKey, requireDb, async (req, res) => {
  const bot = await getBot(req.params.botId);
  if (!bot) return res.status(404).json({ sucesso: false, message: "Bot nao configurado." });

  return res.json({
    sucesso: true,
    bot_id: bot.bot_id,
    membros: await countUsers(bot.bot_id),
    redirect_uri: bot.redirect_uri || redirectUri(),
  });
});

router.get("/api/auth02/bots", assertApiKey, requireDb, async (_req, res) => {
  const bots = await listBots();
  return res.json({
    sucesso: true,
    bots: bots.map(bot => ({
      bot_id: bot.bot_id,
      bot_username: bot.bot_username,
      guild_id: bot.guild_id,
      role_id: bot.role_id,
      webhook_configurado: !!resolveWebhookLogs(bot),
      membros: Number(bot.membros || 0),
      redirect_uri: bot.redirect_uri || redirectUri(),
      updated_at: bot.updated_at || null,
    })),
  });
});

async function handleAuth02Verify(req, res) {
  const code = String(req.query.code || "").trim();
  const stateInfo = parseOAuthState(req.query.state);
  const botId = stateInfo.botId;

  if (!code || !botId) return res.status(400).send("Codigo ou state ausente.");

  const dbOk = await ensureDb();
  if (!dbOk) return res.status(503).send(`Armazenamento indisponivel: ${lastDbError}`);

  try {
    const bot = await getBot(botId);
    if (!bot) return res.status(404).send("Bot Auth02 nao configurado.");

    const tokenResponse = await exchangeOAuthCode(bot, code, req);

    const tokenData = tokenResponse.data;
    const userResponse = await axios.get(`${DISCORD_API}/users/@me`, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
      timeout: 15000,
    });

    const user = userResponse.data;
    const guildCount = await getUserGuildCount(tokenData.access_token);
    const ip = clientIp(req);
    const geo = await getIpGeo(ip);
    const meta = {
      ip,
      ip_masked: maskIp(ip),
      ip_hash: ipHash(req),
      ip_country: geo.ip_country || req.headers["cf-ipcountry"] || null,
      ip_region: geo.ip_region || null,
      ip_city: geo.ip_city || null,
      ip_org: geo.ip_org || null,
      ip_asn: geo.ip_asn || null,
      ip_isp: geo.ip_isp || null,
      ip_latitude: geo.ip_latitude ?? null,
      ip_longitude: geo.ip_longitude ?? null,
      ip_timezone: geo.ip_timezone || null,
      ip_proxy_type: geo.ip_proxy_type || null,
      ip_proxy_probability: geo.ip_proxy_probability || null,
    };

    const guildId = stateInfo.guildId || bot.guild_id;
    const roleId = stateInfo.roleId || bot.role_id;
    const botRuntime = { ...bot, guild_id: guildId, role_id: roleId };

    await upsertUser({
      bot_id: bot.bot_id,
      guild_id: guildId,
      user_id: user.id,
      username: user.username,
      global_name: user.global_name || null,
      email: user.email || null,
      avatar_url: avatarUrl(user),
      discord_locale: user.locale || null,
      guild_count: guildCount,
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token || null,
      expires_at: expiresAt(tokenData.expires_in),
      ...meta,
      user_agent: req.get("user-agent") || null,
    });

    const siteUrl = stateInfo.returnUrl || safeReturnUrl(process.env.SUCCESS_REDIRECT_URL) || safeReturnUrl(process.env.SITE_URL || process.env.PUBLIC_SITE_URL);

    void (async () => {
      let memberStatus = guildId ? "Adicionado ao servidor" : "Servidor nao configurado";
      const guildName = await getBotGuildName(botRuntime, guildId);

      if (guildId) {
        try {
          await addMember(botRuntime, guildId, {
            user_id: user.id,
            access_token: tokenData.access_token,
            refresh_token: tokenData.refresh_token,
          });
          memberStatus = roleId ? "Adicionado com cargo" : "Adicionado ao servidor";
        } catch (err) {
          memberStatus = "Falha ao adicionar no servidor";
          console.error("[Auth02] Falha ao entrar/dar cargo:", err.response?.data || err.message);
        }
      }

      const webhookLogs = resolveWebhookLogs(bot);
      if (webhookLogs) {
        await axios.post(webhookLogs, {
          username: WEBHOOK_LOG_NAME,
          embeds: [buildVerificationLogEmbed({ bot: botRuntime, user, guildCount, meta, memberStatus, guildName })],
        }, { timeout: 8000 }).catch((err) => {
          console.error("[Auth02] Falha ao enviar webhook:", err.response?.data || err.message);
        });
      }
    })().catch((err) => console.error("[Auth02] Tarefa pos-verificacao falhou:", err.message));

    if (siteUrl) {
      return res.redirect(appendQuery(siteUrl, {
        verified: "1",
        bot_id: bot.bot_id,
        plan: stateInfo.plan,
        ref: stateInfo.ref,
      }));
    }

    return res.type("html").send(successPage({ bot: botRuntime, user, siteUrl }));
  } catch (err) {
    console.error("[Auth02 Callback]", {
      status: err.response?.status,
      data: err.response?.data,
      message: err.message,
    });
    return res.status(500).send("Erro ao concluir verificacao. Abra o painel do bot e confirme token, client secret e redirect URI Auth02.");
  }
}

router.get([
  "/auth02/verify",
  "/api/auth/discord/callback",
  "/api/auth/callback",
  "/auth/discord/callback",
  "/callback",
], handleAuth02Verify);

router.get("/api/auth02/check/:botId/:userId", assertApiKey, requireDb, async (req, res) => {
  const botId = String(req.params.botId || "").trim();
  const userId = String(req.params.userId || "").trim();

  if (!botId || !userId) {
    return res.status(400).json({ sucesso: false, message: "botId e userId sao obrigatorios." });
  }

  const user = await getUser(botId, userId);
  const isVerified = !!user;

  return res.json({
    sucesso: true,
    is_verified: isVerified,
    data: {
      is_verified: isVerified,
      user: user ? {
        bot_id: user.bot_id,
        guild_id: user.guild_id,
        user_id: user.user_id,
        username: user.username,
        global_name: user.global_name,
        verified_at: user.verified_at,
      } : null,
    },
  });
});

router.post("/api/auth02/pull", assertApiKey, requireDb, async (req, res) => {
  const botId = String(req.body.bot_id || "").trim();
  const guildId = String(req.body.guild_id || "").trim();
  const quantidade = Math.max(1, Math.min(Number(req.body.quantidade || 1), 500));

  if (!botId || !guildId) {
    return res.status(400).json({ sucesso: false, message: "bot_id e guild_id sao obrigatorios." });
  }

  const bot = await getBot(botId);
  if (!bot) return res.status(404).json({ sucesso: false, message: "Bot nao configurado." });

  const users = await listUsers(botId, quantidade);
  let adicionados = 0;
  let falhas = 0;

  for (const user of users) {
    try {
      await addMember(bot, guildId, user);
      adicionados += 1;
    } catch (err) {
      falhas += 1;
      console.error(`[Pull] Falha ${user.user_id}:`, err.response?.data || err.message);
    }
  }

  return res.json({
    sucesso: true,
    detalhes: {
      solicitados: users.length,
      adicionados,
      falhas,
    },
  });
});

module.exports = {
  router,
  ensureAuth02Db: ensureDb,
  handleAuth02Verify,
  auth02StorageStatus: storageStatus,
  auth02RedirectUri: redirectUri,
};
