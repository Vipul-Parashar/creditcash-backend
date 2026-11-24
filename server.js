// server.ts
import fs3 from "node:fs";
import path3 from "node:path";
import express from "express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { createServer as createViteServer } from "vite";

// server/config.ts
import dotenv from "dotenv";
dotenv.config();
var config = {
  nodeEnv: process.env.NODE_ENV || "development",
  isProd: process.env.NODE_ENV === "production",
  port: Number.parseInt(process.env.PORT || "3000", 10),
  appUrl: (process.env.APP_URL || "http://localhost:3000").replace(/\/+$/, ""),
  sessionSecret: process.env.SESSION_SECRET || "dev-kredova-session-secret-change-in-prod",
  cookieSecure: process.env.COOKIE_SECURE === "true" || process.env.NODE_ENV === "production",
  db: {
    connectionString: process.env.DATABASE_URL || "",
    driver: process.env.DB_DRIVER || (process.env.DATABASE_URL || process.env.PGHOST ? "postgres" : "sqlite"),
    sqlitePath: process.env.SQLITE_DB_PATH || "./data/kredova.db",
    pgHost: process.env.PGHOST || "",
    pgPort: Number.parseInt(process.env.PGPORT || "5432", 10),
    pgDatabase: process.env.PGDATABASE || "",
    pgUser: process.env.PGUSER || "",
    pgPassword: process.env.PGPASSWORD || "",
    pgSslMode: process.env.PGSSLMODE || "prefer"
  },
  adminBootstrap: {
    email: process.env.ADMIN_BOOTSTRAP_EMAIL || "admin@kredova.local",
    password: process.env.ADMIN_BOOTSTRAP_PASSWORD || "Admin@Kredova2026!"
  },
  providers: {
    ayet: {
      adslotId: process.env.AYET_ADSLOT_ID || "",
      publisherApiKey: process.env.AYET_PUBLISHER_API_KEY || "",
      placementName: process.env.AYET_PLACEMENT_NAME || "Kredova Offerwall"
    },
    cpx: {
      appId: process.env.CPX_APP_ID || "",
      secureHashSecret: process.env.CPX_SECURE_HASH_SECRET || ""
    },
    adgem: {
      appId: process.env.ADGEM_APP_ID || "",
      postbackKey: process.env.ADGEM_POSTBACK_KEY || "",
      allowedIps: process.env.ADGEM_ALLOWED_IPS || ""
    }
  }
};

// server/db/database.ts
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
function adaptSqlForSqlite(sql, params) {
  const values = [];
  let transformed = sql.replace(/\bNOW\(\)/gi, "CURRENT_TIMESTAMP").replace(/::jsonb/gi, "").replace(/\bILIKE\b/gi, "LIKE");
  transformed = transformed.replace(/\$(\d+)/g, (_match, indexStr) => {
    const idx = Number.parseInt(indexStr, 10) - 1;
    const val = params[idx];
    if (typeof val === "boolean") {
      values.push(val ? 1 : 0);
    } else if (val instanceof Date) {
      values.push(val.toISOString());
    } else if (val === void 0) {
      values.push(null);
    } else {
      values.push(val);
    }
    return "?";
  });
  return { sql: transformed, values };
}
var SQLITE_SCHEMA_SQL = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS admin_roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  permissions TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_uid TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'advertiser', 'moderator', 'finance_admin', 'super_admin')),
  admin_role_id INTEGER REFERENCES admin_roles(id) ON DELETE SET NULL,
  account_status TEXT NOT NULL DEFAULT 'active' CHECK (account_status IN ('active', 'suspended', 'banned', 'pending_verification')),
  email_verified INTEGER NOT NULL DEFAULT 0,
  referral_code TEXT NOT NULL UNIQUE,
  referred_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  signup_ip TEXT,
  last_login_ip TEXT,
  device_fingerprint TEXT,
  phone TEXT DEFAULT '',
  upi_id TEXT DEFAULT '',
  bank_account_holder TEXT DEFAULT '',
  bank_account_number TEXT DEFAULT '',
  bank_ifsc TEXT DEFAULT '',
  bank_name TEXT DEFAULT '',
  terms_accepted_at TEXT NOT NULL,
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code);
CREATE INDEX IF NOT EXISTS idx_users_signup_ip ON users(signup_ip);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(account_status);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_token TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

CREATE TABLE IF NOT EXISTS auth_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_type TEXT NOT NULL CHECK (token_type IN ('email_verification', 'password_reset')),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS advertisers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  company_name TEXT NOT NULL,
  website_url TEXT NOT NULL,
  contact_email TEXT NOT NULL,
  tax_id TEXT DEFAULT '',
  approval_status TEXT NOT NULL DEFAULT 'pending' CHECK (approval_status IN ('pending', 'approved', 'rejected', 'suspended')),
  notes TEXT DEFAULT '',
  reviewed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS advertising_providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  provider_type TEXT NOT NULL CHECK (provider_type IN ('offerwall', 'survey', 'video', 'direct')),
  is_enabled INTEGER NOT NULL DEFAULT 0,
  user_reward_percentage INTEGER NOT NULL DEFAULT 70 CHECK (user_reward_percentage >= 10 AND user_reward_percentage <= 100),
  docs_url TEXT NOT NULL,
  postback_path TEXT NOT NULL,
  supported_categories TEXT NOT NULL DEFAULT '[]',
  notes TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS provider_credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id INTEGER NOT NULL UNIQUE REFERENCES advertising_providers(id) ON DELETE CASCADE,
  env_app_id_key TEXT NOT NULL,
  env_secret_key TEXT NOT NULL,
  public_app_id TEXT DEFAULT '',
  allowed_postback_ips TEXT DEFAULT '',
  configuration_status TEXT NOT NULL DEFAULT 'not_configured' CHECK (configuration_status IN ('not_configured', 'configured', 'verified')),
  last_verified_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id INTEGER REFERENCES advertising_providers(id) ON DELETE SET NULL,
  advertiser_id INTEGER REFERENCES advertisers(id) ON DELETE SET NULL,
  external_offer_id TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('watch', 'download', 'surveys', 'offers')),
  reward_paise INTEGER NOT NULL CHECK (reward_paise > 0),
  budget_paise INTEGER NOT NULL DEFAULT 0 CHECK (budget_paise >= 0),
  spent_paise INTEGER NOT NULL DEFAULT 0 CHECK (spent_paise >= 0),
  estimated_minutes INTEGER,
  instructions TEXT NOT NULL,
  eligibility_info TEXT NOT NULL,
  destination_url TEXT,
  image_url TEXT,
  incentivized_permitted INTEGER NOT NULL DEFAULT 1,
  approval_status TEXT NOT NULL DEFAULT 'pending_review' CHECK (approval_status IN ('pending_review', 'approved', 'paused', 'rejected', 'completed')),
  rejection_reason TEXT DEFAULT '',
  reviewed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_campaigns_category_status ON campaigns(category, approval_status);

CREATE TABLE IF NOT EXISTS wallet_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  available_paise INTEGER NOT NULL DEFAULT 0 CHECK (available_paise >= 0),
  pending_paise INTEGER NOT NULL DEFAULT 0 CHECK (pending_paise >= 0),
  lifetime_earned_paise INTEGER NOT NULL DEFAULT 0 CHECK (lifetime_earned_paise >= 0),
  total_withdrawn_paise INTEGER NOT NULL DEFAULT 0 CHECK (total_withdrawn_paise >= 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS offer_conversions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_id INTEGER NOT NULL REFERENCES advertising_providers(id) ON DELETE RESTRICT,
  campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
  provider_conversion_ref TEXT NOT NULL,
  external_offer_id TEXT,
  offer_name TEXT NOT NULL DEFAULT '',
  gross_payout_paise INTEGER NOT NULL DEFAULT 0,
  user_reward_paise INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'reversed')),
  signature_verified INTEGER NOT NULL DEFAULT 0,
  source_ip TEXT,
  raw_payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (provider_id, provider_conversion_ref)
);

CREATE INDEX IF NOT EXISTS idx_conversions_user_status ON offer_conversions(user_id, status);

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tx_uid TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_id INTEGER REFERENCES advertising_providers(id) ON DELETE SET NULL,
  campaign_id INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
  amount_paise INTEGER NOT NULL,
  transaction_type TEXT NOT NULL CHECK (transaction_type IN ('offer_reward', 'survey_reward', 'video_reward', 'referral_bonus', 'withdrawal_debit', 'withdrawal_refund', 'reward_reversal', 'admin_adjustment')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'reversed')),
  provider_conversion_ref TEXT,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_tx_provider_ref
  ON wallet_transactions(provider_id, provider_conversion_ref, transaction_type)
  WHERE provider_conversion_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_wallet_tx_user_created ON wallet_transactions(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS withdrawal_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_uid TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  method TEXT NOT NULL CHECK (method IN ('upi', 'bank')),
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  upi_id TEXT DEFAULT '',
  bank_account_holder TEXT DEFAULT '',
  bank_account_number TEXT DEFAULT '',
  bank_ifsc TEXT DEFAULT '',
  bank_name TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'processing', 'paid', 'rejected')),
  admin_note TEXT DEFAULT '',
  payment_reference TEXT DEFAULT '',
  reviewed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at TEXT,
  paid_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_withdrawals_user_status ON withdrawal_requests(user_id, status);

CREATE TABLE IF NOT EXISTS referral_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  referrer_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referred_user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  bonus_paise INTEGER NOT NULL DEFAULT 0 CHECK (bonus_paise >= 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'qualified', 'credited', 'flagged_fraud', 'rejected')),
  fraud_check_note TEXT DEFAULT '',
  credited_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referral_records(referrer_user_id);

CREATE TABLE IF NOT EXISTS support_tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_uid TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL DEFAULT 'general',
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
  admin_reply TEXT DEFAULT '',
  assigned_admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'system',
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  ip_address TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS fraud_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  alert_type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  description TEXT NOT NULL,
  source_ip TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'investigating', 'resolved', 'dismissed')),
  resolution_note TEXT DEFAULT '',
  resolved_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS website_settings (
  setting_key TEXT PRIMARY KEY,
  setting_value TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  updated_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS contact_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  ip_address TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`;
var SqliteAdapter = class {
  constructor() {
    this.driver = "sqlite";
    this.db = null;
  }
  async init() {
    if (this.db) return;
    const dbPath = path.resolve(process.cwd(), config.db.sqlitePath);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(SQLITE_SCHEMA_SQL);
  }
  getInstance() {
    if (!this.db) {
      throw new Error("Database not initialized.");
    }
    return this.db;
  }
  async query(sql, params = []) {
    const db2 = this.getInstance();
    const { sql: adaptedSql, values } = adaptSqlForSqlite(sql, params);
    const trimmed = adaptedSql.trim();
    const stmt = db2.prepare(trimmed);
    const returnsRows = /^(SELECT|WITH|PRAGMA)\b/i.test(trimmed) || /\bRETURNING\b/i.test(trimmed);
    if (returnsRows) {
      const rows = stmt.all(...values);
      return { rows, rowCount: rows.length };
    }
    const result = stmt.run(...values);
    return { rows: [], rowCount: Number(result.changes ?? 0) };
  }
  async transaction(fn) {
    const db2 = this.getInstance();
    db2.exec("BEGIN IMMEDIATE");
    try {
      const result = await fn(this);
      db2.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        db2.exec("ROLLBACK");
      } catch {
      }
      throw err;
    }
  }
  async close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
};
var PostgresAdapter = class {
  constructor() {
    this.driver = "postgres";
    if (config.db.connectionString) {
      this.pool = new Pool({
        connectionString: config.db.connectionString,
        ssl: { rejectUnauthorized: false },
        max: 10,
        connectionTimeoutMillis: 15e3
      });
    } else {
      this.pool = new Pool({
        host: config.db.pgHost,
        port: config.db.pgPort,
        database: config.db.pgDatabase,
        user: config.db.pgUser,
        password: config.db.pgPassword,
        ssl: config.db.pgSslMode === "require" ? { rejectUnauthorized: false } : void 0,
        max: 10,
        connectionTimeoutMillis: 15e3
      });
    }
    this.pool.on("error", (err) => {
      console.error("Idle PostgreSQL client error:", err);
    });
  }
  async init() {
    const migDir = path.resolve(process.cwd(), "migrations");
    if (fs.existsSync(migDir)) {
      const files = fs.readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort();
      for (const file of files) {
        const sql = fs.readFileSync(path.join(migDir, file), "utf8");
        await this.pool.query(sql);
      }
    }
  }
  async query(sql, params = []) {
    const res = await this.pool.query(sql, params);
    return { rows: res.rows, rowCount: res.rowCount ?? res.rows.length };
  }
  async transaction(fn) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const txClient = {
        query: async (sql, params = []) => {
          const res = await client.query(sql, params);
          return { rows: res.rows, rowCount: res.rowCount ?? res.rows.length };
        }
      };
      const result = await fn(txClient);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
  async close() {
    await this.pool.end();
  }
};
var db = config.db.driver === "postgres" && config.db.pgHost ? new PostgresAdapter() : new SqliteAdapter();

// server/db/seed.ts
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
async function seedDatabase() {
  const roles = [
    {
      slug: "super_admin",
      name: "Super Administrator",
      description: "Full platform administration, RBAC, financial payout execution, and security settings.",
      permissions: JSON.stringify(["*"])
    },
    {
      slug: "finance_admin",
      name: "Finance & Payout Admin",
      description: "Review and approve/mark paid UPI & bank withdrawals, inspect ledger transactions and reports.",
      permissions: JSON.stringify(["withdrawals.manage", "transactions.read", "reports.read", "users.read"])
    },
    {
      slug: "moderator",
      name: "Campaign & Support Moderator",
      description: "Review direct advertiser campaigns, respond to support tickets, and triage fraud alerts.",
      permissions: JSON.stringify(["campaigns.manage", "tickets.manage", "fraud.manage", "users.read"])
    }
  ];
  for (const r of roles) {
    await db.query(
      `INSERT INTO admin_roles (slug, name, description, permissions)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (slug) DO NOTHING`,
      [r.slug, r.name, r.description, r.permissions]
    );
  }
  const settings = [
    ["platform_name", "Kredova", "Public platform brand name"],
    ["currency_code", "INR", "Display currency code (stored internally as exact integer paise)"],
    ["min_withdrawal_paise", "10000", "Minimum withdrawal threshold in paise (10000 = \u20B9100.00)"],
    ["referral_bonus_paise", "2500", "Referral bonus in paise awarded after referred user completes a verified conversion (2500 = \u20B925.00)"],
    ["referral_program_enabled", "true", "Enable or pause referral bonus credits"],
    ["support_email", "support@kredova.example", "Public support contact email"],
    ["withdrawal_review_notice", "All UPI and bank transfer requests are manually verified by our finance team within 2\u20135 business days.", "Disclosure displayed on withdrawal screen"],
    ["require_email_verification_for_withdrawal", "true", "Require verified email before submitting withdrawal requests"]
  ];
  for (const [key, val, desc] of settings) {
    await db.query(
      `INSERT INTO website_settings (setting_key, setting_value, description)
       VALUES ($1, $2, $3)
       ON CONFLICT (setting_key) DO NOTHING`,
      [key, val, desc]
    );
  }
  const providers = [
    {
      slug: "ayet_studios",
      name: "ayeT-Studios",
      providerType: "offerwall",
      isEnabled: true,
      userRewardPercentage: 70,
      docsUrl: "https://www.ayetstudios.com/publishers",
      postbackPath: "/api/postbacks/ayet-studios",
      supportedCategories: JSON.stringify(["offers", "download", "watch"]),
      notes: "Official web offerwall & rewarded formats. Verified via X-Ayetstudios-Security-Hash (HMAC-SHA256 of sorted query parameters using AYET_PUBLISHER_API_KEY).",
      envAppIdKey: "AYET_ADSLOT_ID",
      envSecretKey: "AYET_PUBLISHER_API_KEY",
      configured: Boolean(config.providers.ayet.adslotId && config.providers.ayet.publisherApiKey),
      publicAppId: config.providers.ayet.adslotId,
      allowedIps: ""
    },
    {
      slug: "cpx_research",
      name: "CPX Research",
      providerType: "survey",
      isEnabled: true,
      userRewardPercentage: 75,
      docsUrl: "https://www.cpx-research.com",
      postbackPath: "/api/postbacks/cpx-research",
      supportedCategories: JSON.stringify(["surveys"]),
      notes: "Official monetized survey interface. Verified via MD5 secure_hash using CPX_SECURE_HASH_SECRET; handles status=1 (approved) and status=2 (reversed).",
      envAppIdKey: "CPX_APP_ID",
      envSecretKey: "CPX_SECURE_HASH_SECRET",
      configured: Boolean(config.providers.cpx.appId && config.providers.cpx.secureHashSecret),
      publicAppId: config.providers.cpx.appId,
      allowedIps: ""
    },
    {
      slug: "adgem",
      name: "AdGem",
      providerType: "offerwall",
      isEnabled: true,
      userRewardPercentage: 70,
      docsUrl: "https://adgem.com",
      postbackPath: "/api/postbacks/adgem",
      supportedCategories: JSON.stringify(["offers", "download"]),
      notes: "Official web offerwall with player_id tracking. Verified via v3 POST HMAC-SHA256 Signature header over raw JSON body using ADGEM_POSTBACK_KEY.",
      envAppIdKey: "ADGEM_APP_ID",
      envSecretKey: "ADGEM_POSTBACK_KEY",
      configured: Boolean(config.providers.adgem.appId && config.providers.adgem.postbackKey),
      publicAppId: config.providers.adgem.appId,
      allowedIps: config.providers.adgem.allowedIps
    }
  ];
  for (const p of providers) {
    await db.query(
      `INSERT INTO advertising_providers (slug, name, provider_type, is_enabled, user_reward_percentage, docs_url, postback_path, supported_categories, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (slug) DO NOTHING`,
      [
        p.slug,
        p.name,
        p.providerType,
        p.isEnabled ? 1 : 0,
        p.userRewardPercentage,
        p.docsUrl,
        p.postbackPath,
        p.supportedCategories,
        p.notes
      ]
    );
    const provRow = await db.query(
      `SELECT id FROM advertising_providers WHERE slug = $1`,
      [p.slug]
    );
    const providerId = provRow.rows[0]?.id;
    if (providerId) {
      const status = p.configured ? "configured" : "not_configured";
      await db.query(
        `INSERT INTO provider_credentials (provider_id, env_app_id_key, env_secret_key, public_app_id, allowed_postback_ips, configuration_status)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (provider_id) DO UPDATE SET
           public_app_id = EXCLUDED.public_app_id,
           allowed_postback_ips = EXCLUDED.allowed_postback_ips,
           configuration_status = CASE WHEN provider_credentials.configuration_status = 'verified' AND EXCLUDED.configuration_status = 'configured' THEN 'verified' ELSE EXCLUDED.configuration_status END`,
        [providerId, p.envAppIdKey, p.envSecretKey, p.publicAppId, p.allowedIps, status]
      );
    }
  }
  const existingAdmin = await db.query(
    `SELECT id FROM users WHERE role = 'super_admin' LIMIT 1`
  );
  if (existingAdmin.rows.length === 0) {
    const superRole = await db.query(
      `SELECT id FROM admin_roles WHERE slug = 'super_admin' LIMIT 1`
    );
    const passwordHash = await bcrypt.hash(config.adminBootstrap.password, 12);
    const publicUid = "ADM_" + crypto.randomBytes(6).toString("hex").toUpperCase();
    const referralCode = "KRDADMIN01";
    const inserted = await db.query(
      `INSERT INTO users (public_uid, full_name, email, password_hash, role, admin_role_id, account_status, email_verified, referral_code, terms_accepted_at)
       VALUES ($1, $2, $3, $4, 'super_admin', $5, 'active', 1, $6, CURRENT_TIMESTAMP)
       RETURNING id`,
      [
        publicUid,
        "Platform Administrator",
        config.adminBootstrap.email.toLowerCase(),
        passwordHash,
        superRole.rows[0]?.id ?? null,
        referralCode
      ]
    );
    const adminId = inserted.rows[0]?.id;
    if (adminId) {
      await db.query(
        `INSERT INTO wallet_accounts (user_id, available_paise, pending_paise, lifetime_earned_paise, total_withdrawn_paise)
         VALUES ($1, 0, 0, 0, 0)
         ON CONFLICT (user_id) DO NOTHING`,
        [adminId]
      );
    }
  }
}

// server/middleware/auth.ts
import crypto2 from "node:crypto";
var SESSION_COOKIE_NAME = "kredova_sid";
function hashToken(rawToken) {
  return crypto2.createHmac("sha256", config.sessionSecret).update(rawToken).digest("hex");
}
function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "127.0.0.1";
}
async function createSession(userId, ipAddress, userAgent) {
  const rawToken = crypto2.randomBytes(32).toString("hex");
  const tokenHash = hashToken(rawToken);
  const csrfToken = crypto2.randomBytes(24).toString("hex");
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1e3);
  await db.query(
    `INSERT INTO sessions (user_id, token_hash, csrf_token, ip_address, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, tokenHash, csrfToken, ipAddress, userAgent.slice(0, 300), expiresAt.toISOString()]
  );
  return { rawToken, csrfToken, expiresAt };
}
function setSessionCookie(res, rawToken, expiresAt) {
  res.cookie(SESSION_COOKIE_NAME, rawToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.cookieSecure,
    expires: expiresAt,
    path: "/"
  });
}
function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.cookieSecure,
    path: "/"
  });
}
async function attachSession(req, _res, next) {
  try {
    const rawToken = req.cookies?.[SESSION_COOKIE_NAME];
    if (!rawToken || typeof rawToken !== "string") {
      next();
      return;
    }
    const tokenHash = hashToken(rawToken);
    const res = await db.query(
      `SELECT s.id AS session_id, s.csrf_token, s.expires_at,
              u.id AS user_id, u.public_uid, u.full_name, u.email, u.role,
              u.account_status, u.email_verified, u.referral_code,
              ar.permissions AS role_permissions
       FROM sessions s
       INNER JOIN users u ON u.id = s.user_id
       LEFT JOIN admin_roles ar ON ar.id = u.admin_role_id
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL`,
      [tokenHash]
    );
    const row = res.rows[0];
    if (!row) {
      next();
      return;
    }
    if (new Date(row.expires_at).getTime() < Date.now()) {
      next();
      return;
    }
    let permissions = [];
    if (Array.isArray(row.role_permissions)) {
      permissions = row.role_permissions;
    } else if (typeof row.role_permissions === "string") {
      try {
        permissions = JSON.parse(row.role_permissions);
      } catch {
        permissions = [];
      }
    }
    req.sessionId = row.session_id;
    req.csrfToken = row.csrf_token;
    req.user = {
      id: row.user_id,
      publicUid: row.public_uid,
      fullName: row.full_name,
      email: row.email,
      role: row.role,
      accountStatus: row.account_status,
      emailVerified: Boolean(row.email_verified),
      referralCode: row.referral_code,
      permissions
    };
    next();
  } catch (err) {
    next(err);
  }
}
function requireAuth(req, res, next) {
  if (!req.user) {
    res.status(401).json({ error: "Authentication required. Please log in." });
    return;
  }
  if (req.user.accountStatus === "banned" || req.user.accountStatus === "suspended") {
    res.status(403).json({
      error: `Account is currently ${req.user.accountStatus}. Contact support for assistance.`
    });
    return;
  }
  next();
}
function requireAdmin(requiredPermission) {
  return (req, res, next) => {
    if (!req.user) {
      res.status(401).json({ error: "Admin authentication required." });
      return;
    }
    const adminRoles = /* @__PURE__ */ new Set(["super_admin", "finance_admin", "moderator"]);
    if (!adminRoles.has(req.user.role)) {
      res.status(403).json({ error: "Forbidden: administrator privileges required." });
      return;
    }
    if (requiredPermission && req.user.role !== "super_admin" && !req.user.permissions.includes("*") && !req.user.permissions.includes(requiredPermission)) {
      res.status(403).json({ error: `Forbidden: missing permission '${requiredPermission}'.` });
      return;
    }
    next();
  };
}

