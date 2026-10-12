import type { Database } from "./types";

const currentVersion = 1;

/** Keep schema changes versioned and serialize migrations within each schema. */
export async function migrateDatabase(db: Database): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`schema-migrations:${db.schema}`]);
    await tx.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY
      )
    `);
    const result = await tx.query<{ version: number | null }>(
      "SELECT MAX(version)::int AS version FROM schema_migrations",
    );
    const version = result.rows[0]?.version ?? 0;
    if (version > currentVersion) {
      throw new Error("Die Datenbank wurde mit einer neueren Serverversion erstellt.");
    }
    if (version === currentVersion) return;

    const statements = [
      `CREATE TABLE users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      "CREATE UNIQUE INDEX users_email_lower ON users(lower(email))",
      `CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      "CREATE INDEX sessions_user_id ON sessions(user_id)",
      "CREATE INDEX sessions_expires_at ON sessions(expires_at)",
      `CREATE TABLE password_resets (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      "CREATE INDEX password_resets_user_id ON password_resets(user_id)",
      `CREATE TABLE settings (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        base_currency TEXT NOT NULL DEFAULT 'EUR' CHECK (base_currency IN ('EUR', 'USD', 'CHF', 'GBP')),
        theme TEXT NOT NULL DEFAULT 'system' CHECK (theme IN ('system', 'light', 'dark'))
      )`,
      `CREATE TABLE watchlist (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        instrument_id TEXT NOT NULL,
        instrument_json TEXT NOT NULL,
        added_at TEXT NOT NULL,
        PRIMARY KEY (user_id, instrument_id)
      )`,
      `CREATE TABLE transactions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        instrument_id TEXT NOT NULL,
        instrument_json TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('BUY', 'SELL', 'DIVIDEND', 'SPLIT')),
        date TEXT NOT NULL,
        quantity DOUBLE PRECISION NOT NULL CHECK (quantity >= 0),
        price DOUBLE PRECISION NOT NULL CHECK (price >= 0),
        fees DOUBLE PRECISION NOT NULL CHECK (fees >= 0),
        currency TEXT NOT NULL,
        ratio DOUBLE PRECISION,
        note TEXT,
        client_request_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (user_id, client_request_id),
        CHECK ((type = 'SPLIT' AND ratio IS NOT NULL AND ratio > 0) OR (type <> 'SPLIT' AND ratio IS NULL))
      )`,
      "CREATE INDEX transactions_user_instrument ON transactions(user_id, instrument_id, date)",
      `CREATE TABLE price_alerts (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        instrument_id TEXT NOT NULL,
        instrument_json TEXT NOT NULL,
        condition TEXT NOT NULL CHECK (condition IN ('ABOVE', 'BELOW')),
        target_price DOUBLE PRECISION NOT NULL CHECK (target_price > 0),
        currency TEXT NOT NULL,
        note TEXT,
        created_at TEXT NOT NULL,
        triggered_at TEXT,
        triggered_price DOUBLE PRECISION
      )`,
      "CREATE INDEX price_alerts_user_instrument ON price_alerts(user_id, instrument_id)",
    ];
    for (const statement of statements) await tx.query(statement);
    await tx.query("INSERT INTO schema_migrations (version) VALUES ($1)", [currentVersion]);
  });
}
