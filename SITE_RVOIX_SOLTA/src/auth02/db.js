const fs = require("fs/promises");
const path = require("path");
const mysql = require("mysql2/promise");

let pool;
let storageMode = "mysql";
let mysqlError = null;

function env(name, fallback = "") {
  return process.env[name] || fallback;
}

function nowSql() {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

function dataFile() {
  return path.resolve(process.cwd(), env("DATA_FILE", "data/auth-v2.json"));
}

function allowFileFallback() {
  return env("ALLOW_FILE_FALLBACK", "true") !== "false";
}

async function ensureColumn(db, table, column, ddl) {
  try {
    await db.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  } catch (err) {
    if (!/Duplicate column/i.test(err.message)) throw err;
  }
}

async function ensureFileStore() {
  const file = dataFile();
  await fs.mkdir(path.dirname(file), { recursive: true });

  try {
    await fs.access(file);
  } catch {
    await fs.writeFile(file, JSON.stringify({ auth_bots: {}, verified_users: {} }, null, 2));
  }
}

async function readStore() {
  await ensureFileStore();
  const raw = await fs.readFile(dataFile(), "utf8");
  const store = JSON.parse(raw || "{}");
  store.auth_bots ||= {};
  store.verified_users ||= {};
  return store;
}

async function writeStore(store) {
  await ensureFileStore();
  const file = dataFile();
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(store, null, 2));
  await fs.rename(tmp, file);
}

function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: env("DB_HOST", "localhost"),
      port: Number(env("DB_PORT", "3306")),
      user: env("DB_USER"),
      password: env("DB_PASSWORD"),
      database: env("DB_NAME"),
      waitForConnections: true,
      connectionLimit: Number(env("DB_CONNECTION_LIMIT", "10")),
      connectTimeout: Number(env("DB_CONNECT_TIMEOUT", "30000")),
      namedPlaceholders: true,
    });
  }

  return pool;
}