// server/domain/postbacks.ts
import crypto3 from "node:crypto";
function timingSafeHexEqual(expectedHex, actualHex) {
  if (!expectedHex || !actualHex) return false;
  const normalizedExpected = expectedHex.trim().toLowerCase();
  const normalizedActual = actualHex.trim().toLowerCase();
  if (normalizedExpected.length !== normalizedActual.length) return false;
  const bufA = Buffer.from(normalizedExpected, "utf8");
  const bufB = Buffer.from(normalizedActual, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto3.timingSafeEqual(bufA, bufB);
}
function buildAyetSortedQueryString(rawQuery) {
  const entries = [];
  for (const [key, value] of Object.entries(rawQuery)) {
    if (value === void 0) continue;
    const strVal = Array.isArray(value) ? value[0] ?? "" : String(value);
    entries.push([key, strVal]);
  }
  entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const params = new URLSearchParams(entries);
  return params.toString();
}
function computeAyetSecurityHash(rawQuery, publisherApiKey) {
  const sortedQuery = buildAyetSortedQueryString(rawQuery);
  return crypto3.createHmac("sha256", publisherApiKey).update(sortedQuery).digest("hex");
}
function verifyAyetPostbackSignature(rawQuery, incomingHeaderHash, publisherApiKey) {
  if (!publisherApiKey || !incomingHeaderHash) return false;
  const expected = computeAyetSecurityHash(rawQuery, publisherApiKey);
  return timingSafeHexEqual(expected, incomingHeaderHash);
}
function buildAyetOfferwallUrl(adslotId, externalIdentifier) {
  const params = new URLSearchParams({
    external_identifier: externalIdentifier
  });
  return `https://www.ayetstudios.com/offers/web_offerwall/${encodeURIComponent(adslotId)}?${params.toString()}`;
}
function computeCpxUserSecureHash(extUserId, secureHashSecret) {
  return crypto3.createHash("md5").update(`${extUserId}-${secureHashSecret}`).digest("hex");
}
function computeCpxPostbackHash(transId, secureHashSecret) {
  return crypto3.createHash("md5").update(`${transId}-${secureHashSecret}`).digest("hex");
}
function verifyCpxPostbackHash(transId, incomingHash, secureHashSecret) {
  if (!transId || !incomingHash || !secureHashSecret) return false;
  const expected = computeCpxPostbackHash(transId, secureHashSecret);
  return timingSafeHexEqual(expected, incomingHash);
}
function buildCpxSurveyUrl(params) {
  const secureHash = computeCpxUserSecureHash(params.extUserId, params.secureHashSecret);
  const query = new URLSearchParams({
    app_id: params.appId,
    ext_user_id: params.extUserId,
    secure_hash: secureHash
  });
  if (params.username) query.set("username", params.username);
  if (params.email) query.set("email", params.email);
  return `https://offers.cpx-research.com/index.php?${query.toString()}`;
}
function computeAdGemSignature(rawBody, postbackKey) {
  return crypto3.createHmac("sha256", postbackKey).update(rawBody).digest("hex");
}
function verifyAdGemPostbackSignature(rawBody, incomingSignature, postbackKey) {
  if (!postbackKey || !incomingSignature) return false;
  const expected = computeAdGemSignature(rawBody, postbackKey);
  return timingSafeHexEqual(expected, incomingSignature);
}
function isIpAllowed(clientIp, allowedIpsCsv) {
  const trimmed = allowedIpsCsv.trim();
  if (!trimmed) return true;
  const allowList = trimmed.split(",").map((ip) => ip.trim()).filter(Boolean);
  if (allowList.length === 0) return true;
  const normalizedClient = clientIp.replace(/^::ffff:/, "").trim();
  return allowList.includes(normalizedClient);
}
function buildAdGemOfferwallUrl(appId, playerId) {
  const query = new URLSearchParams({
    appid: appId,
    playerid: playerId
  });
  return `https://api.adgem.com/v1/wall?${query.toString()}`;
}

// server/middleware/csrf.ts
function verifyCsrf(req, res, next) {
  const safeMethods = /* @__PURE__ */ new Set(["GET", "HEAD", "OPTIONS"]);
  if (safeMethods.has(req.method.toUpperCase())) {
    next();
    return;
  }
  if (!req.sessionId || !req.csrfToken) {
    next();
    return;
  }
  const headerToken = req.headers["x-csrf-token"];
  if (typeof headerToken !== "string" || !timingSafeHexEqual(req.csrfToken, headerToken)) {
    res.status(403).json({ error: "Invalid or missing CSRF security token. Please refresh and try again." });
    return;
  }
  next();
}

// server/routes/publicRoutes.ts
import { Router } from "express";
import { z } from "zod";

// server/middleware/rateLimits.ts
import rateLimit from "express-rate-limit";
var authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1e3,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many authentication attempts. Please wait 15 minutes and try again." }
});
var withdrawalRateLimit = rateLimit({
  windowMs: 15 * 60 * 1e3,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many withdrawal requests. Please try again later." }
});
var contactRateLimit = rateLimit({
  windowMs: 15 * 60 * 1e3,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many contact submissions. Please wait a few minutes." }
});
var postbackRateLimit = rateLimit({
  windowMs: 60 * 1e3,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Postback rate limit exceeded." }
});

// server/routes/publicRoutes.ts
var publicRoutes = Router();
publicRoutes.get("/stats", async (_req, res) => {
  try {
    const [usersRes, campaignsRes, conversionsRes, paidWithdrawalsRes, providersRes, settingsRes] = await Promise.all([
      db.query(
        `SELECT COUNT(*) AS count FROM users WHERE role IN ('user', 'advertiser') AND account_status = 'active'`
      ),
      db.query(
        `SELECT COUNT(*) AS count FROM campaigns WHERE approval_status = 'approved'`
      ),
      db.query(
        `SELECT COUNT(*) AS count FROM offer_conversions WHERE status = 'approved'`
      ),
      db.query(
        `SELECT COALESCE(SUM(amount_paise), 0) AS total_paise, COUNT(*) AS count FROM withdrawal_requests WHERE status = 'paid'`
      ),
      db.query(
        `SELECT p.slug, p.name, p.provider_type, p.is_enabled, COALESCE(pc.configuration_status, 'not_configured') AS configuration_status
           FROM advertising_providers p
           LEFT JOIN provider_credentials pc ON pc.provider_id = p.id
           ORDER BY p.id ASC`
      ),
      db.query(
        `SELECT setting_key, setting_value FROM website_settings
           WHERE setting_key IN ('platform_name', 'min_withdrawal_paise', 'referral_bonus_paise', 'support_email')`
      )
    ]);
    const settingsMap = {};
    for (const row of settingsRes.rows) {
      settingsMap[row.setting_key] = row.setting_value;
    }
    res.json({
      registeredMembers: Number(usersRes.rows[0]?.count ?? 0),
      approvedCampaigns: Number(campaignsRes.rows[0]?.count ?? 0),
      verifiedCompletions: Number(conversionsRes.rows[0]?.count ?? 0),
      totalPaidOutPaise: Number(paidWithdrawalsRes.rows[0]?.total_paise ?? 0),
      completedPayoutCount: Number(paidWithdrawalsRes.rows[0]?.count ?? 0),
      minWithdrawalPaise: Number.parseInt(settingsMap.min_withdrawal_paise || "10000", 10),
      referralBonusPaise: Number.parseInt(settingsMap.referral_bonus_paise || "2500", 10),
      supportEmail: settingsMap.support_email || "support@kredova.example",
      providers: providersRes.rows.map((p) => ({
        slug: p.slug,
        name: p.name,
        providerType: p.provider_type,
        isEnabled: Boolean(p.is_enabled),
        configurationStatus: p.configuration_status
      }))
    });
  } catch (err) {
    console.error("Public stats error:", err);
    res.status(500).json({ error: "Unable to load platform statistics." });
  }
});
var contactSchema = z.object({
  fullName: z.string().trim().min(2, "Full name is required").max(160),
  email: z.string().trim().email("Please enter a valid email address").max(255),
  subject: z.string().trim().min(3, "Subject must be at least 3 characters").max(200),
  message: z.string().trim().min(10, "Message must be at least 10 characters").max(3e3)
});
publicRoutes.post("/contact", contactRateLimit, async (req, res) => {
  const parsed = contactSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid contact inquiry." });
    return;
  }
  try {
    const ip = getClientIp(req);
    await db.query(
      `INSERT INTO contact_messages (full_name, email, subject, message, ip_address)
       VALUES ($1, $2, $3, $4, $5)`,
      [parsed.data.fullName, parsed.data.email.toLowerCase(), parsed.data.subject, parsed.data.message, ip]
    );
    res.status(201).json({
      message: "Your inquiry has been recorded. Our team will respond via email within 1\u20132 business days."
    });
  } catch (err) {
    console.error("Contact submission error:", err);
    res.status(500).json({ error: "Could not submit inquiry. Please try again." });
  }
});

// server/routes/authRoutes.ts
import crypto5 from "node:crypto";
import bcrypt2 from "bcryptjs";
import { Router as Router2 } from "express";
import { z as z2 } from "zod";

// server/domain/antifraud.ts
var UPI_REGEX = /^[a-zA-Z0-9._-]{2,64}@[a-zA-Z0-9]{2,32}$/;
var IFSC_REGEX = /^[A-Z]{4}0[A-Z0-9]{6}$/;
function evaluateWithdrawalEligibility(input) {
  const fraudFlags = [];
  if (input.accountStatus !== "active") {
    return {
      ok: false,
      error: "Your account is currently restricted and cannot request withdrawals.",
      fraudFlags
    };
  }
  if (input.requireEmailVerification && !input.emailVerified) {
    return {
      ok: false,
      error: "Please verify your email address before requesting a withdrawal.",
      fraudFlags
    };
  }
  if (!Number.isInteger(input.requestedPaise) || input.requestedPaise <= 0) {
    return { ok: false, error: "Withdrawal amount must be a positive amount.", fraudFlags };
  }
  if (input.requestedPaise < input.minWithdrawalPaise) {
    return {
      ok: false,
      error: `Minimum withdrawal amount is \u20B9${(input.minWithdrawalPaise / 100).toFixed(2)}.`,
      fraudFlags
    };
  }
  if (input.requestedPaise > input.availablePaise) {
    return { ok: false, error: "Insufficient available wallet balance.", fraudFlags };
  }
  if (input.pendingWithdrawalsCount >= 3) {
    fraudFlags.push({
      alertType: "withdrawal_velocity",
      severity: "medium",
      description: `User attempted withdrawal while ${input.pendingWithdrawalsCount} requests remain pending.`
    });
    return {
      ok: false,
      error: "You already have pending withdrawal requests under review. Please wait for processing.",
      fraudFlags
    };
  }
  if (input.method === "upi") {
    if (!input.upiId || !UPI_REGEX.test(input.upiId.trim())) {
      return { ok: false, error: "Please enter a valid UPI ID (e.g., name@upi).", fraudFlags };
    }
  } else {
    if (!input.bankAccountHolder || input.bankAccountHolder.trim().length < 3) {
      return { ok: false, error: "Bank account holder name is required.", fraudFlags };
    }
    if (!input.bankAccountNumber || !/^\d{9,18}$/.test(input.bankAccountNumber.trim())) {
      return { ok: false, error: "Bank account number must be 9 to 18 digits.", fraudFlags };
    }
    if (!input.bankIfsc || !IFSC_REGEX.test(input.bankIfsc.trim().toUpperCase())) {
      return { ok: false, error: "Please enter a valid 11-character IFSC code (e.g., HDFC0001234).", fraudFlags };
    }
  }
  if (input.requestedPaise >= 5e5) {
    fraudFlags.push({
      alertType: "high_value_withdrawal",
      severity: "medium",
      description: `High-value withdrawal requested: \u20B9${(input.requestedPaise / 100).toFixed(2)}.`
    });
  }
  return { ok: true, fraudFlags };
}
function evaluateReferralFraud(params) {
  const refDomain = params.referrerEmail.toLowerCase();
  const newDomain = params.referredEmail.toLowerCase();
  if (refDomain === newDomain) {
    return { flagged: true, reason: "Self-referral attempt detected." };
  }
  if (params.referrerIp && params.referredIp && params.referrerIp === params.referredIp) {
    return { flagged: true, reason: "Referrer and referred account share identical signup IP address." };
  }
  if (params.sameIpSignupsLast24h >= 3) {
    return { flagged: true, reason: "High duplicate signup velocity from the same IP address within 24 hours." };
  }
  return { flagged: false, reason: "" };
}

