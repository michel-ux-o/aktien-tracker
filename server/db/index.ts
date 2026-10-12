import { randomUUID } from "node:crypto";
import type { Instrument, PriceAlert, Transaction, UserSettings } from "../../shared/types";
import { migrateDatabase } from "./schema";
import type {
  AtomicOptions, Database, Repositories, SqlClient, StoredPriceAlert, StoredSession, StoredUser, StoredWatchlistItem,
} from "./types";

export type {
  AtomicOptions, Database, QueryResult, Repositories, SqlClient, StoredPasswordReset, StoredPriceAlert,
  StoredSession, StoredUser, StoredWatchlistItem,
} from "./types";

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  created_at: string;
}

interface TokenRow {
  user_id: string;
  token_hash: string;
  expires_at: string;
  created_at: string;
}

interface SettingsRow {
  base_currency: string;
  theme: UserSettings["theme"];
}

interface WatchlistRow {
  instrument_json: string;
  added_at: string;
}

interface TransactionRow {
  id: string;
  instrument_id: string;
  instrument_json: string;
  type: Transaction["type"];
  date: string;
  quantity: number;
  price: number;
  fees: number;
  currency: string;
  ratio: number | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

interface PriceAlertRow {
  id: string;
  instrument_id: string;
  instrument_json: string;
  condition: PriceAlert["condition"];
  target_price: number;
  currency: string;
  note: string | null;
  created_at: string;
  triggered_at: string | null;
  triggered_price: number | null;
}

function mapUser(row: UserRow): StoredUser {
  return { id: row.id, email: row.email, passwordHash: row.password_hash, createdAt: row.created_at };
}

function mapToken(row: TokenRow): StoredSession {
  return { userId: row.user_id, tokenHash: row.token_hash, expiresAt: row.expires_at, createdAt: row.created_at };
}

function mapSettings(row: SettingsRow): UserSettings {
  return { baseCurrency: row.base_currency, theme: row.theme };
}

function mapWatchlistItem(row: WatchlistRow): StoredWatchlistItem {
  return { instrument: JSON.parse(row.instrument_json) as Instrument, addedAt: row.added_at };
}

function mapTransaction(row: TransactionRow): Transaction {
  return {
    id: row.id,
    instrumentId: row.instrument_id,
    instrument: JSON.parse(row.instrument_json) as Instrument,
    type: row.type,
    date: row.date,
    quantity: row.quantity,
    price: row.price,
    fees: row.fees,
    currency: row.currency,
    ratio: row.ratio,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapPriceAlert(row: PriceAlertRow): StoredPriceAlert {
  return {
    id: row.id,
    instrumentId: row.instrument_id,
    instrument: JSON.parse(row.instrument_json) as Instrument,
    condition: row.condition,
    targetPrice: row.target_price,
    currency: row.currency,
    note: row.note,
    createdAt: row.created_at,
    triggeredAt: row.triggered_at,
    triggeredPrice: row.triggered_price,
  };
}

/** Bind every method to the current SQL client; no transaction state is shared between requests. */
function bindRepositories(db: Database, client: SqlClient = db, inTransaction = false): Repositories {
  function withTransaction<T>(operation: (tx: SqlClient) => Promise<T>): Promise<T> {
    return inTransaction ? operation(client) : db.transaction(operation);
  }

  async function atomic<T>(operation: (repos: Repositories) => Promise<T>, options: AtomicOptions = {}): Promise<T> {
    if (!inTransaction) {
      return db.transaction((tx) => bindRepositories(db, tx, true).atomic(operation, options));
    }
    if (options.lockKey !== undefined) {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [options.lockKey]);
    }
    return operation(repos);
  }

  const repos: Repositories = {
    atomic,
    users: {
      async findByEmail(email) {
        const { rows } = await client.query<UserRow>("SELECT * FROM users WHERE lower(email) = lower($1)", [email]);
        return rows[0] ? mapUser(rows[0]) : undefined;
      },
      async findById(userId) {
        const { rows } = await client.query<UserRow>("SELECT * FROM users WHERE id = $1", [userId]);
        return rows[0] ? mapUser(rows[0]) : undefined;
      },
      async create(email, passwordHash, now) {
        return withTransaction(async (tx) => {
          const user = { id: randomUUID(), email: email.trim().toLowerCase(), passwordHash, createdAt: now };
          await tx.query("INSERT INTO users (id, email, password_hash, created_at) VALUES ($1, $2, $3, $4)",
            [user.id, user.email, passwordHash, now]);
          await tx.query("INSERT INTO settings (user_id) VALUES ($1)", [user.id]);
          return user;
        });
      },
      async updatePassword(userId, passwordHash) {
        const { rowCount } = await client.query("UPDATE users SET password_hash = $2 WHERE id = $1", [userId, passwordHash]);
        return rowCount > 0;
      },
    },
    sessions: {
      async create(userId, tokenHash, expiresAt, now) {
        await client.query("INSERT INTO sessions (user_id, token_hash, expires_at, created_at) VALUES ($1, $2, $3, $4)",
          [userId, tokenHash, expiresAt, now]);
      },
      async findValid(tokenHash, now) {
        const { rows } = await client.query<TokenRow>("SELECT * FROM sessions WHERE token_hash = $1 AND expires_at > $2",
          [tokenHash, now]);
        return rows[0] ? mapToken(rows[0]) : undefined;
      },
      async delete(tokenHash) {
        const { rowCount } = await client.query("DELETE FROM sessions WHERE token_hash = $1", [tokenHash]);
        return rowCount > 0;
      },
      async deleteForUser(userId) {
        await client.query("DELETE FROM sessions WHERE user_id = $1", [userId]);
      },
    },
    passwordResets: {
      async create(userId, tokenHash, expiresAt, now) {
        await client.query("INSERT INTO password_resets (user_id, token_hash, expires_at, created_at) VALUES ($1, $2, $3, $4)",
          [userId, tokenHash, expiresAt, now]);
      },
      async findValid(tokenHash, now) {
        const { rows } = await client.query<TokenRow>("SELECT * FROM password_resets WHERE token_hash = $1 AND expires_at > $2",
          [tokenHash, now]);
        return rows[0] ? mapToken(rows[0]) : undefined;
      },
      async consume(tokenHash) {
        const { rowCount } = await client.query("DELETE FROM password_resets WHERE token_hash = $1", [tokenHash]);
        return rowCount > 0;
      },
    },
    settings: {
      async get(userId) {
        const { rows } = await client.query<SettingsRow>("SELECT base_currency, theme FROM settings WHERE user_id = $1", [userId]);
        return rows[0] ? mapSettings(rows[0]) : { baseCurrency: "EUR", theme: "system" };
      },
      async update(userId, changes) {
        return withTransaction(async (tx) => {
          // Update only supplied fields, so concurrent partial updates do not overwrite each other.
          const { rows } = await tx.query<SettingsRow>(`INSERT INTO settings (user_id, base_currency, theme)
            VALUES ($1, COALESCE($2::text, 'EUR'), COALESCE($3::text, 'system'))
            ON CONFLICT (user_id) DO UPDATE SET
              base_currency = COALESCE($2::text, settings.base_currency),
              theme = COALESCE($3::text, settings.theme)
            RETURNING base_currency, theme`, [userId, changes.baseCurrency ?? null, changes.theme ?? null]);
          return mapSettings(rows[0]!);
        });
      },
    },
    watchlist: {
      async list(userId) {
        const { rows } = await client.query<WatchlistRow>(`SELECT instrument_json, added_at FROM watchlist
          WHERE user_id = $1 ORDER BY added_at DESC, instrument_id ASC`, [userId]);
        return rows.map(mapWatchlistItem);
      },
      async add(userId, instrument, now) {
        return withTransaction(async (tx) => {
          while (true) {
            const inserted = await tx.query<WatchlistRow>(`INSERT INTO watchlist
              (user_id, instrument_id, instrument_json, added_at) VALUES ($1, $2, $3, $4)
              ON CONFLICT (user_id, instrument_id) DO NOTHING RETURNING instrument_json, added_at`,
            [userId, instrument.id, JSON.stringify(instrument), now]);
            if (inserted.rows[0]) return { item: mapWatchlistItem(inserted.rows[0]), created: true };
            const { rows } = await tx.query<WatchlistRow>(`SELECT instrument_json, added_at FROM watchlist
              WHERE user_id = $1 AND instrument_id = $2 FOR UPDATE`, [userId, instrument.id]);
            if (rows[0]) return { item: mapWatchlistItem(rows[0]), created: false };
            // A concurrent deletion may remove the conflict before SELECT; retry the insert.
          }
        });
      },
      async delete(userId, instrumentId) {
        const { rowCount } = await client.query("DELETE FROM watchlist WHERE user_id = $1 AND instrument_id = $2",
          [userId, instrumentId]);
        return rowCount > 0;
      },
    },
    transactions: {
      async list(userId, instrumentId) {
        const { rows } = instrumentId === undefined
          ? await client.query<TransactionRow>("SELECT * FROM transactions WHERE user_id = $1 ORDER BY date DESC, created_at DESC, id DESC", [userId])
          : await client.query<TransactionRow>(`SELECT * FROM transactions WHERE user_id = $1 AND instrument_id = $2
            ORDER BY date DESC, created_at DESC, id DESC`, [userId, instrumentId]);
        return rows.map(mapTransaction);
      },
      async get(userId, id) {
        const { rows } = await client.query<TransactionRow>("SELECT * FROM transactions WHERE user_id = $1 AND id = $2", [userId, id]);
        return rows[0] ? mapTransaction(rows[0]) : undefined;
      },
      async findByClientRequestId(userId, requestId) {
        const { rows } = await client.query<TransactionRow>("SELECT * FROM transactions WHERE user_id = $1 AND client_request_id = $2",
          [userId, requestId]);
        return rows[0] ? mapTransaction(rows[0]) : undefined;
      },
      async listByClientRequestIdPrefix(userId, prefix) {
        const { rows } = await client.query<TransactionRow>(`SELECT * FROM transactions
          WHERE user_id = $1 AND left(client_request_id, length($2)) = $2
          ORDER BY CASE WHEN substring(client_request_id FROM length($2) + 1) ~ '^[0-9]+$'
            THEN substring(client_request_id FROM length($2) + 1)::numeric ELSE 0 END ASC,
            client_request_id ASC, id ASC`, [userId, prefix]);
        return rows.map(mapTransaction);
      },
      async create(userId, input, now) {
        const { rows } = await client.query<TransactionRow>(`INSERT INTO transactions
          (id, user_id, instrument_id, instrument_json, type, date, quantity, price, fees, currency, ratio, note, client_request_id, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`, [
          randomUUID(), userId, input.instrument.id, JSON.stringify(input.instrument), input.type, input.date,
          input.quantity, input.price, input.fees, input.currency, input.type === "SPLIT" ? input.ratio ?? null : null,
          input.note ?? null, input.clientRequestId ?? null, now, now,
        ]);
        return mapTransaction(rows[0]!);
      },
      async update(userId, id, input, now) {
        const { rows } = await client.query<TransactionRow>(`UPDATE transactions SET instrument_id = $3, instrument_json = $4,
          type = $5, date = $6, quantity = $7, price = $8, fees = $9, currency = $10, ratio = $11, note = $12, updated_at = $13
          WHERE user_id = $1 AND id = $2 RETURNING *`, [
          userId, id, input.instrument.id, JSON.stringify(input.instrument), input.type, input.date,
          input.quantity, input.price, input.fees, input.currency, input.type === "SPLIT" ? input.ratio ?? null : null,
          input.note ?? null, now,
        ]);
        return rows[0] ? mapTransaction(rows[0]) : undefined;
      },
      async delete(userId, id) {
        const { rowCount } = await client.query("DELETE FROM transactions WHERE user_id = $1 AND id = $2", [userId, id]);
        return rowCount > 0;
      },
    },
    alerts: {
      async list(userId, instrumentId) {
        const order = "ORDER BY triggered_at IS NULL ASC, triggered_at DESC, created_at DESC, id DESC";
        const { rows } = instrumentId === undefined
          ? await client.query<PriceAlertRow>(`SELECT * FROM price_alerts WHERE user_id = $1 ${order}`, [userId])
          : await client.query<PriceAlertRow>(`SELECT * FROM price_alerts WHERE user_id = $1 AND instrument_id = $2 ${order}`,
            [userId, instrumentId]);
        return rows.map(mapPriceAlert);
      },
      async get(userId, id) {
        const { rows } = await client.query<PriceAlertRow>("SELECT * FROM price_alerts WHERE user_id = $1 AND id = $2", [userId, id]);
        return rows[0] ? mapPriceAlert(rows[0]) : undefined;
      },
      async count(userId) {
        const { rows } = await client.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM price_alerts WHERE user_id = $1", [userId]);
        return rows[0]!.count;
      },
      async create(userId, input, now) {
        const { rows } = await client.query<PriceAlertRow>(`INSERT INTO price_alerts
          (id, user_id, instrument_id, instrument_json, condition, target_price, currency, note, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`, [
          randomUUID(), userId, input.instrument.id, JSON.stringify(input.instrument), input.condition, input.targetPrice,
          input.instrument.currency, input.note?.trim() || null, now,
        ]);
        return mapPriceAlert(rows[0]!);
      },
      async markTriggered(userId, id, triggeredAt, price) {
        const { rows } = await client.query<PriceAlertRow>(`UPDATE price_alerts SET
          triggered_at = COALESCE(triggered_at, $3),
          triggered_price = CASE WHEN triggered_at IS NULL THEN $4 ELSE triggered_price END
          WHERE user_id = $1 AND id = $2 RETURNING *`, [userId, id, triggeredAt, price]);
        return rows[0] ? mapPriceAlert(rows[0]) : undefined;
      },
      async reactivate(userId, id) {
        const { rows } = await client.query<PriceAlertRow>(`UPDATE price_alerts SET triggered_at = NULL, triggered_price = NULL
          WHERE user_id = $1 AND id = $2 RETURNING *`, [userId, id]);
        return rows[0] ? mapPriceAlert(rows[0]) : undefined;
      },
      async delete(userId, id) {
        const { rowCount } = await client.query("DELETE FROM price_alerts WHERE user_id = $1 AND id = $2", [userId, id]);
        return rowCount > 0;
      },
    },
  };
  return repos;
}

export async function createRepositories(db: Database): Promise<Repositories> {
  await migrateDatabase(db);
  return bindRepositories(db);
}
