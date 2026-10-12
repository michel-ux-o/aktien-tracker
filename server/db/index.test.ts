import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Instrument, PriceAlertInput, TransactionInput } from "../../shared/types";
import { createRepositories, type Database, type Repositories, type SqlClient } from "./index";
import { createTestRepositories } from "./testing";

const now = "2026-10-11T12:00:00.000Z";
const expiresAt = "2026-10-11T13:00:00.000Z";
const instrument: Instrument = {
  id: "SAP:XETR", symbol: "SAP", name: "SAP SE", exchange: "XETRA", mic: "XETR",
  currency: "EUR", country: "Germany", type: "Common Stock",
};
const input: TransactionInput = {
  instrument, type: "BUY", date: "2026-10-09", quantity: 2.5, price: 180, fees: 1.25, currency: "EUR",
};
const alertInput: PriceAlertInput = { instrument, condition: "ABOVE", targetPrice: 200 };

describe("PostgreSQL migrations", () => {
  let db: Database;
  let repos: Repositories;
  let fixture: Awaited<ReturnType<typeof createTestRepositories>>;

  beforeEach(async () => {
    fixture = await createTestRepositories();
    ({ db, repos } = fixture);
  }, 15_000);
  afterEach(async () => { await fixture?.close(); });

  it("creates version 1 and preserves records on repeated startup", async () => {
    expect((await db.query<{ version: number }>("SELECT version FROM schema_migrations")).rows).toEqual([{ version: 1 }]);
    const user = await repos.users.create("current@example.com", "hash", now);
    const transaction = await repos.transactions.create(user.id, input, now);
    const alert = await repos.alerts.create(user.id, alertInput, now);
    await repos.sessions.create(user.id, "session", expiresAt, now);
    await repos.passwordResets.create(user.id, "reset", expiresAt, now);
    await repos.watchlist.add(user.id, instrument, now);
    await repos.settings.update(user.id, { baseCurrency: "CHF", theme: "dark" });

    const again = await createRepositories(db);
    expect(await again.transactions.get(user.id, transaction.id)).toEqual(transaction);
    expect(await again.alerts.get(user.id, alert.id)).toEqual(alert);
    expect(await again.users.findById(user.id)).toEqual(user);
    expect(await again.settings.get(user.id)).toEqual({ baseCurrency: "CHF", theme: "dark" });
    expect(await again.sessions.findValid("session", now)).toMatchObject({ userId: user.id });
    expect(await again.passwordResets.findValid("reset", now)).toMatchObject({ userId: user.id });
    expect(await again.watchlist.list(user.id)).toEqual([{ instrument, addedAt: now }]);
    expect((await db.query<{ version: number }>("SELECT version FROM schema_migrations")).rows).toEqual([{ version: 1 }]);

    const indexes = (await db.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE schemaname = $1", [db.schema],
    )).rows.map(({ indexname }) => indexname);
    expect(indexes).toEqual(expect.arrayContaining([
      "sessions_user_id", "sessions_expires_at", "password_resets_user_id",
      "transactions_user_instrument", "price_alerts_user_instrument",
    ]));
    const columns = (await db.query<{ column_name: string; data_type: string }>(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'transactions'",
      [db.schema],
    )).rows;
    for (const column of ["quantity", "price", "fees", "ratio"]) {
      expect(columns).toContainEqual({ column_name: column, data_type: "double precision" });
    }
    for (const column of ["date", "created_at", "updated_at"]) {
      expect(columns).toContainEqual({ column_name: column, data_type: "text" });
    }
  });

  it("serializes concurrent initialization of a fresh schema", async () => {
    await db.query(`DROP SCHEMA "${db.schema}" CASCADE`);
    await db.query(`CREATE SCHEMA "${db.schema}"`);
    const [first, second] = await Promise.all([createRepositories(db), createRepositories(db)]);
    expect((await db.query<{ version: number }>("SELECT version FROM schema_migrations")).rows).toEqual([{ version: 1 }]);
    const user = await first.users.create("parallel@example.com", "hash", now);
    expect(await second.users.findById(user.id)).toEqual(user);
  });

  it("rolls back a failed migration without changing existing records or its version", async () => {
    const user = await repos.users.create("existing@example.com", "hash", now);
    const transaction = await repos.transactions.create(user.id, input, now);
    await db.query("UPDATE schema_migrations SET version = 0");
    await expect(createRepositories(db)).rejects.toMatchObject({ code: "42P07" });
    expect((await db.query<{ version: number }>("SELECT version FROM schema_migrations")).rows).toEqual([{ version: 0 }]);
    expect(await repos.transactions.get(user.id, transaction.id)).toEqual(transaction);
    await db.query("UPDATE schema_migrations SET version = 1");
    expect(await (await createRepositories(db)).transactions.get(user.id, transaction.id)).toEqual(transaction);
  });

  it("rejects newer databases without changing their version or records", async () => {
    const user = await repos.users.create("newer@example.com", "hash", now);
    await db.query("UPDATE schema_migrations SET version = 2");
    await expect(createRepositories(db)).rejects.toThrow("neueren Serverversion");
    expect((await db.query<{ version: number }>("SELECT version FROM schema_migrations")).rows).toEqual([{ version: 2 }]);
    expect(await repos.users.findById(user.id)).toEqual(user);
  });

  it("uses independent fresh schemas and removes only the closed test schema", async () => {
    const [other, third] = await Promise.all([createTestRepositories(), createTestRepositories()]);
    try {
      expect(other.db.schema).not.toBe(db.schema);
      expect(third.db.schema).not.toBe(other.db.schema);
      const user = await repos.users.create("same@example.com", "hash", now);
      expect(await other.repos.users.findByEmail(user.email)).toBeUndefined();
      const [otherUser, thirdUser] = await Promise.all([
        other.repos.users.create(user.email, "other-hash", now),
        third.repos.users.create(user.email, "third-hash", now),
      ]);
      expect(await other.repos.users.findById(thirdUser.id)).toBeUndefined();
      expect(await third.repos.users.findById(otherUser.id)).toBeUndefined();
      await other.close();
      expect((await db.query("SELECT 1 FROM pg_namespace WHERE nspname = $1", [other.db.schema])).rows).toEqual([]);
      expect(await repos.users.findById(user.id)).toEqual(user);
      expect(await third.repos.users.findByEmail(user.email)).toEqual(thirdUser);
    } finally {
      await Promise.all([other.close(), third.close()]);
    }
  });
});