// server/services/auditService.ts
async function logAudit(params, client = db) {
  await client.query(
    `INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, ip_address, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      params.actorUserId ?? null,
      params.action,
      params.entityType,
      params.entityId !== void 0 && params.entityId !== null ? String(params.entityId) : null,
      params.ipAddress ?? null,
      JSON.stringify(params.metadata ?? {})
    ]
  );
}
async function createFraudAlert(params, client = db) {
  await client.query(
    `INSERT INTO fraud_alerts (user_id, alert_type, severity, description, source_ip, status)
     VALUES ($1, $2, $3, $4, $5, 'open')`,
    [params.userId ?? null, params.alertType, params.severity, params.description, params.sourceIp ?? null]
  );
}
async function createNotification(params, client = db) {
  await client.query(
    `INSERT INTO notifications (user_id, title, body, category, is_read)
     VALUES ($1, $2, $3, $4, 0)`,
    [params.userId, params.title, params.body, params.category ?? "system"]
  );
}

// server/services/walletService.ts
import crypto4 from "node:crypto";

// server/domain/money.ts
function parseRupeesToPaise(input) {
  const raw = typeof input === "number" ? input.toFixed(2) : String(input).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) {
    throw new Error("Amount must be a valid positive number with at most 2 decimal places.");
  }
  const [rupeesPart, paisePart = ""] = raw.split(".");
  const rupees = Number.parseInt(rupeesPart, 10);
  const paise = Number.parseInt(paisePart.padEnd(2, "0"), 10);
  const total = rupees * 100 + paise;
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new Error("Amount exceeds safe integer bounds.");
  }
  return total;
}
function formatPaiseToInr(paise) {
  const safe = Math.trunc(paise);
  const isNegative = safe < 0;
  const abs = Math.abs(safe);
  const rupees = Math.floor(abs / 100);
  const rem = abs % 100;
  const formattedRupees = rupees.toLocaleString("en-IN");
  const formattedPaise = String(rem).padStart(2, "0");
  return `${isNegative ? "-" : ""}\u20B9${formattedRupees}.${formattedPaise}`;
}
function computeUserSharePaise(grossPaise, rewardPercentage) {
  if (!Number.isInteger(grossPaise) || grossPaise < 0) {
    throw new Error("grossPaise must be a non-negative integer.");
  }
  if (!Number.isInteger(rewardPercentage) || rewardPercentage < 0 || rewardPercentage > 100) {
    throw new Error("rewardPercentage must be an integer between 0 and 100.");
  }
  return Math.floor(grossPaise * rewardPercentage / 100);
}
function convertUsdStringToPaise(usdAmountStr, inrPaisePerUsd = 8400) {
  const clean = String(usdAmountStr).trim();
  if (!/^\d+(\.\d{1,4})?$/.test(clean)) {
    throw new Error("Invalid USD amount string.");
  }
  const [whole, frac = ""] = clean.split(".");
  const tenThousandths = Number.parseInt(whole, 10) * 1e4 + Number.parseInt(frac.padEnd(4, "0"), 10);
  return Math.floor(tenThousandths * inrPaisePerUsd / 1e4);
}

// server/services/walletService.ts
function generateUid(prefix) {
  return `${prefix}_${crypto4.randomBytes(6).toString("hex").toUpperCase()}`;
}
async function getSettingValue(key, fallback) {
  const res = await db.query(
    `SELECT setting_value FROM website_settings WHERE setting_key = $1`,
    [key]
  );
  return res.rows[0]?.setting_value ?? fallback;
}
async function processVerifiedConversion(params) {
  return db.transaction(async (tx) => {
    const existingRes = await tx.query(
      `SELECT id, status, user_reward_paise FROM offer_conversions
       WHERE provider_id = $1 AND provider_conversion_ref = $2`,
      [params.providerId, params.providerConversionRef]
    );
    const existing = existingRes.rows[0];
    await tx.query(
      `INSERT INTO wallet_accounts (user_id, available_paise, pending_paise, lifetime_earned_paise, total_withdrawn_paise)
       VALUES ($1, 0, 0, 0, 0)
       ON CONFLICT (user_id) DO NOTHING`,
      [params.userId]
    );
    if (existing) {
      if (existing.status === params.targetStatus) {
        return { outcome: "duplicate", conversionId: existing.id };
      }
      if (existing.status === "pending" && params.targetStatus === "approved") {
        const reward = Number(existing.user_reward_paise);
        await tx.query(
          `UPDATE offer_conversions SET status = 'approved', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [existing.id]
        );
        await tx.query(
          `UPDATE wallet_accounts
           SET pending_paise = CASE WHEN pending_paise > $1 THEN pending_paise - $1 ELSE 0 END,
               available_paise = available_paise + $1,
               lifetime_earned_paise = lifetime_earned_paise + $1,
               updated_at = CURRENT_TIMESTAMP
           WHERE user_id = $2`,
          [reward, params.userId]
        );
        await tx.query(
          `UPDATE wallet_transactions
           SET status = 'approved'
           WHERE provider_id = $1 AND provider_conversion_ref = $2 AND transaction_type = $3`,
          [params.providerId, params.providerConversionRef, params.transactionType]
        );
        await createNotification(
          {
            userId: params.userId,
            title: "Reward Approved",
            body: `${formatPaiseToInr(reward)} from ${params.providerName} (${params.offerName}) has moved to your available balance.`,
            category: "reward"
          },
          tx
        );
        return { outcome: "credited", conversionId: existing.id };
      }
      if (existing.status === "approved" && params.targetStatus === "reversed") {
        const reward = Number(existing.user_reward_paise);
        await tx.query(
          `UPDATE offer_conversions SET status = 'reversed', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [existing.id]
        );
        await tx.query(
          `UPDATE wallet_accounts
           SET available_paise = CASE WHEN available_paise > $1 THEN available_paise - $1 ELSE 0 END,
               lifetime_earned_paise = CASE WHEN lifetime_earned_paise > $1 THEN lifetime_earned_paise - $1 ELSE 0 END,
               updated_at = CURRENT_TIMESTAMP
           WHERE user_id = $2`,
          [reward, params.userId]
        );
        await tx.query(
          `INSERT INTO wallet_transactions
             (tx_uid, user_id, provider_id, campaign_id, amount_paise, transaction_type, status, provider_conversion_ref, description)
           VALUES ($1, $2, $3, $4, $5, 'reward_reversal', 'reversed', $6, $7)`,
          [
            generateUid("TXN"),
            params.userId,
            params.providerId,
            params.campaignId ?? null,
            -reward,
            params.providerConversionRef,
            `Provider reversal from ${params.providerName}: ${params.offerName}`
          ]
        );
        await createFraudAlert(
          {
            userId: params.userId,
            alertType: "provider_chargeback",
            severity: "medium",
            description: `${params.providerName} reversed conversion ${params.providerConversionRef} (${formatPaiseToInr(reward)}).`,
            sourceIp: params.sourceIp
          },
          tx
        );
        await createNotification(
          {
            userId: params.userId,
            title: "Reward Reversed by Provider",
            body: `${formatPaiseToInr(reward)} for ${params.offerName} was reversed by ${params.providerName}.`,
            category: "reward"
          },
          tx
        );
        return { outcome: "reversed", conversionId: existing.id };
      }
      if (existing.status === "pending" && params.targetStatus === "rejected") {
        const reward = Number(existing.user_reward_paise);
        await tx.query(
          `UPDATE offer_conversions SET status = 'rejected', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [existing.id]
        );
        await tx.query(
          `UPDATE wallet_accounts
           SET pending_paise = CASE WHEN pending_paise > $1 THEN pending_paise - $1 ELSE 0 END, updated_at = CURRENT_TIMESTAMP
           WHERE user_id = $2`,
          [reward, params.userId]
        );
        await tx.query(
          `UPDATE wallet_transactions
           SET status = 'rejected'
           WHERE provider_id = $1 AND provider_conversion_ref = $2 AND transaction_type = $3`,
          [params.providerId, params.providerConversionRef, params.transactionType]
        );
        return { outcome: "rejected", conversionId: existing.id };
      }
      return { outcome: "duplicate", conversionId: existing.id };
    }
    const ins = await tx.query(
      `INSERT INTO offer_conversions
         (user_id, provider_id, campaign_id, provider_conversion_ref, external_offer_id, offer_name, gross_payout_paise, user_reward_paise, status, signature_verified, source_ip, raw_payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, $10, $11)
       RETURNING id`,
      [
        params.userId,
        params.providerId,
        params.campaignId ?? null,
        params.providerConversionRef,
        params.externalOfferId ?? null,
        params.offerName,
        params.grossPayoutPaise,
        params.userRewardPaise,
        params.targetStatus,
        params.sourceIp,
        JSON.stringify(params.rawPayload)
      ]
    );
    const conversionId = ins.rows[0].id;
    if (params.targetStatus === "approved" && params.userRewardPaise > 0) {
      await tx.query(
        `UPDATE wallet_accounts
         SET available_paise = available_paise + $1,
             lifetime_earned_paise = lifetime_earned_paise + $1,
             updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $2`,
        [params.userRewardPaise, params.userId]
      );
      await tx.query(
        `INSERT INTO wallet_transactions
           (tx_uid, user_id, provider_id, campaign_id, amount_paise, transaction_type, status, provider_conversion_ref, description)
         VALUES ($1, $2, $3, $4, $5, $6, 'approved', $7, $8)`,
        [
          generateUid("TXN"),
          params.userId,
          params.providerId,
          params.campaignId ?? null,
          params.userRewardPaise,
          params.transactionType,
          params.providerConversionRef,
          `Verified reward from ${params.providerName}: ${params.offerName}`
        ]
      );
      await createNotification(
        {
          userId: params.userId,
          title: "Verified Reward Credited",
          body: `You earned ${formatPaiseToInr(params.userRewardPaise)} from ${params.providerName} (${params.offerName}).`,
          category: "reward"
        },
        tx
      );
      const refRes = await tx.query(
        `SELECT id, referrer_user_id, bonus_paise, status FROM referral_records
         WHERE referred_user_id = $1 AND status = 'pending'`,
        [params.userId]
      );
      const refRow = refRes.rows[0];
      if (refRow && Number(refRow.bonus_paise) > 0) {
        const bonus = Number(refRow.bonus_paise);
        await tx.query(
          `UPDATE referral_records SET status = 'credited', credited_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [refRow.id]
        );
        await tx.query(
          `UPDATE wallet_accounts
           SET available_paise = available_paise + $1,
               lifetime_earned_paise = lifetime_earned_paise + $1,
               updated_at = CURRENT_TIMESTAMP
           WHERE user_id = $2`,
          [bonus, refRow.referrer_user_id]
        );
        await tx.query(
          `INSERT INTO wallet_transactions
             (tx_uid, user_id, amount_paise, transaction_type, status, description)
           VALUES ($1, $2, $3, 'referral_bonus', 'approved', $4)`,
          [
            generateUid("TXN"),
            refRow.referrer_user_id,
            bonus,
            `Referral bonus qualified after referred member completed verified offer`
          ]
        );
        await createNotification(
          {
            userId: refRow.referrer_user_id,
            title: "Referral Bonus Credited",
            body: `Your referral qualified after completing a verified reward task. ${formatPaiseToInr(bonus)} has been added to your wallet.`,
            category: "referral"
          },
          tx
        );
      }
      await logAudit(
        {
          actorUserId: null,
          action: "postback.conversion_approved",
          entityType: "offer_conversion",
          entityId: conversionId,
          ipAddress: params.sourceIp,
          metadata: {
            provider: params.providerName,
            ref: params.providerConversionRef,
            userRewardPaise: params.userRewardPaise
          }
        },
        tx
      );
      return { outcome: "credited", conversionId };
    }
    if (params.targetStatus === "pending" && params.userRewardPaise > 0) {
      await tx.query(
        `UPDATE wallet_accounts
         SET pending_paise = pending_paise + $1, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $2`,
        [params.userRewardPaise, params.userId]
      );
      await tx.query(
        `INSERT INTO wallet_transactions
           (tx_uid, user_id, provider_id, campaign_id, amount_paise, transaction_type, status, provider_conversion_ref, description)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8)`,
        [
          generateUid("TXN"),
          params.userId,
          params.providerId,
          params.campaignId ?? null,
          params.userRewardPaise,
          params.transactionType,
          params.providerConversionRef,
          `Pending verification from ${params.providerName}: ${params.offerName}`
        ]
      );
      return { outcome: "pending", conversionId };
    }
    await tx.query(
      `INSERT INTO wallet_transactions
         (tx_uid, user_id, provider_id, campaign_id, amount_paise, transaction_type, status, provider_conversion_ref, description)
       VALUES ($1, $2, $3, $4, 0, $5, $6, $7, $8)`,
      [
        generateUid("TXN"),
        params.userId,
        params.providerId,
        params.campaignId ?? null,
        params.transactionType,
        params.targetStatus,
        params.providerConversionRef,
        `${params.targetStatus === "reversed" ? "Reversed" : "Rejected"} conversion from ${params.providerName}: ${params.offerName}`
      ]
    );
    return { outcome: params.targetStatus === "reversed" ? "reversed" : "rejected", conversionId };
  });
}

// server/routes/authRoutes.ts
var authRoutes = Router2();
var registerSchema = z2.object({
  fullName: z2.string().trim().min(2, "Full name must be at least 2 characters").max(160),
  email: z2.string().trim().email("Please provide a valid email address").max(255),
  password: z2.string().min(8, "Password must be at least 8 characters").max(128).regex(/[A-Z]/, "Password must include at least one uppercase letter").regex(/[a-z]/, "Password must include at least one lowercase letter").regex(/[0-9]/, "Password must include at least one number"),
  confirmPassword: z2.string(),
  referralCode: z2.string().trim().max(32).optional().or(z2.literal("")),
  acceptTerms: z2.literal(true, {
    message: "You must accept the Terms & Conditions and Responsible Rewards Policy."
  })
}).refine((data) => data.password === data.confirmPassword, {
  message: "Passwords do not match.",
  path: ["confirmPassword"]
});
var loginSchema = z2.object({
  email: z2.string().trim().email("Enter a valid email address"),
  password: z2.string().min(1, "Password is required")
});
var forgotPasswordSchema = z2.object({
  email: z2.string().trim().email("Enter a valid email address")
});
var resetPasswordSchema = z2.object({
  token: z2.string().trim().min(20, "Invalid reset token"),
  password: z2.string().min(8, "Password must be at least 8 characters").max(128).regex(/[A-Z]/, "Password must include at least one uppercase letter").regex(/[a-z]/, "Password must include at least one lowercase letter").regex(/[0-9]/, "Password must include at least one number"),
  confirmPassword: z2.string()
}).refine((data) => data.password === data.confirmPassword, {
  message: "Passwords do not match.",
  path: ["confirmPassword"]
});
authRoutes.get("/me", (req, res) => {
  if (!req.user) {
    res.json({ user: null, csrfToken: null });
    return;
  }
  res.json({
    user: req.user,
    csrfToken: req.csrfToken ?? null
  });
});
authRoutes.post("/register", authRateLimit, async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid registration data." });
    return;
  }
  const email = parsed.data.email.toLowerCase();
  const ip = getClientIp(req);
  try {
    const existing = await db.query(`SELECT id FROM users WHERE email = $1`, [email]);
    if (existing.rows.length > 0) {
      res.status(409).json({ error: "An account with this email address already exists." });
      return;
    }
    const recentSameIp = await db.query(
      `SELECT COUNT(*) AS count FROM users WHERE signup_ip = $1`,
      [ip]
    );
    const sameIpCount = Number(recentSameIp.rows[0]?.count ?? 0);
    let referrer = null;
    if (parsed.data.referralCode) {
      const refRes = await db.query(
        `SELECT id, email, signup_ip FROM users WHERE UPPER(referral_code) = UPPER($1) AND account_status = 'active'`,
        [parsed.data.referralCode]
      );
      if (refRes.rows.length === 0) {
        res.status(400).json({ error: "The referral code entered was not found." });
        return;
      }
      referrer = refRes.rows[0];
    }
    const passwordHash = await bcrypt2.hash(parsed.data.password, 12);
    const publicUid = "USR_" + crypto5.randomBytes(6).toString("hex").toUpperCase();
    const myReferralCode = "KRD" + crypto5.randomBytes(4).toString("hex").toUpperCase();
    const verificationToken = crypto5.randomBytes(32).toString("hex");
    const verificationHash = hashToken(verificationToken);
    const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1e3).toISOString();
    const referralBonusPaise = Number.parseInt(await getSettingValue("referral_bonus_paise", "2500"), 10);
    const referralEnabled = await getSettingValue("referral_program_enabled", "true") === "true";
    const createdUser = await db.transaction(async (tx) => {
      const userIns = await tx.query(
        `INSERT INTO users
           (public_uid, full_name, email, password_hash, role, account_status, email_verified, referral_code, referred_by_user_id, signup_ip, last_login_ip, terms_accepted_at, last_login_at)
         VALUES ($1, $2, $3, $4, 'user', 'active', 0, $5, $6, $7, $7, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         RETURNING id, public_uid, full_name, email, role, account_status, referral_code`,
        [
          publicUid,
          parsed.data.fullName,
          email,
          passwordHash,
          myReferralCode,
          referrer?.id ?? null,
          ip
        ]
      );
      const user = userIns.rows[0];
      await tx.query(
        `INSERT INTO wallet_accounts (user_id, available_paise, pending_paise, lifetime_earned_paise, total_withdrawn_paise)
         VALUES ($1, 0, 0, 0, 0)`,
        [user.id]
      );
      await tx.query(
        `INSERT INTO auth_tokens (user_id, token_type, token_hash, expires_at)
         VALUES ($1, 'email_verification', $2, $3)`,
        [user.id, verificationHash, verificationExpires]
      );
      if (sameIpCount >= 3) {
        await createFraudAlert(
          {
            userId: user.id,
            alertType: "duplicate_account_ip",
            severity: "medium",
            description: `Multiple accounts (${sameIpCount + 1}) registered from IP ${ip}.`,
            sourceIp: ip
          },
          tx
        );
      }
      if (referrer && referralEnabled) {
        const fraudCheck = evaluateReferralFraud({
          referrerEmail: referrer.email,
          referredEmail: email,
          referrerIp: referrer.signup_ip,
          referredIp: ip,
          sameIpSignupsLast24h: sameIpCount
        });
        await tx.query(
          `INSERT INTO referral_records (referrer_user_id, referred_user_id, bonus_paise, status, fraud_check_note)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            referrer.id,
            user.id,
            fraudCheck.flagged ? 0 : referralBonusPaise,
            fraudCheck.flagged ? "flagged_fraud" : "pending",
            fraudCheck.reason
          ]
        );
        if (fraudCheck.flagged) {
          await createFraudAlert(
            {
              userId: user.id,
              alertType: "suspicious_referral",
              severity: "medium",
              description: `Referral from user #${referrer.id} to #${user.id} flagged: ${fraudCheck.reason}`,
              sourceIp: ip
            },
            tx
          );
        }
      }
      await createNotification(
        {
          userId: user.id,
          title: "Welcome to Kredova",
          body: "Please verify your email address to enable withdrawal requests and secure your account.",
          category: "security"
        },
        tx
      );
      await logAudit(
        {
          actorUserId: user.id,
          action: "auth.register",
          entityType: "user",
          entityId: user.id,
          ipAddress: ip,
          metadata: { email, referredBy: referrer?.id ?? null }
        },
        tx
      );
      return user;
    });
    const session = await createSession(createdUser.id, ip, req.headers["user-agent"] || "");
    setSessionCookie(res, session.rawToken, session.expiresAt);
    const smtpConfigured = Boolean(process.env.SMTP_HOST);
    res.status(201).json({
      user: {
        id: createdUser.id,
        publicUid: createdUser.public_uid,
        fullName: createdUser.full_name,
        email: createdUser.email,
        role: createdUser.role,
        accountStatus: createdUser.account_status,
        emailVerified: false,
        referralCode: createdUser.referral_code,
        permissions: []
      },
      csrfToken: session.csrfToken,
      verificationNotice: smtpConfigured ? "A verification link has been emailed to your address." : "SMTP email delivery is not configured in this environment. Use the verification link below to verify your email address.",
      verificationLink: smtpConfigured ? void 0 : `/verify-email?token=${verificationToken}`
    });
  } catch (err) {
    console.error("Register error:", err);
    res.status(500).json({ error: "Registration failed. Please try again." });
  }
});
authRoutes.post("/login", authRateLimit, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid credentials." });
    return;
  }
  const email = parsed.data.email.toLowerCase();
  const ip = getClientIp(req);
  try {
    const userRes = await db.query(
      `SELECT u.id, u.public_uid, u.full_name, u.email, u.password_hash, u.role,
              u.account_status, u.email_verified, u.referral_code, ar.permissions AS role_permissions
       FROM users u
       LEFT JOIN admin_roles ar ON ar.id = u.admin_role_id
       WHERE u.email = $1`,
      [email]
    );
    const user = userRes.rows[0];
    if (!user) {
      res.status(401).json({ error: "Invalid email address or password." });
      return;
    }
    const passwordMatches = await bcrypt2.compare(parsed.data.password, user.password_hash);
    if (!passwordMatches) {
      await logAudit({
        actorUserId: user.id,
        action: "auth.login_failed",
        entityType: "user",
        entityId: user.id,
        ipAddress: ip
      });
      res.status(401).json({ error: "Invalid email address or password." });
      return;
    }
    if (user.account_status === "suspended" || user.account_status === "banned") {
      res.status(403).json({
        error: `This account is currently ${user.account_status}. Please contact support for review.`
      });
      return;
    }
    await db.query(
      `UPDATE users SET last_login_at = CURRENT_TIMESTAMP, last_login_ip = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [ip, user.id]
    );
    const session = await createSession(user.id, ip, req.headers["user-agent"] || "");
    setSessionCookie(res, session.rawToken, session.expiresAt);
    await logAudit({
      actorUserId: user.id,
      action: "auth.login_success",
      entityType: "user",
      entityId: user.id,
      ipAddress: ip
    });
    let permissions = [];
    if (Array.isArray(user.role_permissions)) {
      permissions = user.role_permissions;
    } else if (typeof user.role_permissions === "string") {
      try {
        permissions = JSON.parse(user.role_permissions);
      } catch {
        permissions = [];
      }
    }
    res.json({
      user: {
        id: user.id,
        publicUid: user.public_uid,
        fullName: user.full_name,
        email: user.email,
        role: user.role,
        accountStatus: user.account_status,
        emailVerified: Boolean(user.email_verified),
        referralCode: user.referral_code,
        permissions
      },
      csrfToken: session.csrfToken
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Unable to sign in right now." });
  }
});
authRoutes.post("/logout", async (req, res) => {
  try {
    if (req.sessionId) {
      await db.query(`UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP WHERE id = $1`, [req.sessionId]);
    }
    clearSessionCookie(res);
    res.json({ message: "Signed out successfully." });
  } catch (err) {
    console.error("Logout error:", err);
    res.status(500).json({ error: "Logout failed." });
  }
});
authRoutes.post("/resend-verification", requireAuth, authRateLimit, async (req, res) => {
  try {
    if (req.user.emailVerified) {
      res.json({ message: "Your email address is already verified." });
      return;
    }
    const token = crypto5.randomBytes(32).toString("hex");
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1e3).toISOString();
    await db.query(
      `INSERT INTO auth_tokens (user_id, token_type, token_hash, expires_at)
       VALUES ($1, 'email_verification', $2, $3)`,
      [req.user.id, tokenHash, expiresAt]
    );
    const smtpConfigured = Boolean(process.env.SMTP_HOST);
    res.json({
      message: smtpConfigured ? "A new verification email has been sent." : "Verification link generated (SMTP not configured in this environment).",
      verificationLink: smtpConfigured ? void 0 : `/verify-email?token=${token}`
    });
  } catch (err) {
    console.error("Resend verification error:", err);
    res.status(500).json({ error: "Could not issue verification link." });
  }
});
authRoutes.post("/verify-email", authRateLimit, async (req, res) => {
  const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
  if (!token) {
    res.status(400).json({ error: "Verification token is required." });
    return;
  }
  try {
    const tokenHash = hashToken(token);
    const tokenRes = await db.query(
      `SELECT id, user_id, expires_at, consumed_at FROM auth_tokens
       WHERE token_hash = $1 AND token_type = 'email_verification'`,
      [tokenHash]
    );
    const row = tokenRes.rows[0];
    if (!row || row.consumed_at || new Date(row.expires_at).getTime() < Date.now()) {
      res.status(400).json({ error: "Verification link is invalid or has expired." });
      return;
    }
    await db.transaction(async (tx) => {
      await tx.query(`UPDATE auth_tokens SET consumed_at = CURRENT_TIMESTAMP WHERE id = $1`, [row.id]);
      await tx.query(
        `UPDATE users SET email_verified = 1, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [row.user_id]
      );
      await logAudit(
        {
          actorUserId: row.user_id,
          action: "auth.email_verified",
          entityType: "user",
          entityId: row.user_id,
          ipAddress: getClientIp(req)
        },
        tx
      );
    });
    res.json({ message: "Email address verified successfully. Your account is now eligible for withdrawals." });
  } catch (err) {
    console.error("Verify email error:", err);
    res.status(500).json({ error: "Could not verify email address." });
  }
});
authRoutes.post("/forgot-password", authRateLimit, async (req, res) => {
  const parsed = forgotPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message || "Enter a valid email." });
    return;
  }
  const email = parsed.data.email.toLowerCase();
  try {
    const userRes = await db.query(`SELECT id FROM users WHERE email = $1`, [email]);
    const user = userRes.rows[0];
    let devResetLink;
    if (user) {
      const token = crypto5.randomBytes(32).toString("hex");
      const tokenHash = hashToken(token);
      const expiresAt = new Date(Date.now() + 60 * 60 * 1e3).toISOString();
      await db.query(
        `INSERT INTO auth_tokens (user_id, token_type, token_hash, expires_at)
         VALUES ($1, 'password_reset', $2, $3)`,
        [user.id, tokenHash, expiresAt]
      );
      await logAudit({
        actorUserId: user.id,
        action: "auth.password_reset_requested",
        entityType: "user",
        entityId: user.id,
        ipAddress: getClientIp(req)
      });
      if (!process.env.SMTP_HOST && !config.isProd) {
        devResetLink = `/reset-password?token=${token}`;
      }
    }
    res.json({
      message: "If an account matches that email, a password reset link has been issued.",
      resetLink: devResetLink
    });
  } catch (err) {
    console.error("Forgot password error:", err);
    res.status(500).json({ error: "Unable to process password reset request." });
  }
});
authRoutes.post("/reset-password", authRateLimit, async (req, res) => {
  const parsed = resetPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid password reset input." });
    return;
  }
  try {
    const tokenHash = hashToken(parsed.data.token);
    const tokenRes = await db.query(
      `SELECT id, user_id, expires_at, consumed_at FROM auth_tokens
       WHERE token_hash = $1 AND token_type = 'password_reset'`,
      [tokenHash]
    );
    const row = tokenRes.rows[0];
    if (!row || row.consumed_at || new Date(row.expires_at).getTime() < Date.now()) {
      res.status(400).json({ error: "Reset link is invalid or has expired." });
      return;
    }
    const newHash = await bcrypt2.hash(parsed.data.password, 12);
    await db.transaction(async (tx) => {
      await tx.query(`UPDATE auth_tokens SET consumed_at = CURRENT_TIMESTAMP WHERE id = $1`, [row.id]);
      await tx.query(
        `UPDATE users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [newHash, row.user_id]
      );
      await tx.query(
        `UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = $1 AND revoked_at IS NULL`,
        [row.user_id]
      );
      await logAudit(
        {
          actorUserId: row.user_id,
          action: "auth.password_reset_completed",
          entityType: "user",
          entityId: row.user_id,
          ipAddress: getClientIp(req)
        },
        tx
      );
    });
    clearSessionCookie(res);
    res.json({ message: "Your password has been reset. Please log in with your new password." });
  } catch (err) {
    console.error("Reset password error:", err);
    res.status(500).json({ error: "Unable to reset password." });
  }
});

// server/routes/userRoutes.ts
import bcrypt3 from "bcryptjs";
import { Router as Router3 } from "express";
import { z as z3 } from "zod";
var userRoutes = Router3();
userRoutes.use(requireAuth);
userRoutes.get("/dashboard", async (req, res) => {
  try {
    const userId = req.user.id;
    const [walletRes, completedRes, campaignsRes, txRes, notifRes, minWithdrawStr] = await Promise.all([
      db.query(
        `SELECT available_paise, pending_paise, lifetime_earned_paise, total_withdrawn_paise
         FROM wallet_accounts WHERE user_id = $1`,
        [userId]
      ),
      db.query(
        `SELECT COUNT(*) AS count FROM offer_conversions WHERE user_id = $1 AND status = 'approved'`,
        [userId]
      ),
      db.query(
        `SELECT c.id, c.title, c.description, c.category, c.reward_paise, c.estimated_minutes,
                c.instructions, c.eligibility_info, c.destination_url, c.image_url,
                p.name AS provider_name, a.company_name AS advertiser_name
         FROM campaigns c
         LEFT JOIN advertising_providers p ON p.id = c.provider_id
         LEFT JOIN advertisers a ON a.id = c.advertiser_id
         WHERE c.approval_status = 'approved' AND c.incentivized_permitted = 1
         ORDER BY c.created_at DESC
         LIMIT 20`
      ),
      db.query(
        `SELECT id, tx_uid, amount_paise, transaction_type, status, provider_conversion_ref, description, created_at
         FROM wallet_transactions
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT 10`,
        [userId]
      ),
      db.query(
        `SELECT id, title, body, category, is_read, created_at
         FROM notifications
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT 10`,
        [userId]
      ),
      getSettingValue("min_withdrawal_paise", "10000")
    ]);
    const wallet = walletRes.rows[0] || {
      available_paise: 0,
      pending_paise: 0,
      lifetime_earned_paise: 0,
      total_withdrawn_paise: 0
    };
    const convRes = await db.query(
      `SELECT campaign_id, status FROM offer_conversions WHERE user_id = $1 AND campaign_id IS NOT NULL`,
      [userId]
    );
    const statusByCampaign = /* @__PURE__ */ new Map();
    for (const row of convRes.rows) {
      if (row.campaign_id) statusByCampaign.set(row.campaign_id, row.status);
    }
    res.json({
      wallet: {
        availablePaise: Number(wallet.available_paise),
        pendingPaise: Number(wallet.pending_paise),
        lifetimeEarnedPaise: Number(wallet.lifetime_earned_paise),
        totalWithdrawnPaise: Number(wallet.total_withdrawn_paise)
      },
      completedTasks: Number(completedRes.rows[0]?.count ?? 0),
      minWithdrawalPaise: Number.parseInt(minWithdrawStr, 10),
      campaigns: campaignsRes.rows.map((c) => ({
        id: c.id,
        title: c.title,
        description: c.description,
        category: c.category,
        rewardPaise: Number(c.reward_paise),
        estimatedMinutes: c.estimated_minutes,
        instructions: c.instructions,
        eligibilityInfo: c.eligibility_info,
        destinationUrl: c.destination_url,
        imageUrl: c.image_url,
        sourceName: c.provider_name || c.advertiser_name || "Direct Campaign",
        completionStatus: statusByCampaign.get(c.id) || "not_started"
      })),
      recentTransactions: txRes.rows.map((t) => ({
        id: t.id,
        txUid: t.tx_uid,
        amountPaise: Number(t.amount_paise),
        transactionType: t.transaction_type,
        status: t.status,
        providerConversionRef: t.provider_conversion_ref,
        description: t.description,
        createdAt: t.created_at
      })),
      notifications: notifRes.rows.map((n) => ({
        id: n.id,
        title: n.title,
        body: n.body,
        category: n.category,
        isRead: Boolean(n.is_read),
        createdAt: n.created_at
      }))
    });
  } catch (err) {
    console.error("User dashboard error:", err);
    res.status(500).json({ error: "Unable to load dashboard." });
  }
});
userRoutes.get("/campaigns", async (req, res) => {
  try {
    const category = typeof req.query.category === "string" ? req.query.category : "";
    const validCategories = /* @__PURE__ */ new Set(["watch", "download", "surveys", "offers"]);
    const params = [];
    let where = `WHERE c.approval_status = 'approved' AND c.incentivized_permitted = 1`;
    if (validCategories.has(category)) {
      params.push(category);
      where += ` AND c.category = $1`;
    }
    const campaignsRes = await db.query(
      `SELECT c.id, c.title, c.description, c.category, c.reward_paise, c.estimated_minutes,
              c.instructions, c.eligibility_info, c.destination_url, c.image_url,
              p.name AS provider_name, a.company_name AS advertiser_name
       FROM campaigns c
       LEFT JOIN advertising_providers p ON p.id = c.provider_id
       LEFT JOIN advertisers a ON a.id = c.advertiser_id
       ${where}
       ORDER BY c.created_at DESC`,
      params
    );
    const convRes = await db.query(
      `SELECT campaign_id, status FROM offer_conversions WHERE user_id = $1 AND campaign_id IS NOT NULL`,
      [req.user.id]
    );
    const statusByCampaign = /* @__PURE__ */ new Map();
    for (const row of convRes.rows) {
      if (row.campaign_id) statusByCampaign.set(row.campaign_id, row.status);
    }
    res.json({
      campaigns: campaignsRes.rows.map((c) => ({
        id: c.id,
        title: c.title,
        description: c.description,
        category: c.category,
        rewardPaise: Number(c.reward_paise),
        estimatedMinutes: c.estimated_minutes,
        instructions: c.instructions,
        eligibilityInfo: c.eligibility_info,
        destinationUrl: c.destination_url,
        imageUrl: c.image_url,
        sourceName: c.provider_name || c.advertiser_name || "Direct Campaign",
        completionStatus: statusByCampaign.get(c.id) || "not_started"
      }))
    });
  } catch (err) {
    console.error("Campaigns list error:", err);
    res.status(500).json({ error: "Unable to load campaigns." });
  }
});
userRoutes.get("/transactions", async (req, res) => {
  try {
    const statusFilter = typeof req.query.status === "string" ? req.query.status : "";
    const params = [req.user.id];
    let where = `WHERE wt.user_id = $1`;
    if (["pending", "approved", "rejected", "reversed"].includes(statusFilter)) {
      params.push(statusFilter);
      where += ` AND wt.status = $2`;
    }
    const rows = await db.query(
      `SELECT wt.id, wt.tx_uid, wt.amount_paise, wt.transaction_type, wt.status,
              wt.provider_conversion_ref, p.name AS provider_name, wt.description, wt.created_at
       FROM wallet_transactions wt
       LEFT JOIN advertising_providers p ON p.id = wt.provider_id
       ${where}
       ORDER BY wt.created_at DESC
       LIMIT 100`,
      params
    );
    res.json({
      transactions: rows.rows.map((r) => ({
        id: r.id,
        txUid: r.tx_uid,
        amountPaise: Number(r.amount_paise),
        transactionType: r.transaction_type,
        status: r.status,
        providerConversionRef: r.provider_conversion_ref,
        providerName: r.provider_name || "Platform Ledger",
        description: r.description,
        createdAt: r.created_at
      }))
    });
  } catch (err) {
    console.error("Transactions error:", err);
    res.status(500).json({ error: "Unable to load transaction ledger." });
  }
});
userRoutes.get("/referrals", async (req, res) => {
  try {
    const userId = req.user.id;
    const [recordsRes, bonusStr, enabledStr] = await Promise.all([
      db.query(
        `SELECT r.id, u.full_name AS referred_name, u.email AS referred_email,
                r.bonus_paise, r.status, r.fraud_check_note, r.credited_at, r.created_at
         FROM referral_records r
         INNER JOIN users u ON u.id = r.referred_user_id
         WHERE r.referrer_user_id = $1
         ORDER BY r.created_at DESC`,
        [userId]
      ),
      getSettingValue("referral_bonus_paise", "2500"),
      getSettingValue("referral_program_enabled", "true")
    ]);
    const records = recordsRes.rows;
    const totalCreditedPaise = records.filter((r) => r.status === "credited").reduce((sum, r) => sum + Number(r.bonus_paise), 0);
    res.json({
      referralCode: req.user.referralCode,
      referralLink: `${config.appUrl}/signup?ref=${encodeURIComponent(req.user.referralCode)}`,
      programEnabled: enabledStr === "true",
      bonusPerQualifiedReferralPaise: Number.parseInt(bonusStr, 10),
      totalReferred: records.length,
      qualifiedCount: records.filter((r) => r.status === "credited" || r.status === "qualified").length,
      totalCreditedPaise,
      referrals: records.map((r) => ({
        id: r.id,
        referredName: r.referred_name,
        referredEmailMasked: r.referred_email.replace(/(^.).*(@.*$)/, "$1***$2"),
        bonusPaise: Number(r.bonus_paise),
        status: r.status,
        note: r.fraud_check_note,
        creditedAt: r.credited_at,
        createdAt: r.created_at
      }))
    });
  } catch (err) {
    console.error("Referrals error:", err);
    res.status(500).json({ error: "Unable to load referral statistics." });
  }
});
userRoutes.get("/profile", async (req, res) => {
  try {
    const profileRes = await db.query(
      `SELECT public_uid, full_name, email, phone, upi_id, bank_account_holder,
              bank_account_number, bank_ifsc, bank_name, email_verified,
              account_status, referral_code, created_at
       FROM users WHERE id = $1`,
      [req.user.id]
    );
    const p = profileRes.rows[0];
    if (!p) {
      res.status(404).json({ error: "Profile not found." });
      return;
    }
    res.json({
      profile: {
        publicUid: p.public_uid,
        fullName: p.full_name,
        email: p.email,
        phone: p.phone || "",
        upiId: p.upi_id || "",
        bankAccountHolder: p.bank_account_holder || "",
        bankAccountNumber: p.bank_account_number || "",
        bankIfsc: p.bank_ifsc || "",
        bankName: p.bank_name || "",
        emailVerified: Boolean(p.email_verified),
        accountStatus: p.account_status,
        referralCode: p.referral_code,
        createdAt: p.created_at
      }
    });
  } catch (err) {
    console.error("Profile fetch error:", err);
    res.status(500).json({ error: "Unable to load profile." });
  }
});
var updateProfileSchema = z3.object({
  fullName: z3.string().trim().min(2).max(160),
  phone: z3.string().trim().max(32).optional().default(""),
  upiId: z3.string().trim().max(128).optional().default(""),
  bankAccountHolder: z3.string().trim().max(160).optional().default(""),
  bankAccountNumber: z3.string().trim().max(64).optional().default(""),
  bankIfsc: z3.string().trim().max(32).optional().default(""),
  bankName: z3.string().trim().max(120).optional().default("")
});
userRoutes.put("/profile", async (req, res) => {
  const parsed = updateProfileSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid profile fields." });
    return;
  }
  try {
    await db.query(
      `UPDATE users
       SET full_name = $1, phone = $2, upi_id = $3, bank_account_holder = $4,
           bank_account_number = $5, bank_ifsc = $6, bank_name = $7, updated_at = CURRENT_TIMESTAMP
       WHERE id = $8`,
      [
        parsed.data.fullName,
        parsed.data.phone,
        parsed.data.upiId,
        parsed.data.bankAccountHolder,
        parsed.data.bankAccountNumber,
        parsed.data.bankIfsc.toUpperCase(),
        parsed.data.bankName,
        req.user.id
      ]
    );
    await logAudit({
      actorUserId: req.user.id,
      action: "user.profile_updated",
      entityType: "user",
      entityId: req.user.id,
      ipAddress: getClientIp(req)
    });
    res.json({ message: "Profile and payout details updated." });
  } catch (err) {
    console.error("Profile update error:", err);
    res.status(500).json({ error: "Failed to update profile." });
  }
});
var changePasswordSchema = z3.object({
  currentPassword: z3.string().min(1),
  newPassword: z3.string().min(8, "New password must be at least 8 characters").regex(/[A-Z]/, "Include an uppercase letter").regex(/[a-z]/, "Include a lowercase letter").regex(/[0-9]/, "Include a number"),
  confirmPassword: z3.string()
}).refine((d) => d.newPassword === d.confirmPassword, {
  message: "New passwords do not match.",
  path: ["confirmPassword"]
});
userRoutes.post("/change-password", async (req, res) => {
  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid password input." });
    return;
  }
  try {
    const userRes = await db.query(
      `SELECT password_hash FROM users WHERE id = $1`,
      [req.user.id]
    );
    const currentHash = userRes.rows[0]?.password_hash;
    if (!currentHash || !await bcrypt3.compare(parsed.data.currentPassword, currentHash)) {
      res.status(400).json({ error: "Current password is incorrect." });
      return;
    }
    const newHash = await bcrypt3.hash(parsed.data.newPassword, 12);
    await db.query(
      `UPDATE users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [newHash, req.user.id]
    );
    await logAudit({
      actorUserId: req.user.id,
      action: "user.password_changed",
      entityType: "user",
      entityId: req.user.id,
      ipAddress: getClientIp(req)
    });
    res.json({ message: "Password updated successfully." });
  } catch (err) {
    console.error("Password change error:", err);
    res.status(500).json({ error: "Failed to change password." });
  }
});
userRoutes.get("/tickets", async (req, res) => {
  try {
    const rows = await db.query(
      `SELECT id, ticket_uid, category, subject, message, status, admin_reply, created_at, updated_at
       FROM support_tickets
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json({
      tickets: rows.rows.map((t) => ({
        id: t.id,
        ticketUid: t.ticket_uid,
        category: t.category,
        subject: t.subject,
        message: t.message,
        status: t.status,
        adminReply: t.admin_reply,
        createdAt: t.created_at,
        updatedAt: t.updated_at
      }))
    });
  } catch (err) {
    console.error("Tickets fetch error:", err);
    res.status(500).json({ error: "Unable to load support tickets." });
  }
});
var createTicketSchema = z3.object({
  category: z3.enum(["general", "missing_reward", "withdrawal", "account", "advertiser"]),
  subject: z3.string().trim().min(4, "Subject must be at least 4 characters").max(200),
  message: z3.string().trim().min(10, "Please describe your issue in at least 10 characters").max(3e3)
});
userRoutes.post("/tickets", async (req, res) => {
  const parsed = createTicketSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid ticket details." });
    return;
  }
  try {
    const ticketUid = generateUid("TKT");
    const ins = await db.query(
      `INSERT INTO support_tickets (ticket_uid, user_id, category, subject, message, status)
       VALUES ($1, $2, $3, $4, $5, 'open')
       RETURNING id`,
      [ticketUid, req.user.id, parsed.data.category, parsed.data.subject, parsed.data.message]
    );
    await logAudit({
      actorUserId: req.user.id,
      action: "support.ticket_created",
      entityType: "support_ticket",
      entityId: ins.rows[0]?.id,
      ipAddress: getClientIp(req)
    });
    res.status(201).json({
      message: "Support ticket created. Our team will review and reply here.",
      ticketUid
    });
  } catch (err) {
    console.error("Create ticket error:", err);
    res.status(500).json({ error: "Unable to submit support ticket." });
  }
});
userRoutes.post("/notifications/mark-read", async (req, res) => {
  try {
    await db.query(`UPDATE notifications SET is_read = 1 WHERE user_id = $1`, [req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error("Mark read error:", err);
    res.status(500).json({ error: "Failed to update notifications." });
  }
});

// server/routes/withdrawalRoutes.ts
import { Router as Router4 } from "express";
import { z as z4 } from "zod";
var withdrawalRoutes = Router4();
withdrawalRoutes.use(requireAuth);
withdrawalRoutes.get("/", async (req, res) => {
  try {
    const userId = req.user.id;
    const [walletRes, listRes, minWithdrawStr, notice, requireVerifyStr] = await Promise.all([
      db.query(
        `SELECT available_paise, pending_paise, total_withdrawn_paise FROM wallet_accounts WHERE user_id = $1`,
        [userId]
      ),
      db.query(
        `SELECT id, request_uid, method, amount_paise, upi_id, bank_account_holder,
                bank_account_number, bank_ifsc, bank_name, status, admin_note,
                payment_reference, created_at, paid_at
         FROM withdrawal_requests
         WHERE user_id = $1
         ORDER BY created_at DESC`,
        [userId]
      ),
      getSettingValue("min_withdrawal_paise", "10000"),
      getSettingValue(
        "withdrawal_review_notice",
        "All UPI and bank transfer requests are manually verified by our finance team before payout."
      ),
      getSettingValue("require_email_verification_for_withdrawal", "true")
    ]);
    const wallet = walletRes.rows[0] || {
      available_paise: 0,
      pending_paise: 0,
      total_withdrawn_paise: 0
    };
    res.json({
      availablePaise: Number(wallet.available_paise),
      pendingPaise: Number(wallet.pending_paise),
      totalWithdrawnPaise: Number(wallet.total_withdrawn_paise),
      minWithdrawalPaise: Number.parseInt(minWithdrawStr, 10),
      requireEmailVerification: requireVerifyStr === "true",
      reviewNotice: notice,
      withdrawals: listRes.rows.map((w) => ({
        id: w.id,
        requestUid: w.request_uid,
        method: w.method,
        amountPaise: Number(w.amount_paise),
        upiId: w.upi_id,
        bankAccountHolder: w.bank_account_holder,
        bankAccountNumberMasked: w.bank_account_number ? `\u2022\u2022\u2022\u2022${w.bank_account_number.slice(-4)}` : "",
        bankIfsc: w.bank_ifsc,
        bankName: w.bank_name,
        status: w.status,
        adminNote: w.admin_note,
        paymentReference: w.payment_reference,
        createdAt: w.created_at,
        paidAt: w.paid_at
      }))
    });
  } catch (err) {
    console.error("Get withdrawals error:", err);
    res.status(500).json({ error: "Unable to load withdrawal history." });
  }
});
var requestWithdrawalSchema = z4.object({
  method: z4.enum(["upi", "bank"]),
  amountRupees: z4.union([z4.string(), z4.number()]),
  upiId: z4.string().trim().max(128).optional(),
  bankAccountHolder: z4.string().trim().max(160).optional(),
  bankAccountNumber: z4.string().trim().max(64).optional(),
  bankIfsc: z4.string().trim().max(32).optional(),
  bankName: z4.string().trim().max(120).optional()
});
withdrawalRoutes.post("/", withdrawalRateLimit, async (req, res) => {
  const parsed = requestWithdrawalSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid withdrawal request." });
    return;
  }
  let requestedPaise;
  try {
    requestedPaise = parseRupeesToPaise(parsed.data.amountRupees);
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "Invalid amount." });
    return;
  }
  const userId = req.user.id;
  const ip = getClientIp(req);
  try {
    const [minWithdrawStr, requireVerifyStr] = await Promise.all([
      getSettingValue("min_withdrawal_paise", "10000"),
      getSettingValue("require_email_verification_for_withdrawal", "true")
    ]);
    const minWithdrawalPaise = Number.parseInt(minWithdrawStr, 10);
    const requireEmailVerification = requireVerifyStr === "true";
    const result = await db.transaction(async (tx) => {
      const walletRes = await tx.query(
        `SELECT available_paise FROM wallet_accounts WHERE user_id = $1`,
        [userId]
      );
      const pendingRes = await tx.query(
        `SELECT COUNT(*) AS count FROM withdrawal_requests WHERE user_id = $1 AND status IN ('pending', 'approved', 'processing')`,
        [userId]
      );
      const availablePaise = Number(walletRes.rows[0]?.available_paise ?? 0);
      const pendingCount = Number(pendingRes.rows[0]?.count ?? 0);
      const evaluation = evaluateWithdrawalEligibility({
        accountStatus: req.user.accountStatus,
        emailVerified: req.user.emailVerified,
        requireEmailVerification,
        availablePaise,
        requestedPaise,
        minWithdrawalPaise,
        pendingWithdrawalsCount: pendingCount,
        method: parsed.data.method,
        upiId: parsed.data.upiId,
        bankAccountHolder: parsed.data.bankAccountHolder,
        bankAccountNumber: parsed.data.bankAccountNumber,
        bankIfsc: parsed.data.bankIfsc
      });
      for (const flag of evaluation.fraudFlags) {
        await createFraudAlert(
          {
            userId,
            alertType: flag.alertType,
            severity: flag.severity,
            description: flag.description,
            sourceIp: ip
          },
          tx
        );
      }
      if (!evaluation.ok) {
        return { error: evaluation.error || "Withdrawal request rejected." };
      }
      await tx.query(
        `UPDATE wallet_accounts
         SET available_paise = available_paise - $1, updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $2`,
        [requestedPaise, userId]
      );
      const requestUid = generateUid("WDR");
      const ins = await tx.query(
        `INSERT INTO withdrawal_requests
           (request_uid, user_id, method, amount_paise, upi_id, bank_account_holder, bank_account_number, bank_ifsc, bank_name, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
         RETURNING id`,
        [
          requestUid,
          userId,
          parsed.data.method,
          requestedPaise,
          parsed.data.method === "upi" ? parsed.data.upiId?.trim() || "" : "",
          parsed.data.method === "bank" ? parsed.data.bankAccountHolder?.trim() || "" : "",
          parsed.data.method === "bank" ? parsed.data.bankAccountNumber?.trim() || "" : "",
          parsed.data.method === "bank" ? parsed.data.bankIfsc?.trim().toUpperCase() || "" : "",
          parsed.data.method === "bank" ? parsed.data.bankName?.trim() || "" : ""
        ]
      );
      await tx.query(
        `INSERT INTO wallet_transactions
           (tx_uid, user_id, amount_paise, transaction_type, status, description)
         VALUES ($1, $2, $3, 'withdrawal_debit', 'pending', $4)`,
        [
          generateUid("TXN"),
          userId,
          -requestedPaise,
          `Withdrawal request ${requestUid} via ${parsed.data.method.toUpperCase()} (pending admin review)`
        ]
      );
      await createNotification(
        {
          userId,
          title: "Withdrawal Request Submitted",
          body: `Your request ${requestUid} for ${formatPaiseToInr(requestedPaise)} via ${parsed.data.method.toUpperCase()} is pending manual admin review.`,
          category: "withdrawal"
        },
        tx
      );
      await logAudit(
        {
          actorUserId: userId,
          action: "withdrawal.requested",
          entityType: "withdrawal_request",
          entityId: ins.rows[0]?.id,
          ipAddress: ip,
          metadata: { requestUid, method: parsed.data.method, requestedPaise }
        },
        tx
      );
      return { requestUid };
    });
    if ("error" in result) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.status(201).json({
      message: `Withdrawal request ${result.requestUid} submitted for admin review. Funds will be disbursed only after manual finance approval.`,
      requestUid: result.requestUid
    });
  } catch (err) {
    console.error("Create withdrawal error:", err);
    res.status(500).json({ error: "Unable to submit withdrawal request." });
  }
});

// server/routes/providerRoutes.ts
import { Router as Router5 } from "express";
var providerRoutes = Router5();
var postbackRoutes = Router5();
providerRoutes.get("/offerwalls", requireAuth, async (req, res) => {
  try {
    const provRes = await db.query(
      `SELECT p.id, p.slug, p.name, p.provider_type, p.is_enabled, p.user_reward_percentage,
              p.docs_url, p.postback_path, p.supported_categories, p.notes,
              pc.env_app_id_key, pc.env_secret_key, pc.configuration_status
       FROM advertising_providers p
       LEFT JOIN provider_credentials pc ON pc.provider_id = p.id
       ORDER BY p.id ASC`
    );
    const user = req.user;
    const providers = provRes.rows.map((p) => {
      let categories = [];
      try {
        categories = typeof p.supported_categories === "string" ? JSON.parse(p.supported_categories) : p.supported_categories;
      } catch {
        categories = [];
      }
      let isConfigured = false;
      let embedUrl = null;
      let requiredEnvVars = [p.env_app_id_key, p.env_secret_key];
      if (p.slug === "ayet_studios") {
        isConfigured = Boolean(config.providers.ayet.adslotId && config.providers.ayet.publisherApiKey);
        if (isConfigured && Boolean(p.is_enabled)) {
          embedUrl = buildAyetOfferwallUrl(config.providers.ayet.adslotId, user.publicUid);
        }
      } else if (p.slug === "cpx_research") {
        isConfigured = Boolean(config.providers.cpx.appId && config.providers.cpx.secureHashSecret);
        if (isConfigured && Boolean(p.is_enabled)) {
          embedUrl = buildCpxSurveyUrl({
            appId: config.providers.cpx.appId,
            extUserId: user.publicUid,
            secureHashSecret: config.providers.cpx.secureHashSecret,
            username: user.fullName,
            email: user.email
          });
        }
      } else if (p.slug === "adgem") {
        isConfigured = Boolean(config.providers.adgem.appId && config.providers.adgem.postbackKey);
        if (isConfigured && Boolean(p.is_enabled)) {
          embedUrl = buildAdGemOfferwallUrl(config.providers.adgem.appId, user.publicUid);
        }
      }
      return {
        id: p.id,
        slug: p.slug,
        name: p.name,
        providerType: p.provider_type,
        isEnabled: Boolean(p.is_enabled),
        isConfigured,
        userRewardPercentage: Number(p.user_reward_percentage),
        supportedCategories: categories,
        docsUrl: p.docs_url,
        postbackEndpoint: `${config.appUrl}${p.postback_path}`,
        userExternalIdentifier: user.publicUid,
        embedUrl,
        requiredEnvVars,
        notes: p.notes
      };
    });
    res.json({ providers });
  } catch (err) {
    console.error("Offerwall config error:", err);
    res.status(500).json({ error: "Unable to load advertising provider configurations." });
  }
});
postbackRoutes.use(postbackRateLimit);
postbackRoutes.get("/ayet-studios", async (req, res) => {
  const sourceIp = getClientIp(req);
  const apiKey = config.providers.ayet.publisherApiKey;
  if (!apiKey) {
    res.status(503).send("ayeT-Studios publisher API key is not configured.");
    return;
  }
  const incomingHash = req.headers["x-ayetstudios-security-hash"];
  const queryObj = req.query;
  if (!verifyAyetPostbackSignature(queryObj, incomingHash, apiKey)) {
    await createFraudAlert({
      alertType: "invalid_postback_signature",
      severity: "high",
      description: `Rejected ayeT-Studios postback with invalid X-Ayetstudios-Security-Hash from ${sourceIp}.`,
      sourceIp
    });
    res.status(403).send("Invalid security hash");
    return;
  }
  const externalIdentifier = String(req.query.external_identifier || "").trim();
  const transactionId = String(req.query.transaction_id || req.query.conversion_id || "").trim();
  const payoutUsd = String(req.query.payout_usd || "0").trim();
  const offerName = String(req.query.offer_name || "ayeT-Studios Offer").trim();
  const offerId = String(req.query.offer_id || "").trim();
  const isChargeback = String(req.query.is_chargeback || "0") === "1";
  if (!externalIdentifier || !transactionId) {
    res.status(400).send("Missing external_identifier or transaction_id");
    return;
  }
  try {
    const [userRes, provRes] = await Promise.all([
      db.query(`SELECT id FROM users WHERE public_uid = $1`, [externalIdentifier]),
      db.query(
        `SELECT id, name, user_reward_percentage, is_enabled FROM advertising_providers WHERE slug = 'ayet_studios'`
      )
    ]);
    const user = userRes.rows[0];
    const provider = provRes.rows[0];
    if (!user || !provider || !provider.is_enabled) {
      res.status(404).send("Unknown user or disabled provider");
      return;
    }
    const grossPaise = convertUsdStringToPaise(payoutUsd);
    const userRewardPaise = computeUserSharePaise(grossPaise, Number(provider.user_reward_percentage));
    const outcome = await processVerifiedConversion({
      userId: user.id,
      providerId: provider.id,
      providerName: provider.name,
      providerConversionRef: transactionId,
      externalOfferId: offerId || null,
      offerName,
      grossPayoutPaise: grossPaise,
      userRewardPaise,
      targetStatus: isChargeback ? "reversed" : "approved",
      transactionType: "offer_reward",
      sourceIp,
      rawPayload: queryObj
    });
    await db.query(
      `UPDATE provider_credentials SET configuration_status = 'verified', last_verified_at = CURRENT_TIMESTAMP WHERE provider_id = $1`,
      [provider.id]
    );
    res.status(200).send(`OK:${outcome.outcome}`);
  } catch (err) {
    console.error("ayeT-Studios postback error:", err);
    res.status(500).send("Internal error");
  }
});
postbackRoutes.get("/cpx-research", async (req, res) => {
  const sourceIp = getClientIp(req);
  const secret = config.providers.cpx.secureHashSecret;
  if (!secret) {
    res.status(503).send("CPX Research secure_hash secret is not configured.");
    return;
  }
  const transId = String(req.query.trans_id || "").trim();
  const extUserId = String(req.query.user_id || req.query.ext_user_id || "").trim();
  const incomingHash = String(req.query.secure_hash || "").trim();
  const statusParam = String(req.query.status || "").trim();
  const amountUsd = String(req.query.amount_usd || "0").trim();
  if (!verifyCpxPostbackHash(transId, incomingHash, secret)) {
    await createFraudAlert({
      alertType: "invalid_postback_signature",
      severity: "high",
      description: `Rejected CPX Research postback with invalid secure_hash for trans_id=${transId} from ${sourceIp}.`,
      sourceIp
    });
    res.status(403).send("Invalid secure_hash");
    return;
  }
  if (!extUserId || !transId || !["1", "2"].includes(statusParam)) {
    res.status(400).send("Invalid CPX postback parameters");
    return;
  }
  try {
    const [userRes, provRes] = await Promise.all([
      db.query(`SELECT id FROM users WHERE public_uid = $1`, [extUserId]),
      db.query(
        `SELECT id, name, user_reward_percentage, is_enabled FROM advertising_providers WHERE slug = 'cpx_research'`
      )
    ]);
    const user = userRes.rows[0];
    const provider = provRes.rows[0];
    if (!user || !provider || !provider.is_enabled) {
      res.status(404).send("Unknown user or disabled provider");
      return;
    }
    const grossPaise = convertUsdStringToPaise(amountUsd);
    const userRewardPaise = computeUserSharePaise(grossPaise, Number(provider.user_reward_percentage));
    const outcome = await processVerifiedConversion({
      userId: user.id,
      providerId: provider.id,
      providerName: provider.name,
      providerConversionRef: transId,
      externalOfferId: String(req.query.subid || ""),
      offerName: "CPX Research Survey",
      grossPayoutPaise: grossPaise,
      userRewardPaise,
      targetStatus: statusParam === "2" ? "reversed" : "approved",
      transactionType: "survey_reward",
      sourceIp,
      rawPayload: req.query
    });
    await db.query(
      `UPDATE provider_credentials SET configuration_status = 'verified', last_verified_at = CURRENT_TIMESTAMP WHERE provider_id = $1`,
      [provider.id]
    );
    res.status(200).send(`OK:${outcome.outcome}`);
  } catch (err) {
    console.error("CPX postback error:", err);
    res.status(500).send("Internal error");
  }
});
postbackRoutes.post("/adgem", async (req, res) => {
  const sourceIp = getClientIp(req);
  const postbackKey = config.providers.adgem.postbackKey;
  if (!postbackKey) {
    res.status(503).json({ error: "AdGem postback key is not configured." });
    return;
  }
  if (!isIpAllowed(sourceIp, config.providers.adgem.allowedIps)) {
    await createFraudAlert({
      alertType: "disallowed_postback_ip",
      severity: "high",
      description: `Rejected AdGem postback from non-allowlisted IP ${sourceIp}.`,
      sourceIp
    });
    res.status(403).json({ error: "Forbidden IP" });
    return;
  }
  const rawBody = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
  const incomingSig = req.headers["signature"];
  if (!verifyAdGemPostbackSignature(rawBody, incomingSig, postbackKey)) {
    await createFraudAlert({
      alertType: "invalid_postback_signature",
      severity: "high",
      description: `Rejected AdGem v3 postback with invalid Signature header from ${sourceIp}.`,
      sourceIp
    });
    res.status(403).json({ error: "Invalid Signature" });
    return;
  }
  const payload = req.body || {};
  const playerId = String(payload.player_id || payload.playerid || "").trim();
  const transactionId = String(payload.transaction_id || "").trim();
  const payoutUsd = String(payload.payout || payload.payout_usd || "0").trim();
  const offerName = String(payload.campaign_name || payload.offer_name || "AdGem Offer").trim();
  const offerId = String(payload.campaign_id || payload.offer_id || "").trim();
  const isReversal = Boolean(payload.is_chargeback || payload.status === "reversed" || Number(payload.amount) < 0);
  if (!playerId || !transactionId) {
    res.status(400).json({ error: "Missing player_id or transaction_id" });
    return;
  }
  try {
    const [userRes, provRes] = await Promise.all([
      db.query(`SELECT id FROM users WHERE public_uid = $1`, [playerId]),
      db.query(
        `SELECT id, name, user_reward_percentage, is_enabled FROM advertising_providers WHERE slug = 'adgem'`
      )
    ]);
    const user = userRes.rows[0];
    const provider = provRes.rows[0];
    if (!user || !provider || !provider.is_enabled) {
      res.status(404).json({ error: "Unknown player_id or disabled provider" });
      return;
    }
    const grossPaise = convertUsdStringToPaise(payoutUsd);
    const userRewardPaise = computeUserSharePaise(grossPaise, Number(provider.user_reward_percentage));
    const outcome = await processVerifiedConversion({
      userId: user.id,
      providerId: provider.id,
      providerName: provider.name,
      providerConversionRef: transactionId,
      externalOfferId: offerId || null,
      offerName,
      grossPayoutPaise: grossPaise,
      userRewardPaise,
      targetStatus: isReversal ? "reversed" : "approved",
      transactionType: "offer_reward",
      sourceIp,
      rawPayload: payload
    });
    await db.query(
      `UPDATE provider_credentials SET configuration_status = 'verified', last_verified_at = CURRENT_TIMESTAMP WHERE provider_id = $1`,
      [provider.id]
    );
    await logAudit({
      action: "postback.adgem_processed",
      entityType: "offer_conversion",
      entityId: outcome.conversionId,
      ipAddress: sourceIp,
      metadata: { transactionId, outcome: outcome.outcome }
    });
    res.status(200).json({ status: "ok", outcome: outcome.outcome });
  } catch (err) {
    console.error("AdGem postback error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// server/routes/advertiserRoutes.ts
import fs2 from "node:fs";
import path2 from "node:path";
import crypto6 from "node:crypto";
import { Router as Router6 } from "express";
import { z as z5 } from "zod";
var advertiserRoutes = Router6();
advertiserRoutes.use(requireAuth);
advertiserRoutes.get("/me", async (req, res) => {
  try {
    const advRes = await db.query(
      `SELECT id, company_name, website_url, contact_email, tax_id, approval_status, notes, created_at
       FROM advertisers WHERE user_id = $1`,
      [req.user.id]
    );
    const advertiser = advRes.rows[0] || null;
    if (!advertiser) {
      res.json({ advertiser: null, campaigns: [] });
      return;
    }
    const campRes = await db.query(
      `SELECT id, title, description, category, reward_paise, budget_paise, spent_paise,
              estimated_minutes, instructions, eligibility_info, destination_url,
              image_url, approval_status, rejection_reason, created_at
       FROM campaigns
       WHERE advertiser_id = $1
       ORDER BY created_at DESC`,
      [advertiser.id]
    );
    res.json({
      advertiser: {
        id: advertiser.id,
        companyName: advertiser.company_name,
        websiteUrl: advertiser.website_url,
        contactEmail: advertiser.contact_email,
        taxId: advertiser.tax_id,
        approvalStatus: advertiser.approval_status,
        notes: advertiser.notes,
        createdAt: advertiser.created_at
      },
      campaigns: campRes.rows.map((c) => ({
        id: c.id,
        title: c.title,
        description: c.description,
        category: c.category,
        rewardPaise: Number(c.reward_paise),
        budgetPaise: Number(c.budget_paise),
        spentPaise: Number(c.spent_paise),
        estimatedMinutes: c.estimated_minutes,
        instructions: c.instructions,
        eligibilityInfo: c.eligibility_info,
        destinationUrl: c.destination_url,
        imageUrl: c.image_url,
        approvalStatus: c.approval_status,
        rejectionReason: c.rejection_reason || "",
        createdAt: c.created_at
      }))
    });
  } catch (err) {
    console.error("Advertiser profile fetch error:", err);
    res.status(500).json({ error: "Unable to load advertiser account." });
  }
});
var registerAdvertiserSchema = z5.object({
  companyName: z5.string().trim().min(2, "Company or brand name is required").max(180),
  websiteUrl: z5.string().trim().url("Please enter a valid website URL (including https://)"),
  contactEmail: z5.string().trim().email("Please enter a valid business contact email"),
  taxId: z5.string().trim().max(64).optional().default("")
});
advertiserRoutes.post("/register", async (req, res) => {
  const parsed = registerAdvertiserSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid advertiser details." });
    return;
  }
  try {
    const existing = await db.query(
      `SELECT id FROM advertisers WHERE user_id = $1`,
      [req.user.id]
    );
    if (existing.rows.length > 0) {
      res.status(409).json({ error: "An advertiser profile already exists for this account." });
      return;
    }
    const ins = await db.query(
      `INSERT INTO advertisers (user_id, company_name, website_url, contact_email, tax_id, approval_status)
       VALUES ($1, $2, $3, $4, $5, 'pending')
       RETURNING id`,
      [
        req.user.id,
        parsed.data.companyName,
        parsed.data.websiteUrl,
        parsed.data.contactEmail.toLowerCase(),
        parsed.data.taxId
      ]
    );
    if (req.user.role === "user") {
      await db.query(`UPDATE users SET role = 'advertiser', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [
        req.user.id
      ]);
    }
    await logAudit({
      actorUserId: req.user.id,
      action: "advertiser.registered",
      entityType: "advertiser",
      entityId: ins.rows[0]?.id,
      ipAddress: getClientIp(req),
      metadata: { companyName: parsed.data.companyName }
    });
    res.status(201).json({
      message: "Advertiser account created. You may draft campaigns now; all campaigns require admin review prior to publication."
    });
  } catch (err) {
    console.error("Register advertiser error:", err);
    res.status(500).json({ error: "Unable to register advertiser account." });
  }
});
var submitCampaignSchema = z5.object({
  title: z5.string().trim().min(5, "Campaign title must be at least 5 characters").max(200),
  description: z5.string().trim().min(15, "Campaign description must be at least 15 characters").max(2e3),
  category: z5.enum(["watch", "download", "surveys", "offers"]),
  rewardRupees: z5.union([z5.string(), z5.number()]),
  budgetRupees: z5.union([z5.string(), z5.number()]),
  estimatedMinutes: z5.number().int().min(1).max(180).optional().nullable(),
  instructions: z5.string().trim().min(10, "Clear completion instructions are required").max(2e3),
  eligibilityInfo: z5.string().trim().min(5, "Eligibility details are required").max(1e3),
  destinationUrl: z5.string().trim().url("Destination URL must be a valid https:// URL"),
  imageDataUrl: z5.string().optional().default("")
});
function saveUploadedCampaignImage(dataUrl) {
  if (!dataUrl) return null;
  const match = dataUrl.match(/^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) {
    throw new Error("Campaign image must be a PNG, JPEG, or WebP file.");
  }
  const ext = match[1] === "jpeg" ? "jpg" : match[1];
  const buffer = Buffer.from(match[2], "base64");
  if (buffer.length > 2 * 1024 * 1024) {
    throw new Error("Campaign image must be smaller than 2 MB.");
  }
  const uploadsDir = path2.resolve(process.cwd(), "data", "uploads");
  fs2.mkdirSync(uploadsDir, { recursive: true });
  const fileName = `camp_${Date.now()}_${crypto6.randomBytes(6).toString("hex")}.${ext}`;
  fs2.writeFileSync(path2.join(uploadsDir, fileName), buffer);
  return `/uploads/${fileName}`;
}
advertiserRoutes.post("/campaigns", async (req, res) => {
  const parsed = submitCampaignSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid campaign submission." });
    return;
  }
  let rewardPaise;
  let budgetPaise;
  try {
    rewardPaise = parseRupeesToPaise(parsed.data.rewardRupees);
    budgetPaise = parseRupeesToPaise(parsed.data.budgetRupees);
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "Invalid currency amounts." });
    return;
  }
  if (rewardPaise < 100) {
    res.status(400).json({ error: "Minimum reward per completion is \u20B91.00." });
    return;
  }
  if (budgetPaise < rewardPaise) {
    res.status(400).json({ error: "Campaign budget must be at least equal to the per-completion reward." });
    return;
  }
  try {
    const advRes = await db.query(
      `SELECT id, approval_status FROM advertisers WHERE user_id = $1`,
      [req.user.id]
    );
    const advertiser = advRes.rows[0];
    if (!advertiser) {
      res.status(400).json({ error: "Please register your advertiser profile before submitting campaigns." });
      return;
    }
    if (advertiser.approval_status === "rejected" || advertiser.approval_status === "suspended") {
      res.status(403).json({ error: "Your advertiser account is not permitted to submit new campaigns." });
      return;
    }
    let imageUrl = null;
    if (parsed.data.imageDataUrl) {
      try {
        imageUrl = saveUploadedCampaignImage(parsed.data.imageDataUrl);
      } catch (imgErr) {
        res.status(400).json({ error: imgErr instanceof Error ? imgErr.message : "Invalid image upload." });
        return;
      }
    }
    const ins = await db.query(
      `INSERT INTO campaigns
         (advertiser_id, title, description, category, reward_paise, budget_paise, estimated_minutes, instructions, eligibility_info, destination_url, image_url, incentivized_permitted, approval_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 1, 'pending_review')
       RETURNING id`,
      [
        advertiser.id,
        parsed.data.title,
        parsed.data.description,
        parsed.data.category,
        rewardPaise,
        budgetPaise,
        parsed.data.estimatedMinutes ?? null,
        parsed.data.instructions,
        parsed.data.eligibilityInfo,
        parsed.data.destinationUrl,
        imageUrl
      ]
    );
    await logAudit({
      actorUserId: req.user.id,
      action: "advertiser.campaign_submitted",
      entityType: "campaign",
      entityId: ins.rows[0]?.id,
      ipAddress: getClientIp(req),
      metadata: { title: parsed.data.title, category: parsed.data.category, rewardPaise, budgetPaise }
    });
    res.status(201).json({
      message: "Campaign submitted for administrator compliance review. It will only appear to members after approval.",
      campaignId: ins.rows[0]?.id
    });
  } catch (err) {
    console.error("Submit campaign error:", err);
    res.status(500).json({ error: "Unable to submit campaign." });
  }
});