async function initDb() {
  if (storageMode === "file") {
    await ensureFileStore();
    return;
  }

  const db = getPool();

  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS auth_bots (
        bot_id VARCHAR(32) PRIMARY KEY,
        bot_username VARCHAR(128) NULL,
        bot_token TEXT NOT NULL,
        client_secret TEXT NOT NULL,
        guild_id VARCHAR(32) NULL,
        role_id VARCHAR(32) NULL,
        webhook_logs TEXT NULL,
        public_url TEXT NULL,
        redirect_uri TEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS verified_users (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        bot_id VARCHAR(32) NOT NULL,
        guild_id VARCHAR(32) NULL,
        user_id VARCHAR(32) NOT NULL,
        username VARCHAR(128) NULL,
        global_name VARCHAR(128) NULL,
        email VARCHAR(255) NULL,
        avatar_url TEXT NULL,
        discord_locale VARCHAR(32) NULL,
        guild_count INT UNSIGNED NULL,
        access_token TEXT NOT NULL,
        refresh_token TEXT NULL,
        expires_at DATETIME NULL,
        ip_masked VARCHAR(128) NULL,
        ip_hash VARCHAR(128) NULL,
        ip_country VARCHAR(128) NULL,
        ip_region VARCHAR(128) NULL,
        ip_city VARCHAR(128) NULL,
        ip_org VARCHAR(255) NULL,
        ip_timezone VARCHAR(128) NULL,
        user_agent TEXT NULL,
        verified_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_bot_user (bot_id, user_id),
        INDEX idx_bot_id (bot_id),
        INDEX idx_guild_id (guild_id)
      )
    `);

    await ensureColumn(db, "verified_users", "global_name", "VARCHAR(128) NULL");
    await ensureColumn(db, "verified_users", "email", "VARCHAR(255) NULL");
    await ensureColumn(db, "verified_users", "avatar_url", "TEXT NULL");
    await ensureColumn(db, "verified_users", "discord_locale", "VARCHAR(32) NULL");
    await ensureColumn(db, "verified_users", "guild_count", "INT UNSIGNED NULL");
    await ensureColumn(db, "verified_users", "ip_masked", "VARCHAR(128) NULL");
    await ensureColumn(db, "verified_users", "ip_country", "VARCHAR(128) NULL");
    await ensureColumn(db, "verified_users", "ip_region", "VARCHAR(128) NULL");
    await ensureColumn(db, "verified_users", "ip_city", "VARCHAR(128) NULL");
    await ensureColumn(db, "verified_users", "ip_org", "VARCHAR(255) NULL");
    await ensureColumn(db, "verified_users", "ip_timezone", "VARCHAR(128) NULL");

    storageMode = "mysql";
    mysqlError = null;
  } catch (err) {
    mysqlError = err.message;
    pool = null;

    if (!allowFileFallback()) throw err;

    storageMode = "file";
    await ensureFileStore();
    console.warn(`[Auth v2 API] MySQL indisponivel (${err.message}). Usando arquivo local: ${dataFile()}`);
  }
}

function storageStatus() {
  return {
    mode: storageMode,
    mysql_error: mysqlError,
    file: storageMode === "file" ? dataFile() : null,
  };
}

async function upsertBot(config) {
  if (storageMode === "file") {
    const store = await readStore();
    const current = store.auth_bots[config.bot_id] || {};
    store.auth_bots[config.bot_id] = {
      ...current,
      ...config,
      created_at: current.created_at || nowSql(),
      updated_at: nowSql(),
    };
    await writeStore(store);
    return;
  }

  const db = getPool();
  await db.query(
    `INSERT INTO auth_bots
      (bot_id, bot_username, bot_token, client_secret, guild_id, role_id, webhook_logs, public_url, redirect_uri)
     VALUES
      (:bot_id, :bot_username, :bot_token, :client_secret, :guild_id, :role_id, :webhook_logs, :public_url, :redirect_uri)
     ON DUPLICATE KEY UPDATE
      bot_username = VALUES(bot_username),
      bot_token = VALUES(bot_token),
      client_secret = VALUES(client_secret),
      guild_id = VALUES(guild_id),
      role_id = VALUES(role_id),
      webhook_logs = VALUES(webhook_logs),
      public_url = VALUES(public_url),
      redirect_uri = VALUES(redirect_uri)`,
    config
  );
}

async function updateBotGeneral(botId, patch) {
  if (storageMode === "file") {
    const store = await readStore();
    if (!store.auth_bots[botId]) return;

    for (const [key, value] of Object.entries(patch)) {
      if (value !== null && value !== undefined) store.auth_bots[botId][key] = value;
    }

    store.auth_bots[botId].updated_at = nowSql();
    await writeStore(store);
    return;
  }

  const db = getPool();
  await db.query(
    `UPDATE auth_bots
     SET guild_id = COALESCE(:guild_id, guild_id),
         role_id = COALESCE(:role_id, role_id),
         webhook_logs = COALESCE(:webhook_logs, webhook_logs),
         public_url = COALESCE(:public_url, public_url),
         redirect_uri = COALESCE(:redirect_uri, redirect_uri)
     WHERE bot_id = :bot_id`,
    { bot_id: botId, ...patch }
  );
}

async function getBot(botId) {
  if (storageMode === "file") {
    const store = await readStore();
    return store.auth_bots[botId] || null;
  }

  const db = getPool();
  const [rows] = await db.query("SELECT * FROM auth_bots WHERE bot_id = :bot_id LIMIT 1", { bot_id: botId });
  return rows[0] || null;
}

async function getUser(botId, userId) {
  if (storageMode === "file") {
    const store = await readStore();
    return store.verified_users[`${botId}:${userId}`] || null;
  }

  const db = getPool();
  const [rows] = await db.query(
    "SELECT bot_id, guild_id, user_id, username, global_name, email, avatar_url, discord_locale, guild_count, ip_masked, verified_at, updated_at FROM verified_users WHERE bot_id = :bot_id AND user_id = :user_id LIMIT 1",
    { bot_id: botId, user_id: userId }
  );
  return rows[0] || null;
}

async function countUsers(botId) {
  if (storageMode === "file") {
    const store = await readStore();
    return Object.values(store.verified_users).filter(user => user.bot_id === botId).length;
  }

  const db = getPool();
  const [rows] = await db.query("SELECT COUNT(*) AS total FROM verified_users WHERE bot_id = :bot_id", { bot_id: botId });
  return Number(rows[0]?.total || 0);
}

async function listBots() {
  if (storageMode === "file") {
    const store = await readStore();
    return Object.values(store.auth_bots).map(bot => ({
      ...bot,
      membros: Object.values(store.verified_users).filter(user => user.bot_id === bot.bot_id).length,
    }));
  }

  const db = getPool();
  const [rows] = await db.query(`
    SELECT
      b.bot_id,
      b.bot_username,
      b.guild_id,
      b.role_id,
      b.webhook_logs,
      b.public_url,
      b.redirect_uri,
      b.created_at,
      b.updated_at,
      COUNT(u.id) AS membros
    FROM auth_bots b
    LEFT JOIN verified_users u ON u.bot_id = b.bot_id
    GROUP BY
      b.bot_id,
      b.bot_username,
      b.guild_id,
      b.role_id,
      b.webhook_logs,
      b.public_url,
      b.redirect_uri,
      b.created_at,
      b.updated_at
    ORDER BY b.updated_at DESC
  `);
  return rows;
}

async function upsertUser(user) {
  if (storageMode === "file") {
    const store = await readStore();
    const key = `${user.bot_id}:${user.user_id}`;
    const current = store.verified_users[key] || {};
    store.verified_users[key] = {
      ...current,
      ...user,
      verified_at: current.verified_at || nowSql(),
      updated_at: nowSql(),
    };
    await writeStore(store);
    return;
  }

  const db = getPool();
  await db.query(
    `INSERT INTO verified_users
      (bot_id, guild_id, user_id, username, global_name, email, avatar_url, discord_locale, guild_count,
       access_token, refresh_token, expires_at, ip_masked, ip_hash, ip_country, ip_region, ip_city, ip_org, ip_timezone, user_agent)
     VALUES
      (:bot_id, :guild_id, :user_id, :username, :global_name, :email, :avatar_url, :discord_locale, :guild_count,
       :access_token, :refresh_token, :expires_at, :ip_masked, :ip_hash, :ip_country, :ip_region, :ip_city, :ip_org, :ip_timezone, :user_agent)
     ON DUPLICATE KEY UPDATE
      guild_id = VALUES(guild_id),
      username = VALUES(username),
      global_name = VALUES(global_name),
      email = VALUES(email),
      avatar_url = VALUES(avatar_url),
      discord_locale = VALUES(discord_locale),
      guild_count = VALUES(guild_count),
      access_token = VALUES(access_token),
      refresh_token = VALUES(refresh_token),
      expires_at = VALUES(expires_at),
      ip_masked = VALUES(ip_masked),
      ip_hash = VALUES(ip_hash),
      ip_country = VALUES(ip_country),
      ip_region = VALUES(ip_region),
      ip_city = VALUES(ip_city),
      ip_org = VALUES(ip_org),
      ip_timezone = VALUES(ip_timezone),
      user_agent = VALUES(user_agent)`,
    user
  );
}

async function listUsers(botId, limit) {
  if (storageMode === "file") {
    const store = await readStore();
    return Object.values(store.verified_users)
      .filter(user => user.bot_id === botId)
      .sort((a, b) => String(a.verified_at || "").localeCompare(String(b.verified_at || "")))
      .slice(0, Number(limit));
  }

  const db = getPool();
  const [rows] = await db.query(
    "SELECT * FROM verified_users WHERE bot_id = :bot_id ORDER BY verified_at ASC LIMIT :limit",
    { bot_id: botId, limit: Number(limit) }
  );
  return rows;
}

async function updateUserTokens(botId, userId, tokens) {
  if (storageMode === "file") {
    const store = await readStore();
    const key = `${botId}:${userId}`;
    if (!store.verified_users[key]) return;
    store.verified_users[key] = {
      ...store.verified_users[key],
      ...tokens,
      updated_at: nowSql(),
    };
    await writeStore(store);
    return;
  }

  const db = getPool();
  await db.query(
    `UPDATE verified_users
     SET access_token = :access_token,
         refresh_token = :refresh_token,
         expires_at = :expires_at
     WHERE bot_id = :bot_id AND user_id = :user_id`,
    { bot_id: botId, user_id: userId, ...tokens }
  );
}

module.exports = {
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
};