describe("PostgreSQL repositories", () => {
  let db: Database;
  let repos: Repositories;
  let fixture: Awaited<ReturnType<typeof createTestRepositories>>;
  let userA: string;
  let userB: string;

  beforeEach(async () => {
    fixture = await createTestRepositories();
    ({ db, repos } = fixture);
    userA = (await repos.users.create("a@example.com", "hash-a", now)).id;
    userB = (await repos.users.create("b@example.com", "hash-b", now)).id;
  }, 15_000);
  afterEach(async () => { await fixture?.close(); });

  it("stores fractional amounts and instrument snapshots with asynchronous reads", async () => {
    const transaction = await repos.transactions.create(userA, input, now);
    const again = await createRepositories(db);
    expect(await again.transactions.get(userA, transaction.id)).toEqual({
      ...input, id: transaction.id, instrumentId: instrument.id, ratio: null, note: null, createdAt: now, updatedAt: now,
    });
    expect(await repos.users.findByEmail("A@EXAMPLE.COM")).toMatchObject({ id: userA });
    expect(await repos.users.findById("unknown")).toBeUndefined();
    expect(await repos.users.updatePassword("unknown", "new-hash")).toBe(false);
  });

  it("normalizes email and enforces case-insensitive uniqueness in the database", async () => {
    const user = await repos.users.create("  Mixed@Example.COM  ", "hash", now);
    expect(user.email).toBe("mixed@example.com");
    expect(await repos.users.findByEmail("MIXED@EXAMPLE.COM")).toEqual(user);
    await expect(repos.users.create("MIXED@example.com", "another-hash", now)).rejects.toMatchObject({ code: "23505" });
    await expect(db.query(
      "INSERT INTO users (id, email, password_hash, created_at) VALUES ($1, $2, $3, $4)",
      ["case-duplicate", "MiXeD@EXAMPLE.COM", "hash", now],
    )).rejects.toMatchObject({ code: "23505" });
    expect(await repos.users.findById("case-duplicate")).toBeUndefined();
    expect(await repos.settings.get(user.id)).toEqual({ baseCurrency: "EUR", theme: "system" });
  });

  it("rolls back users.create when creating its default settings fails", async () => {
    await db.query(`CREATE FUNCTION reject_settings() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'settings unavailable'; END;
    $$`);
    await db.query("CREATE TRIGGER reject_settings BEFORE INSERT ON settings FOR EACH ROW EXECUTE FUNCTION reject_settings()");
    await expect(repos.users.create("rollback@example.com", "hash", now)).rejects.toThrow("settings unavailable");
    expect(await repos.users.findByEmail("rollback@example.com")).toBeUndefined();
    expect((await db.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM users")).rows).toEqual([{ count: 2 }]);
  });

  it("scopes all portfolio, watchlist and settings records to their owner", async () => {
    const transaction = await repos.transactions.create(userA, input, now);
    await repos.watchlist.add(userA, instrument, now);
    await repos.settings.update(userA, { baseCurrency: "USD", theme: "dark" });
    expect(await repos.transactions.list(userB)).toEqual([]);
    expect(await repos.transactions.list(userB, instrument.id)).toEqual([]);
    expect(await repos.transactions.get(userB, transaction.id)).toBeUndefined();
    expect(await repos.transactions.update(userB, transaction.id, { ...input, quantity: 99 }, now)).toBeUndefined();
    expect(await repos.transactions.delete(userB, transaction.id)).toBe(false);
    expect(await repos.watchlist.list(userB)).toEqual([]);
    expect(await repos.watchlist.delete(userB, instrument.id)).toBe(false);
    expect(await repos.settings.get(userB)).toEqual({ baseCurrency: "EUR", theme: "system" });
    await repos.settings.update(userB, { theme: "light" });
    expect(await repos.settings.get(userA)).toEqual({ baseCurrency: "USD", theme: "dark" });
    expect(await repos.transactions.get(userA, transaction.id)).toMatchObject({ quantity: input.quantity });
    expect(await repos.watchlist.list(userA)).toHaveLength(1);
    expect(await repos.users.updatePassword(userB, "new-b-hash")).toBe(true);
    expect(await repos.users.findById(userA)).toMatchObject({ passwordHash: "hash-a" });
    expect(await repos.users.findById(userB)).toMatchObject({ passwordHash: "new-b-hash" });
  });

  it("enforces idempotency per user and keeps the original watchlist snapshot", async () => {
    const requestId = "70f8270b-efea-4b6c-a8c5-7984be6bb1d1";
    const transaction = await repos.transactions.create(userA, { ...input, clientRequestId: requestId }, now);
    expect(await repos.transactions.findByClientRequestId(userB, requestId)).toBeUndefined();
    await expect(repos.transactions.create(userA, { ...input, clientRequestId: requestId }, now))
      .rejects.toMatchObject({ code: "23505" });
    expect((await repos.transactions.create(userB, { ...input, clientRequestId: requestId }, now)).id).not.toBe(transaction.id);
    expect((await repos.watchlist.add(userA, instrument, now)).created).toBe(true);
    expect(await repos.watchlist.add(userA, { ...instrument, name: "Changed name" }, "2026-10-12T00:00:00.000Z"))
      .toEqual({ created: false, item: { instrument, addedAt: now } });
    await expect(db.query(
      "INSERT INTO watchlist (user_id, instrument_id, instrument_json, added_at) VALUES ($1, $2, $3, $4)",
      [userA, instrument.id, JSON.stringify(instrument), now],
    )).rejects.toMatchObject({ code: "23505" });
    expect((await repos.watchlist.add(userB, instrument, now)).created).toBe(true);
    expect(await repos.watchlist.delete(userB, instrument.id)).toBe(true);
    expect(await repos.watchlist.list(userA)).toEqual([{ instrument, addedAt: now }]);
  });

  it("adds the same watchlist instrument concurrently only once", async () => {
    const results = await Promise.all([
      repos.watchlist.add(userA, instrument, now),
      repos.watchlist.add(userA, { ...instrument, name: "Later snapshot" }, "2026-10-12T00:00:00.000Z"),
    ]);
    expect(results.filter(({ created }) => created)).toHaveLength(1);
    expect(results[0]?.item).toEqual(results[1]?.item);
    expect(await repos.watchlist.list(userA)).toEqual([results[0]!.item]);
  });

  it("preserves both fields during concurrent partial settings updates", async () => {
    await Promise.all([
      repos.settings.update(userA, { baseCurrency: "USD" }),
      repos.settings.update(userA, { theme: "dark" }),
    ]);
    expect(await repos.settings.get(userA)).toEqual({ baseCurrency: "USD", theme: "dark" });
    expect(await repos.settings.update(userA, {})).toEqual({ baseCurrency: "USD", theme: "dark" });
    expect(await repos.settings.get(userB)).toEqual({ baseCurrency: "EUR", theme: "system" });
  });

  it("round-trips splits and dividends and clears ratio when changing transaction type", async () => {
    const splitInput: TransactionInput = { ...input, type: "SPLIT", quantity: 0, price: 0, fees: 0, ratio: 4 };
    const split = await repos.transactions.create(userA, splitInput, now);
    expect(split).toMatchObject({ type: "SPLIT", quantity: 0, price: 0, fees: 0, ratio: 4 });
    expect(await repos.transactions.list(userA, instrument.id)).toEqual([split]);
    const updatedAt = "2026-10-12T12:00:00.000Z";
    expect(await repos.transactions.update(userA, split.id, { ...splitInput, ratio: 0.1 }, updatedAt))
      .toMatchObject({ ratio: 0.1, createdAt: now, updatedAt });
    expect(await repos.transactions.update(userA, split.id, { ...input, type: "DIVIDEND", price: 2, ratio: 4 }, updatedAt))
      .toMatchObject({ type: "DIVIDEND", price: 2, ratio: null });
    const buy = await repos.transactions.create(userA, { ...input, ratio: 4 }, now);
    expect(buy.ratio).toBeNull();
    expect(await repos.transactions.update(userA, buy.id, splitInput, updatedAt)).toMatchObject({ ratio: 4 });
    expect(await repos.transactions.update(userB, buy.id, { ...splitInput, ratio: 10 }, updatedAt)).toBeUndefined();
    expect(await repos.transactions.get(userA, buy.id)).toMatchObject({ ratio: 4 });
  });

  it("enforces transaction checks for invalid amounts, types and split ratios", async () => {
    for (const field of ["quantity", "price", "fees"] as const) {
      await expect(repos.transactions.create(userA, { ...input, [field]: -1 }, now)).rejects.toMatchObject({ code: "23514" });
    }
    const splitInput: TransactionInput = { ...input, type: "SPLIT", quantity: 0, price: 0, fees: 0 };
    for (const ratio of [undefined, null, 0, -1]) {
      await expect(repos.transactions.create(userA, { ...splitInput, ratio }, now)).rejects.toMatchObject({ code: "23514" });
    }
    const transaction = await repos.transactions.create(userA, input, now);
    await expect(db.query("UPDATE transactions SET type = 'INVALID' WHERE id = $1", [transaction.id]))
      .rejects.toMatchObject({ code: "23514" });
    await expect(db.query("UPDATE transactions SET ratio = 2 WHERE id = $1", [transaction.id]))
      .rejects.toMatchObject({ code: "23514" });
    await expect(repos.transactions.update(userA, transaction.id, splitInput, now)).rejects.toMatchObject({ code: "23514" });
    expect(await repos.transactions.get(userA, transaction.id)).toEqual(transaction);
    expect(await repos.transactions.create(userA, { ...input, quantity: 0, price: 0, fees: 0 }, now))
      .toMatchObject({ quantity: 0, price: 0, fees: 0, ratio: null });
  });

  it("lists transactions descending by date, creation time and id", async () => {
    const first = await repos.transactions.create(userA, { ...input, date: "2026-10-08" }, now);
    const second = await repos.transactions.create(userA, input, now);
    const third = await repos.transactions.create(userA, input, "2026-10-12T12:00:00.000Z");
    const fourth = await repos.transactions.create(userA, input, "2026-10-12T12:00:00.000Z");
    const latest = [third, fourth].sort((a, b) => b.id.localeCompare(a.id));
    expect(await repos.transactions.list(userA)).toEqual([...latest, second, first]);
  });

  it("lists import rows by literal prefix and numerical row index only for their owner", async () => {
    const prefix = "import_%'\\:";
    const rows = [];
    for (const index of [10, 2, 0, 100, 1]) {
      rows.push({ index, transaction: await repos.transactions.create(userA, { ...input, clientRequestId: `${prefix}${index}` }, now) });
    }
    await repos.transactions.create(userB, { ...input, clientRequestId: `${prefix}3` }, now);
    for (const clientRequestId of [
      "import-other:0", "importxwildcard:0", `${prefix.replace("_%", "XX")}3`, `${prefix.slice(0, -1)}-other:0`,
    ]) {
      await repos.transactions.create(userA, { ...input, clientRequestId }, now);
    }
    await repos.transactions.create(userA, input, now);
    expect(await repos.transactions.listByClientRequestIdPrefix(userA, prefix))
      .toEqual(rows.sort((a, b) => a.index - b.index).map(({ transaction }) => transaction));
    expect(await repos.transactions.listByClientRequestIdPrefix(userB, prefix)).toHaveLength(1);
    expect(await repos.transactions.listByClientRequestIdPrefix(userA, "missing:")).toEqual([]);
    expect(await repos.transactions.listByClientRequestIdPrefix(userA, "%' OR 1 = 1 --")).toEqual([]);
  });

  it("stores alarm snapshots, instrument currency and trimmed optional notes without quotes", async () => {
    const alert = await repos.alerts.create(userA, { ...alertInput, note: "  Ziel erreicht  " }, now);
    expect(alert).toEqual({
      id: alert.id, instrumentId: instrument.id, instrument, condition: "ABOVE", targetPrice: 200,
      currency: "EUR", note: "Ziel erreicht", createdAt: now, triggeredAt: null, triggeredPrice: null,
    });
    expect(alert).not.toHaveProperty("quote");
    expect(await repos.alerts.get(userA, alert.id)).toEqual(alert);
    for (const note of [undefined, null, "  "]) {
      expect((await repos.alerts.create(userA, { ...alertInput, note }, now)).note).toBeNull();
    }
    const usdInstrument = { ...instrument, id: "SAP:XNYS", currency: "USD", mic: "XNYS" };
    expect((await repos.alerts.create(userA, { ...alertInput, instrument: usdInstrument }, now)).currency).toBe("USD");
    expect(await repos.alerts.list(userA, instrument.id)).toHaveLength(4);
    expect(await repos.alerts.count(userA)).toBe(5);
  });

  it("strictly scopes every alarm operation to the owning user", async () => {
    const alert = await repos.alerts.create(userA, alertInput, now);
    expect(await repos.alerts.list(userB)).toEqual([]);
    expect(await repos.alerts.list(userB, instrument.id)).toEqual([]);
    expect(await repos.alerts.count(userB)).toBe(0);
    expect(await repos.alerts.get(userB, alert.id)).toBeUndefined();
    expect(await repos.alerts.markTriggered(userB, alert.id, now, 210)).toBeUndefined();
    expect(await repos.alerts.reactivate(userB, alert.id)).toBeUndefined();
    expect(await repos.alerts.delete(userB, alert.id)).toBe(false);
    expect(await repos.alerts.get(userA, alert.id)).toEqual(alert);
    const otherAlert = await repos.alerts.create(userB, { ...alertInput, condition: "BELOW" }, now);
    expect(await repos.alerts.list(userB, instrument.id)).toEqual([otherAlert]);
    expect(await repos.alerts.count(userA)).toBe(1);
    expect(await repos.alerts.count(userB)).toBe(1);
    const triggered = await repos.alerts.markTriggered(userA, alert.id, now, 210);
    expect(triggered).toMatchObject({ triggeredAt: now, triggeredPrice: 210 });
    expect(await repos.alerts.reactivate(userB, alert.id)).toBeUndefined();
    expect(await repos.alerts.get(userA, alert.id)).toEqual(triggered);
    expect(await repos.alerts.get(userA, "unknown")).toBeUndefined();
    expect(await repos.alerts.markTriggered(userA, "unknown", now, 210)).toBeUndefined();
    expect(await repos.alerts.reactivate(userA, "unknown")).toBeUndefined();
    expect(await repos.alerts.delete(userA, "unknown")).toBe(false);
    expect(await repos.alerts.delete(userA, alert.id)).toBe(true);
    expect(await repos.alerts.count(userA)).toBe(0);
    expect(await repos.alerts.get(userB, otherAlert.id)).toEqual(otherAlert);
  });

  it("retains the first trigger until reactivation and sorts triggered alarms before active ones", async () => {
    const first = await repos.alerts.create(userA, alertInput, now);
    const second = await repos.alerts.create(userA, alertInput, "2026-10-12T10:00:00.000Z");
    const active = await repos.alerts.create(userA, alertInput, "2026-10-12T11:00:00.000Z");
    await repos.alerts.markTriggered(userA, first.id, "2026-10-12T08:00:00.000Z", 201);
    const triggered = await repos.alerts.markTriggered(userA, second.id, "2026-10-12T09:00:00.000Z", 202);
    expect(await repos.alerts.markTriggered(userA, second.id, "2026-10-12T12:00:00.000Z", 220)).toEqual(triggered);
    expect((await repos.alerts.list(userA)).map(({ id }) => id)).toEqual([second.id, first.id, active.id]);
    expect(await repos.alerts.reactivate(userA, second.id)).toEqual(second);
    expect((await repos.alerts.list(userA)).map(({ id }) => id)).toEqual([first.id, active.id, second.id]);
    expect(await repos.alerts.markTriggered(userA, second.id, "2026-10-12T12:00:00.000Z", 220))
      .toMatchObject({ triggeredAt: "2026-10-12T12:00:00.000Z", triggeredPrice: 220 });
  });

  it("enforces alarm and settings checks", async () => {
    for (const targetPrice of [0, -1]) {
      await expect(repos.alerts.create(userA, { ...alertInput, targetPrice }, now)).rejects.toMatchObject({ code: "23514" });
    }
    const alert = await repos.alerts.create(userA, alertInput, now);
    await expect(db.query("UPDATE price_alerts SET condition = 'INVALID' WHERE id = $1", [alert.id]))
      .rejects.toMatchObject({ code: "23514" });
    await expect(repos.settings.update(userA, { baseCurrency: "INVALID" })).rejects.toMatchObject({ code: "23514" });
    await expect(db.query("UPDATE settings SET theme = 'INVALID' WHERE user_id = $1", [userA]))
      .rejects.toMatchObject({ code: "23514" });
    expect(await repos.settings.get(userA)).toEqual({ baseCurrency: "EUR", theme: "system" });
    expect(await repos.alerts.get(userA, alert.id)).toEqual(alert);
  });

  it("rejects unknown owners through foreign keys in every dependent repository", async () => {
    const operations = [
      () => repos.sessions.create("unknown", "session", expiresAt, now),
      () => repos.passwordResets.create("unknown", "reset", expiresAt, now),
      () => repos.settings.update("unknown", { theme: "dark" }),
      () => repos.watchlist.add("unknown", instrument, now),
      () => repos.transactions.create("unknown", input, now),
      () => repos.alerts.create("unknown", alertInput, now),
    ];
    for (const operation of operations) {
      await expect(operation()).rejects.toMatchObject({ code: "23503" });
    }
  });

  it("cascades deletion through every dependent table only for the deleted owner", async () => {
    for (const userId of [userA, userB]) {
      await repos.sessions.create(userId, `session-${userId}`, expiresAt, now);
      await repos.passwordResets.create(userId, `reset-${userId}`, expiresAt, now);
      await repos.watchlist.add(userId, instrument, now);
      await repos.transactions.create(userId, input, now);
      await repos.alerts.create(userId, alertInput, now);
    }
    await db.query("DELETE FROM users WHERE id = $1", [userA]);
    expect(await repos.users.findById(userA)).toBeUndefined();
    expect(await repos.sessions.findValid(`session-${userA}`, now)).toBeUndefined();
    expect(await repos.passwordResets.findValid(`reset-${userA}`, now)).toBeUndefined();
    expect(await repos.watchlist.list(userA)).toEqual([]);
    expect(await repos.transactions.list(userA)).toEqual([]);
    expect(await repos.alerts.list(userA)).toEqual([]);
    for (const table of ["settings", "sessions", "password_resets", "watchlist", "transactions", "price_alerts"]) {
      expect((await db.query<{ user_id: string }>(`SELECT user_id FROM ${table}`)).rows).toEqual([{ user_id: userB }]);
    }
    expect(await repos.sessions.findValid(`session-${userB}`, now)).toMatchObject({ userId: userB });
    expect(await repos.passwordResets.findValid(`reset-${userB}`, now)).toMatchObject({ userId: userB });
  });

  it("rolls back transaction-bound operations when sequence validation or reset confirmation throws", async () => {
    await expect(repos.atomic(async (tx) => {
      await tx.transactions.create(userA, input, now);
      await tx.settings.update(userA, { theme: "dark" });
      await tx.watchlist.add(userA, instrument, now);
      await tx.alerts.create(userA, alertInput, now);
      await tx.users.create("temporary@example.com", "hash", now);
      throw new Error("conflict");
    })).rejects.toThrow("conflict");
    expect(await repos.transactions.list(userA)).toEqual([]);
    expect((await repos.settings.get(userA)).theme).toBe("system");
    expect(await repos.watchlist.list(userA)).toEqual([]);
    expect(await repos.alerts.list(userA)).toEqual([]);
    expect(await repos.users.findByEmail("temporary@example.com")).toBeUndefined();

    await expect(repos.atomic(async (tx) => {
      await tx.transactions.create(userA, input, now);
      await tx.transactions.create(userA, { ...input, quantity: -1 }, now);
    })).rejects.toMatchObject({ code: "23514" });
    expect(await repos.transactions.list(userA)).toEqual([]);

    await repos.passwordResets.create(userA, "reset-hash", expiresAt, now);
    await expect(repos.atomic(async (tx) => {
      await tx.passwordResets.consume("reset-hash");
      await tx.users.updatePassword(userA, "new-hash");
      throw new Error("cancelled");
    })).rejects.toThrow("cancelled");
    expect(await repos.users.findById(userA)).toMatchObject({ passwordHash: "hash-a" });
    expect(await repos.passwordResets.findValid("reset-hash", now)).toMatchObject({ userId: userA });
  });

  it("runs nested atomic callbacks in the existing transaction", async () => {
    const result = await repos.atomic(async (tx) => {
      await tx.settings.update(userA, { theme: "dark" });
      return tx.atomic(async (nested) => {
        expect((await nested.settings.get(userA)).theme).toBe("dark");
        await nested.watchlist.add(userA, instrument, now);
        return "committed";
      }, { lockKey: userA });
    }, { lockKey: userA });
    expect(result).toBe("committed");
    expect(await repos.watchlist.list(userA)).toEqual([{ instrument, addedAt: now }]);

    await expect(repos.atomic(async (tx) => {
      await tx.settings.update(userA, { baseCurrency: "USD" });
      await tx.atomic(async (nested) => {
        await nested.transactions.create(userA, input, now);
        throw new Error("nested failure");
      });
    })).rejects.toThrow("nested failure");
    expect(await repos.settings.get(userA)).toEqual({ baseCurrency: "EUR", theme: "dark" });
    expect(await repos.transactions.list(userA)).toEqual([]);
  });

  it("serializes parallel atomic sections with the same lockKey", async () => {
    const events: string[] = [];
    const statements: { text: string; params?: unknown[] }[] = [];
    const originalTransaction = db.transaction.bind(db);
    const transactionSpy = vi.spyOn(db, "transaction").mockImplementation(
      async <T>(operation: (tx: SqlClient) => Promise<T>): Promise<T> => originalTransaction(async (tx) => operation({
        async query<Row = Record<string, unknown>>(text: string, params?: unknown[]) {
          statements.push({ text, params });
          return tx.query<Row>(text, params);
        },
      })),
    );
    let releaseFirst!: () => void;
    let markEntered!: () => void;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const first = repos.atomic(async (tx) => {
      events.push("first:start");
      expect(statements.at(-1)).toEqual({ text: "SELECT pg_advisory_xact_lock(hashtext($1))", params: [userA] });
      markEntered();
      await gate;
      await tx.settings.update(userA, { theme: "dark" });
      events.push("first:end");
    }, { lockKey: userA });
    await entered;
    const second = repos.atomic(async (tx) => {
      events.push("second:start");
      expect(statements.at(-1)).toEqual({ text: "SELECT pg_advisory_xact_lock(hashtext($1))", params: [userA] });
      expect((await tx.settings.get(userA)).theme).toBe("dark");
      await tx.settings.update(userA, { baseCurrency: "USD" });
      events.push("second:end");
    }, { lockKey: userA });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const eventsBeforeRelease = [...events];
    releaseFirst();
    try {
      await Promise.all([first, second]);
    } finally {
      transactionSpy.mockRestore();
    }
    expect(eventsBeforeRelease).toEqual(["first:start"]);
    expect(events).toEqual(["first:start", "first:end", "second:start", "second:end"]);
    expect(statements.filter(({ text }) => text.includes("pg_advisory_xact_lock"))).toEqual([
      { text: "SELECT pg_advisory_xact_lock(hashtext($1))", params: [userA] },
      { text: "SELECT pg_advisory_xact_lock(hashtext($1))", params: [userA] },
    ]);
    expect(await repos.settings.get(userA)).toEqual({ baseCurrency: "USD", theme: "dark" });
  });

  it("expires tokens exactly at expiry and consumes only the specified password reset once", async () => {
    await repos.sessions.create(userA, "session-hash-a", expiresAt, now);
    await repos.sessions.create(userB, "session-hash-b", expiresAt, now);
    await repos.passwordResets.create(userA, "reset-hash-a", expiresAt, now);
    await repos.passwordResets.create(userB, "reset-hash-b", expiresAt, now);
    expect(await repos.sessions.findValid("session-hash-a", now)).toMatchObject({ userId: userA });
    expect(await repos.sessions.findValid("session-hash-b", now)).toMatchObject({ userId: userB });
    expect(await repos.sessions.findValid("session-hash-a", expiresAt)).toBeUndefined();
    expect(await repos.passwordResets.findValid("reset-hash-a", expiresAt)).toBeUndefined();
    expect(await repos.passwordResets.consume("reset-hash-a")).toBe(true);
    expect(await repos.passwordResets.consume("reset-hash-a")).toBe(false);
    expect(await repos.passwordResets.findValid("reset-hash-b", now)).toMatchObject({ userId: userB });
    expect(await repos.sessions.delete("unknown")).toBe(false);
    await repos.sessions.deleteForUser(userA);
    expect(await repos.sessions.findValid("session-hash-a", now)).toBeUndefined();
    expect(await repos.sessions.findValid("session-hash-b", now)).toMatchObject({ userId: userB });
    expect(await repos.sessions.delete("session-hash-b")).toBe(true);
    expect(await repos.sessions.delete("session-hash-b")).toBe(false);
  });
});