// server/routes/adminRoutes.ts
import { Router as Router7 } from "express";
import { z as z6 } from "zod";
var adminRoutes = Router7();
adminRoutes.use(requireAdmin());
adminRoutes.get("/overview", async (_req, res) => {
  try {
    const [
      usersCount,
      activeUsersCount,
      suspendedUsersCount,
      pendingCampaigns,
      approvedCampaigns,
      pendingWithdrawals,
      paidWithdrawals,
      openTickets,
      openFraud,
      walletSums,
      conversionStats,
      contactCount
    ] = await Promise.all([
      db.query(`SELECT COUNT(*) AS count FROM users`),
      db.query(`SELECT COUNT(*) AS count FROM users WHERE account_status = 'active'`),
      db.query(`SELECT COUNT(*) AS count FROM users WHERE account_status IN ('suspended', 'banned')`),
      db.query(`SELECT COUNT(*) AS count FROM campaigns WHERE approval_status = 'pending_review'`),
      db.query(`SELECT COUNT(*) AS count FROM campaigns WHERE approval_status = 'approved'`),
      db.query(
        `SELECT COUNT(*) AS count, COALESCE(SUM(amount_paise), 0) AS total_paise FROM withdrawal_requests WHERE status IN ('pending', 'approved', 'processing')`
      ),
      db.query(
        `SELECT COUNT(*) AS count, COALESCE(SUM(amount_paise), 0) AS total_paise FROM withdrawal_requests WHERE status = 'paid'`
      ),
      db.query(`SELECT COUNT(*) AS count FROM support_tickets WHERE status IN ('open', 'in_progress')`),
      db.query(`SELECT COUNT(*) AS count FROM fraud_alerts WHERE status IN ('open', 'investigating')`),
      db.query(
        `SELECT COALESCE(SUM(available_paise), 0) AS available,
                COALESCE(SUM(pending_paise), 0) AS pending,
                COALESCE(SUM(lifetime_earned_paise), 0) AS lifetime,
                COALESCE(SUM(total_withdrawn_paise), 0) AS withdrawn
         FROM wallet_accounts`
      ),
      db.query(
        `SELECT status, COUNT(*) AS count, COALESCE(SUM(user_reward_paise), 0) AS total_user_paise, COALESCE(SUM(gross_payout_paise), 0) AS total_gross_paise
         FROM offer_conversions
         GROUP BY status`
      ),
      db.query(`SELECT COUNT(*) AS count FROM contact_messages WHERE status = 'new'`)
    ]);
    res.json({
      kpis: {
        totalUsers: Number(usersCount.rows[0]?.count ?? 0),
        activeUsers: Number(activeUsersCount.rows[0]?.count ?? 0),
        suspendedUsers: Number(suspendedUsersCount.rows[0]?.count ?? 0),
        pendingCampaigns: Number(pendingCampaigns.rows[0]?.count ?? 0),
        approvedCampaigns: Number(approvedCampaigns.rows[0]?.count ?? 0),
        pendingWithdrawalCount: Number(pendingWithdrawals.rows[0]?.count ?? 0),
        pendingWithdrawalPaise: Number(pendingWithdrawals.rows[0]?.total_paise ?? 0),
        paidWithdrawalCount: Number(paidWithdrawals.rows[0]?.count ?? 0),
        paidWithdrawalPaise: Number(paidWithdrawals.rows[0]?.total_paise ?? 0),
        openTickets: Number(openTickets.rows[0]?.count ?? 0),
        openFraudAlerts: Number(openFraud.rows[0]?.count ?? 0),
        newContactInquiries: Number(contactCount.rows[0]?.count ?? 0),
        totalWalletLiabilityPaise: Number(walletSums.rows[0]?.available ?? 0),
        totalPendingRewardsPaise: Number(walletSums.rows[0]?.pending ?? 0),
        totalLifetimeUserRewardsPaise: Number(walletSums.rows[0]?.lifetime ?? 0)
      },
      conversionsByStatus: conversionStats.rows.map((r) => ({
        status: r.status,
        count: Number(r.count),
        totalUserPaise: Number(r.total_user_paise),
        totalGrossPaise: Number(r.total_gross_paise)
      }))
    });
  } catch (err) {
    console.error("Admin overview error:", err);
    res.status(500).json({ error: "Unable to load admin overview." });
  }
});
adminRoutes.get("/users", requireAdmin("users.read"), async (req, res) => {
  try {
    const search = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const params = [];
    let where = "";
    if (search) {
      params.push(`%${search}%`);
      where = `WHERE u.full_name LIKE $1 OR u.email LIKE $1 OR u.public_uid LIKE $1`;
    }
    const rows = await db.query(
      `SELECT u.id, u.public_uid, u.full_name, u.email, u.role, u.account_status,
              u.email_verified, u.referral_code, u.signup_ip, u.created_at,
              COALESCE(w.available_paise, 0) AS available_paise,
              COALESCE(w.pending_paise, 0) AS pending_paise,
              COALESCE(w.lifetime_earned_paise, 0) AS lifetime_earned_paise,
              COALESCE(w.total_withdrawn_paise, 0) AS total_withdrawn_paise
       FROM users u
       LEFT JOIN wallet_accounts w ON w.user_id = u.id
       ${where}
       ORDER BY u.created_at DESC
       LIMIT 200`,
      params
    );
    res.json({
      users: rows.rows.map((u) => ({
        id: u.id,
        publicUid: u.public_uid,
        fullName: u.full_name,
        email: u.email,
        role: u.role,
        accountStatus: u.account_status,
        emailVerified: Boolean(u.email_verified),
        referralCode: u.referral_code,
        signupIp: u.signup_ip || "",
        createdAt: u.created_at,
        wallet: {
          availablePaise: Number(u.available_paise),
          pendingPaise: Number(u.pending_paise),
          lifetimeEarnedPaise: Number(u.lifetime_earned_paise),
          totalWithdrawnPaise: Number(u.total_withdrawn_paise)
        }
      }))
    });
  } catch (err) {
    console.error("Admin users error:", err);
    res.status(500).json({ error: "Unable to fetch users." });
  }
});
var updateUserStatusSchema = z6.object({
  accountStatus: z6.enum(["active", "suspended", "banned"]),
  reason: z6.string().trim().max(500).optional().default("")
});
adminRoutes.patch("/users/:id/status", requireAdmin("*"), async (req, res) => {
  const userId = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(userId)) {
    res.status(400).json({ error: "Invalid user ID." });
    return;
  }
  if (userId === req.user.id) {
    res.status(400).json({ error: "You cannot suspend or ban your own administrator account." });
    return;
  }
  const parsed = updateUserStatusSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid status update." });
    return;
  }
  try {
    await db.transaction(async (tx) => {
      await tx.query(
        `UPDATE users SET account_status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [parsed.data.accountStatus, userId]
      );
      if (parsed.data.accountStatus !== "active") {
        await tx.query(
          `UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = $1 AND revoked_at IS NULL`,
          [userId]
        );
      }
      await logAudit(
        {
          actorUserId: req.user.id,
          action: "admin.user_status_updated",
          entityType: "user",
          entityId: userId,
          ipAddress: getClientIp(req),
          metadata: parsed.data
        },
        tx
      );
    });
    res.json({ message: `User status changed to ${parsed.data.accountStatus}.` });
  } catch (err) {
    console.error("Update user status error:", err);
    res.status(500).json({ error: "Failed to update user status." });
  }
});
adminRoutes.get("/campaigns", requireAdmin("campaigns.manage"), async (_req, res) => {
  try {
    const [campRes, advRes] = await Promise.all([
      db.query(
        `SELECT c.id, c.title, c.description, c.category, c.reward_paise, c.budget_paise, c.spent_paise,
                c.estimated_minutes, c.instructions, c.eligibility_info, c.destination_url, c.image_url,
                c.approval_status, c.rejection_reason, c.created_at,
                a.company_name AS advertiser_name, p.name AS provider_name
         FROM campaigns c
         LEFT JOIN advertisers a ON a.id = c.advertiser_id
         LEFT JOIN advertising_providers p ON p.id = c.provider_id
         ORDER BY c.created_at DESC`
      ),
      db.query(
        `SELECT id, user_id, company_name, website_url, contact_email, approval_status, created_at
         FROM advertisers
         ORDER BY created_at DESC`
      )
    ]);
    res.json({
      campaigns: campRes.rows.map((c) => ({
        id: c.id,
        title: c.title,
        description: c.description,
        category: c.category,
        rewardPaise: Number(c.reward_paise),
        budgetPaise: Number(c.budget_paise),
        spentPaise: Number(c.spent_paise),
        estimatedMinutes: c.estimated_minutes,
        instructions: c.instructions,
        eligibilityInfo: c.eligibility_info,
        destinationUrl: c.destination_url,
        imageUrl: c.image_url,
        approvalStatus: c.approval_status,
        rejectionReason: c.rejection_reason || "",
        sourceName: c.advertiser_name || c.provider_name || "Admin Direct",
        createdAt: c.created_at
      })),
      advertisers: advRes.rows.map((a) => ({
        id: a.id,
        userId: a.user_id,
        companyName: a.company_name,
        websiteUrl: a.website_url,
        contactEmail: a.contact_email,
        approvalStatus: a.approval_status,
        createdAt: a.created_at
      }))
    });
  } catch (err) {
    console.error("Admin campaigns error:", err);
    res.status(500).json({ error: "Unable to load campaigns." });
  }
});
var reviewCampaignSchema = z6.object({
  approvalStatus: z6.enum(["approved", "paused", "rejected"]),
  rejectionReason: z6.string().trim().max(500).optional().default("")
});
adminRoutes.patch("/campaigns/:id/review", requireAdmin("campaigns.manage"), async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const parsed = reviewCampaignSchema.safeParse(req.body);
  if (!Number.isInteger(id) || !parsed.success) {
    res.status(400).json({ error: "Invalid campaign review request." });
    return;
  }
  try {
    await db.query(
      `UPDATE campaigns
       SET approval_status = $1, rejection_reason = $2, reviewed_by_user_id = $3,
           reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = $4`,
      [parsed.data.approvalStatus, parsed.data.rejectionReason, req.user.id, id]
    );
    await logAudit({
      actorUserId: req.user.id,
      action: "admin.campaign_reviewed",
      entityType: "campaign",
      entityId: id,
      ipAddress: getClientIp(req),
      metadata: parsed.data
    });
    res.json({ message: `Campaign marked as ${parsed.data.approvalStatus}.` });
  } catch (err) {
    console.error("Review campaign error:", err);
    res.status(500).json({ error: "Unable to update campaign status." });
  }
});
var createAdminCampaignSchema = z6.object({
  title: z6.string().trim().min(5).max(200),
  description: z6.string().trim().min(10).max(2e3),
  category: z6.enum(["watch", "download", "surveys", "offers"]),
  rewardRupees: z6.union([z6.string(), z6.number()]),
  budgetRupees: z6.union([z6.string(), z6.number()]).optional().default("0"),
  estimatedMinutes: z6.number().int().min(1).max(180).optional().nullable(),
  instructions: z6.string().trim().min(10).max(2e3),
  eligibilityInfo: z6.string().trim().min(5).max(1e3),
  destinationUrl: z6.string().trim().url().optional().or(z6.literal(""))
});
adminRoutes.post("/campaigns", requireAdmin("campaigns.manage"), async (req, res) => {
  const parsed = createAdminCampaignSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid campaign input." });
    return;
  }
  try {
    const rewardPaise = parseRupeesToPaise(parsed.data.rewardRupees);
    const budgetPaise = parseRupeesToPaise(parsed.data.budgetRupees);
    const ins = await db.query(
      `INSERT INTO campaigns
         (title, description, category, reward_paise, budget_paise, estimated_minutes, instructions, eligibility_info, destination_url, incentivized_permitted, approval_status, reviewed_by_user_id, reviewed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, 'approved', $10, CURRENT_TIMESTAMP)
       RETURNING id`,
      [
        parsed.data.title,
        parsed.data.description,
        parsed.data.category,
        rewardPaise,
        budgetPaise,
        parsed.data.estimatedMinutes ?? null,
        parsed.data.instructions,
        parsed.data.eligibilityInfo,
        parsed.data.destinationUrl || null,
        req.user.id
      ]
    );
    await logAudit({
      actorUserId: req.user.id,
      action: "admin.campaign_created",
      entityType: "campaign",
      entityId: ins.rows[0]?.id,
      ipAddress: getClientIp(req)
    });
    res.status(201).json({ message: "Approved campaign published.", id: ins.rows[0]?.id });
  } catch (err) {
    console.error("Create admin campaign error:", err);
    res.status(500).json({ error: "Unable to create campaign." });
  }
});
adminRoutes.patch("/advertisers/:id/review", requireAdmin("campaigns.manage"), async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const status = req.body?.approvalStatus;
  if (!Number.isInteger(id) || !["approved", "rejected", "suspended"].includes(status)) {
    res.status(400).json({ error: "Invalid advertiser approval status." });
    return;
  }
  try {
    await db.query(
      `UPDATE advertisers SET approval_status = $1, reviewed_by_user_id = $2, reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $3`,
      [status, req.user.id, id]
    );
    await logAudit({
      actorUserId: req.user.id,
      action: "admin.advertiser_reviewed",
      entityType: "advertiser",
      entityId: id,
      ipAddress: getClientIp(req),
      metadata: { status }
    });
    res.json({ message: `Advertiser status updated to ${status}.` });
  } catch (err) {
    console.error("Review advertiser error:", err);
    res.status(500).json({ error: "Unable to update advertiser status." });
  }
});
adminRoutes.get("/providers", async (_req, res) => {
  try {
    const rows = await db.query(
      `SELECT p.id, p.slug, p.name, p.provider_type, p.is_enabled, p.user_reward_percentage,
              p.docs_url, p.postback_path, p.notes, pc.env_app_id_key, pc.env_secret_key,
              pc.configuration_status, pc.last_verified_at
       FROM advertising_providers p
       LEFT JOIN provider_credentials pc ON pc.provider_id = p.id
       ORDER BY p.id ASC`
    );
    res.json({
      providers: rows.rows.map((p) => {
        const hasEnvCreds = p.slug === "ayet_studios" && Boolean(config.providers.ayet.adslotId && config.providers.ayet.publisherApiKey) || p.slug === "cpx_research" && Boolean(config.providers.cpx.appId && config.providers.cpx.secureHashSecret) || p.slug === "adgem" && Boolean(config.providers.adgem.appId && config.providers.adgem.postbackKey);
        return {
          id: p.id,
          slug: p.slug,
          name: p.name,
          providerType: p.provider_type,
          isEnabled: Boolean(p.is_enabled),
          userRewardPercentage: Number(p.user_reward_percentage),
          docsUrl: p.docs_url,
          postbackUrl: `${config.appUrl}${p.postback_path}`,
          notes: p.notes,
          envAppIdKey: p.env_app_id_key,
          envSecretKey: p.env_secret_key,
          hasEnvCreds,
          configurationStatus: hasEnvCreds ? p.configuration_status : "not_configured",
          lastVerifiedAt: p.last_verified_at
        };
      })
    });
  } catch (err) {
    console.error("Admin providers error:", err);
    res.status(500).json({ error: "Unable to load provider settings." });
  }
});
var updateProviderSchema = z6.object({
  isEnabled: z6.boolean(),
  userRewardPercentage: z6.number().int().min(10).max(100)
});
adminRoutes.patch("/providers/:id", requireAdmin("*"), async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const parsed = updateProviderSchema.safeParse(req.body);
  if (!Number.isInteger(id) || !parsed.success) {
    res.status(400).json({ error: "Reward percentage must be an integer between 10 and 100." });
    return;
  }
  try {
    await db.query(
      `UPDATE advertising_providers
       SET is_enabled = $1, user_reward_percentage = $2, updated_at = CURRENT_TIMESTAMP
       WHERE id = $3`,
      [parsed.data.isEnabled ? 1 : 0, parsed.data.userRewardPercentage, id]
    );
    await logAudit({
      actorUserId: req.user.id,
      action: "admin.provider_updated",
      entityType: "advertising_provider",
      entityId: id,
      ipAddress: getClientIp(req),
      metadata: parsed.data
    });
    res.json({ message: "Provider configuration saved." });
  } catch (err) {
    console.error("Update provider error:", err);
    res.status(500).json({ error: "Unable to update provider settings." });
  }
});
adminRoutes.get("/withdrawals", requireAdmin("withdrawals.manage"), async (req, res) => {
  try {
    const status = typeof req.query.status === "string" ? req.query.status : "";
    const params = [];
    let where = "";
    if (["pending", "approved", "processing", "paid", "rejected"].includes(status)) {
      params.push(status);
      where = `WHERE wr.status = $1`;
    }
    const rows = await db.query(
      `SELECT wr.id, wr.request_uid, wr.user_id, u.full_name AS user_name, u.email AS user_email,
              u.public_uid AS user_public_uid, wr.method, wr.amount_paise, wr.upi_id,
              wr.bank_account_holder, wr.bank_account_number, wr.bank_ifsc, wr.bank_name,
              wr.status, wr.admin_note, wr.payment_reference, wr.created_at, wr.paid_at
       FROM withdrawal_requests wr
       INNER JOIN users u ON u.id = wr.user_id
       ${where}
       ORDER BY wr.created_at DESC
       LIMIT 200`,
      params
    );
    res.json({
      withdrawals: rows.rows.map((w) => ({
        id: w.id,
        requestUid: w.request_uid,
        userId: w.user_id,
        userName: w.user_name,
        userEmail: w.user_email,
        userPublicUid: w.user_public_uid,
        method: w.method,
        amountPaise: Number(w.amount_paise),
        upiId: w.upi_id,
        bankAccountHolder: w.bank_account_holder,
        bankAccountNumber: w.bank_account_number,
        bankIfsc: w.bank_ifsc,
        bankName: w.bank_name,
        status: w.status,
        adminNote: w.admin_note,
        paymentReference: w.payment_reference,
        createdAt: w.created_at,
        paidAt: w.paid_at
      }))
    });
  } catch (err) {
    console.error("Admin withdrawals error:", err);
    res.status(500).json({ error: "Unable to load withdrawals." });
  }
});
var reviewWithdrawalSchema = z6.object({
  status: z6.enum(["approved", "processing", "paid", "rejected"]),
  adminNote: z6.string().trim().max(500).optional().default(""),
  paymentReference: z6.string().trim().max(160).optional().default("")
});
adminRoutes.patch("/withdrawals/:id", requireAdmin("withdrawals.manage"), async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const parsed = reviewWithdrawalSchema.safeParse(req.body);
  if (!Number.isInteger(id) || !parsed.success) {
    res.status(400).json({ error: "Invalid withdrawal review payload." });
    return;
  }
  if (parsed.data.status === "paid" && !parsed.data.paymentReference) {
    res.status(400).json({
      error: "A UTR / bank transaction payment reference is required before marking a withdrawal as Paid."
    });
    return;
  }
  try {
    const result = await db.transaction(async (tx) => {
      const existingRes = await tx.query(
        `SELECT id, request_uid, user_id, amount_paise, status FROM withdrawal_requests WHERE id = $1`,
        [id]
      );
      const wr = existingRes.rows[0];
      if (!wr) {
        return { error: "Withdrawal request not found.", statusCode: 404 };
      }
      if (wr.status === "paid" || wr.status === "rejected") {
        return { error: `Withdrawal is already finalized as ${wr.status}.`, statusCode: 400 };
      }
      const amount = Number(wr.amount_paise);
      await tx.query(
        `UPDATE withdrawal_requests
         SET status = $1, admin_note = $2, payment_reference = $3,
             reviewed_by_user_id = $4, reviewed_at = CURRENT_TIMESTAMP,
             paid_at = CASE WHEN $1 = 'paid' THEN CURRENT_TIMESTAMP ELSE paid_at END,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $5`,
        [parsed.data.status, parsed.data.adminNote, parsed.data.paymentReference, req.user.id, id]
      );
      if (parsed.data.status === "paid") {
        await tx.query(
          `UPDATE wallet_accounts
           SET total_withdrawn_paise = total_withdrawn_paise + $1, updated_at = CURRENT_TIMESTAMP
           WHERE user_id = $2`,
          [amount, wr.user_id]
        );
        await createNotification(
          {
            userId: wr.user_id,
            title: "Withdrawal Paid",
            body: `Your withdrawal ${wr.request_uid} (${formatPaiseToInr(amount)}) was confirmed paid. Reference: ${parsed.data.paymentReference}.`,
            category: "withdrawal"
          },
          tx
        );
      } else if (parsed.data.status === "rejected") {
        await tx.query(
          `UPDATE wallet_accounts
           SET available_paise = available_paise + $1, updated_at = CURRENT_TIMESTAMP
           WHERE user_id = $2`,
          [amount, wr.user_id]
        );
        await tx.query(
          `INSERT INTO wallet_transactions
             (tx_uid, user_id, amount_paise, transaction_type, status, description)
           VALUES ($1, $2, $3, 'withdrawal_refund', 'approved', $4)`,
          [
            generateUid("TXN"),
            wr.user_id,
            amount,
            `Refund for rejected withdrawal ${wr.request_uid}${parsed.data.adminNote ? `: ${parsed.data.adminNote}` : ""}`
          ]
        );
        await createNotification(
          {
            userId: wr.user_id,
            title: "Withdrawal Rejected & Refunded",
            body: `Withdrawal ${wr.request_uid} (${formatPaiseToInr(amount)}) was rejected and returned to your available balance. ${parsed.data.adminNote}`,
            category: "withdrawal"
          },
          tx
        );
      } else {
        await createNotification(
          {
            userId: wr.user_id,
            title: `Withdrawal Status: ${parsed.data.status}`,
            body: `Your withdrawal ${wr.request_uid} (${formatPaiseToInr(amount)}) is now ${parsed.data.status}.`,
            category: "withdrawal"
          },
          tx
        );
      }
      await logAudit(
        {
          actorUserId: req.user.id,
          action: `admin.withdrawal_${parsed.data.status}`,
          entityType: "withdrawal_request",
          entityId: id,
          ipAddress: getClientIp(req),
          metadata: {
            requestUid: wr.request_uid,
            amountPaise: amount,
            paymentReference: parsed.data.paymentReference,
            adminNote: parsed.data.adminNote
          }
        },
        tx
      );
      return { ok: true };
    });
    if ("error" in result) {
      res.status(result.statusCode || 400).json({ error: result.error });
      return;
    }
    res.json({ message: `Withdrawal status updated to ${parsed.data.status}.` });
  } catch (err) {
    console.error("Review withdrawal error:", err);
    res.status(500).json({ error: "Unable to update withdrawal." });
  }
});
adminRoutes.get("/transactions", requireAdmin("transactions.read"), async (_req, res) => {
  try {
    const rows = await db.query(
      `SELECT wt.id, wt.tx_uid, u.full_name AS user_name, u.email AS user_email,
              p.name AS provider_name, wt.amount_paise, wt.transaction_type, wt.status,
              wt.provider_conversion_ref, wt.description, wt.created_at
       FROM wallet_transactions wt
       INNER JOIN users u ON u.id = wt.user_id
       LEFT JOIN advertising_providers p ON p.id = wt.provider_id
       ORDER BY wt.created_at DESC
       LIMIT 200`
    );
    res.json({
      transactions: rows.rows.map((t) => ({
        id: t.id,
        txUid: t.tx_uid,
        userName: t.user_name,
        userEmail: t.user_email,
        providerName: t.provider_name || "Platform Ledger",
        amountPaise: Number(t.amount_paise),
        transactionType: t.transaction_type,
        status: t.status,
        providerConversionRef: t.provider_conversion_ref,
        description: t.description,
        createdAt: t.created_at
      }))
    });
  } catch (err) {
    console.error("Admin transactions error:", err);
    res.status(500).json({ error: "Unable to load transactions." });
  }
});
adminRoutes.get("/referrals", async (_req, res) => {
  try {
    const rows = await db.query(
      `SELECT r.id, u1.full_name AS referrer_name, u1.email AS referrer_email,
              u2.full_name AS referred_name, u2.email AS referred_email,
              r.bonus_paise, r.status, r.fraud_check_note, r.created_at
       FROM referral_records r
       INNER JOIN users u1 ON u1.id = r.referrer_user_id
       INNER JOIN users u2 ON u2.id = r.referred_user_id
       ORDER BY r.created_at DESC
       LIMIT 200`
    );
    res.json({
      referrals: rows.rows.map((r) => ({
        id: r.id,
        referrerName: r.referrer_name,
        referrerEmail: r.referrer_email,
        referredName: r.referred_name,
        referredEmail: r.referred_email,
        bonusPaise: Number(r.bonus_paise),
        status: r.status,
        fraudCheckNote: r.fraud_check_note,
        createdAt: r.created_at
      }))
    });
  } catch (err) {
    console.error("Admin referrals error:", err);
    res.status(500).json({ error: "Unable to load referrals." });
  }
});
adminRoutes.get("/settings", async (_req, res) => {
  try {
    const rows = await db.query(
      `SELECT setting_key, setting_value, description FROM website_settings ORDER BY setting_key ASC`
    );
    res.json({ settings: rows.rows });
  } catch (err) {
    console.error("Admin settings error:", err);
    res.status(500).json({ error: "Unable to load settings." });
  }
});
adminRoutes.put("/settings", requireAdmin("*"), async (req, res) => {
  const updates = req.body?.settings;
  if (!Array.isArray(updates)) {
    res.status(400).json({ error: "Settings array is required." });
    return;
  }
  try {
    await db.transaction(async (tx) => {
      for (const item of updates) {
        if (typeof item?.setting_key !== "string" || typeof item?.setting_value !== "string") continue;
        await tx.query(
          `UPDATE website_settings
           SET setting_value = $1, updated_by_user_id = $2, updated_at = CURRENT_TIMESTAMP
           WHERE setting_key = $3`,
          [item.setting_value.trim(), req.user.id, item.setting_key]
        );
      }
      await logAudit(
        {
          actorUserId: req.user.id,
          action: "admin.settings_updated",
          entityType: "website_settings",
          ipAddress: getClientIp(req),
          metadata: { keys: updates.map((u) => u.setting_key) }
        },
        tx
      );
    });
    res.json({ message: "Website settings updated." });
  } catch (err) {
    console.error("Update settings error:", err);
    res.status(500).json({ error: "Unable to save settings." });
  }
});
adminRoutes.get("/tickets", requireAdmin("tickets.manage"), async (_req, res) => {
  try {
    const [ticketsRes, contactsRes] = await Promise.all([
      db.query(
        `SELECT t.id, t.ticket_uid, u.full_name AS user_name, u.email AS user_email,
                t.category, t.subject, t.message, t.status, t.admin_reply, t.created_at
         FROM support_tickets t
         INNER JOIN users u ON u.id = t.user_id
         ORDER BY t.created_at DESC
         LIMIT 200`
      ),
      db.query(
        `SELECT id, full_name, email, subject, message, status, created_at
         FROM contact_messages
         ORDER BY created_at DESC
         LIMIT 100`
      )
    ]);
    res.json({
      tickets: ticketsRes.rows.map((t) => ({
        id: t.id,
        ticketUid: t.ticket_uid,
        userName: t.user_name,
        userEmail: t.user_email,
        category: t.category,
        subject: t.subject,
        message: t.message,
        status: t.status,
        adminReply: t.admin_reply,
        createdAt: t.created_at
      })),
      contactMessages: contactsRes.rows
    });
  } catch (err) {
    console.error("Admin tickets error:", err);
    res.status(500).json({ error: "Unable to load support tickets." });
  }
});
var replyTicketSchema = z6.object({
  status: z6.enum(["open", "in_progress", "resolved", "closed"]),
  adminReply: z6.string().trim().max(3e3)
});
adminRoutes.patch("/tickets/:id", requireAdmin("tickets.manage"), async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const parsed = replyTicketSchema.safeParse(req.body);
  if (!Number.isInteger(id) || !parsed.success) {
    res.status(400).json({ error: "Invalid ticket update." });
    return;
  }
  try {
    const tRes = await db.query(
      `SELECT user_id, ticket_uid FROM support_tickets WHERE id = $1`,
      [id]
    );
    const ticket = tRes.rows[0];
    if (!ticket) {
      res.status(404).json({ error: "Ticket not found." });
      return;
    }
    await db.query(
      `UPDATE support_tickets
       SET status = $1, admin_reply = $2, assigned_admin_id = $3, updated_at = CURRENT_TIMESTAMP
       WHERE id = $4`,
      [parsed.data.status, parsed.data.adminReply, req.user.id, id]
    );
    await createNotification({
      userId: ticket.user_id,
      title: `Support Ticket ${ticket.ticket_uid} Updated`,
      body: `Status changed to ${parsed.data.status}. ${parsed.data.adminReply.slice(0, 160)}`,
      category: "support"
    });
    res.json({ message: "Ticket reply saved." });
  } catch (err) {
    console.error("Reply ticket error:", err);
    res.status(500).json({ error: "Unable to update support ticket." });
  }
});
adminRoutes.get("/fraud-alerts", requireAdmin("fraud.manage"), async (_req, res) => {
  try {
    const [alertsRes, auditRes] = await Promise.all([
      db.query(
        `SELECT f.id, f.user_id, u.email AS user_email, f.alert_type, f.severity,
                f.description, f.source_ip, f.status, f.resolution_note, f.created_at
         FROM fraud_alerts f
         LEFT JOIN users u ON u.id = f.user_id
         ORDER BY f.created_at DESC
         LIMIT 150`
      ),
      db.query(
        `SELECT a.id, u.email AS actor_email, a.action, a.entity_type, a.entity_id,
                a.ip_address, a.metadata, a.created_at
         FROM audit_logs a
         LEFT JOIN users u ON u.id = a.actor_user_id
         ORDER BY a.created_at DESC
         LIMIT 150`
      )
    ]);
    res.json({
      fraudAlerts: alertsRes.rows.map((f) => ({
        id: f.id,
        userId: f.user_id,
        userEmail: f.user_email || "System / Unauthenticated",
        alertType: f.alert_type,
        severity: f.severity,
        description: f.description,
        sourceIp: f.source_ip || "",
        status: f.status,
        resolutionNote: f.resolution_note,
        createdAt: f.created_at
      })),
      auditLogs: auditRes.rows.map((a) => ({
        id: a.id,
        actorEmail: a.actor_email || "System",
        action: a.action,
        entityType: a.entity_type,
        entityId: a.entity_id || "",
        ipAddress: a.ip_address || "",
        metadata: a.metadata,
        createdAt: a.created_at
      }))
    });
  } catch (err) {
    console.error("Admin fraud alerts error:", err);
    res.status(500).json({ error: "Unable to load fraud alerts and audit logs." });
  }
});
adminRoutes.patch("/fraud-alerts/:id", requireAdmin("fraud.manage"), async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const status = req.body?.status;
  const resolutionNote = typeof req.body?.resolutionNote === "string" ? req.body.resolutionNote.trim() : "";
  if (!Number.isInteger(id) || !["investigating", "resolved", "dismissed"].includes(status)) {
    res.status(400).json({ error: "Invalid fraud alert status." });
    return;
  }
  try {
    await db.query(
      `UPDATE fraud_alerts
       SET status = $1, resolution_note = $2, resolved_by_user_id = $3, updated_at = CURRENT_TIMESTAMP
       WHERE id = $4`,
      [status, resolutionNote, req.user.id, id]
    );
    await logAudit({
      actorUserId: req.user.id,
      action: "admin.fraud_alert_updated",
      entityType: "fraud_alert",
      entityId: id,
      ipAddress: getClientIp(req),
      metadata: { status, resolutionNote }
    });
    res.json({ message: `Fraud alert marked as ${status}.` });
  } catch (err) {
    console.error("Resolve fraud alert error:", err);
    res.status(500).json({ error: "Unable to update fraud alert." });
  }
});

// server.ts
async function startServer() {
  await db.init();
  await seedDatabase();
  const app = express();
  app.set("trust proxy", 1);
  app.use(
    helmet({
      contentSecurityPolicy: false,
      // Allows Vite module scripts & official provider offerwall iframes
      crossOriginEmbedderPolicy: false,
      frameguard: false
      // Allows preview inside AI Studio / Replit iframe
    })
  );
  app.use(cookieParser());
  app.use(
    express.json({
      limit: "4mb",
      verify: (req, _res, buf) => {
        req.rawBody = buf;
      }
    })
  );
  const uploadsDir = path3.resolve(process.cwd(), "data", "uploads");
  fs3.mkdirSync(uploadsDir, { recursive: true });
  app.use("/uploads", express.static(uploadsDir, { maxAge: "1d" }));
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, dbDriver: db.driver });
  });
  app.use("/api/postbacks", postbackRoutes);
  app.use("/api/v1/postbacks", postbackRoutes);
  app.use("/api", attachSession, verifyCsrf);
  for (const prefix of ["/api", "/api/v1"]) {
    app.use(`${prefix}/public`, publicRoutes);
    app.use(`${prefix}/auth`, authRoutes);
    app.use(`${prefix}/user`, userRoutes);
    app.use(`${prefix}/withdrawals`, withdrawalRoutes);
    app.use(`${prefix}/providers`, providerRoutes);
    app.use(`${prefix}/advertiser`, advertiserRoutes);
    app.use(`${prefix}/admin`, adminRoutes);
  }
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "API endpoint not found." });
  });
  const distDir = path3.resolve(process.cwd(), "dist");
  if (!config.isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa"
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(distDir));
    app.get("*", (_req, res) => {
      res.sendFile(path3.join(distDir, "index.html"));
    });
  }
  app.listen(config.port, "0.0.0.0", () => {
    console.log(`Kredova server running on http://0.0.0.0:${config.port} (db: ${db.driver})`);
  });
}
startServer().catch((err) => {
  console.error("Fatal server startup error:", err);
  process.exit(1);
});
