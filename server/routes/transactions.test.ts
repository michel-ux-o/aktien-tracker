import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_IMPORT_TRANSACTIONS } from "../../shared/api";
import type { Instrument, TransactionInput } from "../../shared/types";
import type { Repositories } from "../db";
import { createTestRepositories } from "../db/testing";
import { errorHandler } from "../errors";
import { createTransactionsRouter } from "./transactions";

const timestamp = "2026-10-11T12:00:00.000Z";
const instrument: Instrument = {
  id: "SAP:XETR", symbol: "SAP", name: "SAP SE", exchange: "XETRA", mic: "XETR",
  currency: "EUR", country: "Germany", type: "Common Stock",
};
const secondInstrument: Instrument = { ...instrument, id: "SIE:XETR", symbol: "SIE", name: "Siemens AG" };
const buy: TransactionInput = {
  instrument, type: "BUY", date: "2026-10-05", quantity: 10, price: 180, fees: 1.25, currency: "EUR",
};
const sell: TransactionInput = { ...buy, type: "SELL", date: "2026-10-06", quantity: 6 };
const dividend: TransactionInput = { ...buy, type: "DIVIDEND", date: "2026-10-07", price: 2, fees: 1 };
const split: TransactionInput = { ...buy, type: "SPLIT", date: "2026-10-06", ratio: 2, quantity: 0, price: 0, fees: 0 };

describe("transaction routes", () => {
  let close: () => Promise<void>;
  let repos: Repositories;
  let app: express.Express;
  let userA: string;
  let userB: string;

  beforeEach(async () => {
    ({ repos, close } = await createTestRepositories());
    userA = (await repos.users.create("a@example.com", "hash-a", timestamp)).id;
    userB = (await repos.users.create("b@example.com", "hash-b", timestamp)).id;
    app = express();
    app.use(express.json({ limit: "2mb" }));
    // Authentication/CSRF are covered by app tests. This harness isolates mutation validation.
    app.use((req, res, next) => {
      res.locals.userId = req.get("Test-User") ?? userA;
      next();
    });
    app.use("/api/transactions", createTransactionsRouter({ repos, now: () => new Date(timestamp) }));
    app.use(errorHandler);
  });
  afterEach(async () => { await close(); });

  it("creates, lists in reverse date order, updates and deletes own transactions", async () => {
    const first = await request(app).post("/api/transactions").send(buy).expect(201);
    const second = await request(app).post("/api/transactions").send({ ...buy, date: "2026-10-07" }).expect(201);
    const listed = await request(app).get("/api/transactions").expect(200);
    expect(listed.body.transactions.map((transaction: { id: string }) => transaction.id)).toEqual([second.body.id, first.body.id]);
    const updated = await request(app).put(`/api/transactions/${first.body.id}`).send({ ...buy, quantity: 12.5 }).expect(200);
    expect(updated.body.quantity).toBe(12.5);
    expect(updated.body.createdAt).toBe(timestamp);
    await request(app).delete(`/api/transactions/${first.body.id}`).expect(204);
    expect(await repos.transactions.get(userA, first.body.id)).toBeUndefined();
  });

  it("returns field errors for invalid input and future dates", async () => {
    const result = await request(app).post("/api/transactions").send({ ...buy, quantity: 0, date: "2026-10-13" }).expect(400);
    expect(result.body.error.code).toBe("VALIDATION_ERROR");
    expect(result.body.error.fields.quantity).toBeTruthy();
    expect(result.body.error.fields.date).toBeTruthy();
    expect(await repos.transactions.list(userA)).toEqual([]);
  });

  it("accepts the local date of time zones ahead of UTC", async () => {
    // 12:00 UTC am 11.10. ist in UTC+14 bereits der 12.10.
    await request(app).post("/api/transactions").send({ ...buy, date: "2026-10-12" }).expect(201);
  });

  it("rejects sales exceeding stock and leaves the database unchanged", async () => {
    await request(app).post("/api/transactions").send(buy).expect(201);
    const result = await request(app).post("/api/transactions").send({ ...sell, quantity: 11 }).expect(409);
    expect(result.body.error.code).toBe("CONFLICT");
    expect(result.body.error.fields.quantity).toBeTruthy();
    expect(await repos.transactions.list(userA)).toHaveLength(1);
    await request(app).post("/api/transactions").send(sell).expect(201);
    expect(await repos.transactions.list(userA)).toHaveLength(2);
  });

  it("serializes concurrent sales so their combined quantity cannot exceed stock", async () => {
    await request(app).post("/api/transactions").send(buy).expect(201);
    const results = await Promise.all([
      request(app).post("/api/transactions").send(sell),
      request(app).post("/api/transactions").send(sell),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    expect(results.find((result) => result.status === 409)?.body.error.code).toBe("CONFLICT");
    const transactions = await repos.transactions.list(userA);
    expect(transactions).toHaveLength(2);
    expect(transactions.filter((transaction) => transaction.type === "SELL")).toHaveLength(1);
  });

  it("rejects deleting or reducing a buy needed by a later sale", async () => {
    const first = await request(app).post("/api/transactions").send(buy).expect(201);
    await request(app).post("/api/transactions").send(sell).expect(201);
    await request(app).delete(`/api/transactions/${first.body.id}`).expect(409);
    await request(app).put(`/api/transactions/${first.body.id}`).send({ ...buy, quantity: 5 }).expect(409);
    expect((await repos.transactions.get(userA, first.body.id))?.quantity).toBe(10);
    expect(await repos.transactions.list(userA)).toHaveLength(2);
  });

  it("checks both old and new instrument sequences on an instrument change", async () => {
    const first = await request(app).post("/api/transactions").send(buy).expect(201);
    const sale = await request(app).post("/api/transactions").send(sell).expect(201);
    await request(app).put(`/api/transactions/${first.body.id}`).send({ ...buy, instrument: secondInstrument }).expect(409);
    await request(app).put(`/api/transactions/${sale.body.id}`).send({ ...sell, instrument: secondInstrument }).expect(409);
    expect((await repos.transactions.get(userA, first.body.id))?.instrumentId).toBe(instrument.id);
    expect((await repos.transactions.get(userA, sale.body.id))?.instrumentId).toBe(instrument.id);
  });

  it("replays a clientRequestId only for its owner and validates UUIDs", async () => {
    const input = { ...buy, clientRequestId: "d893c5bf-32bd-4b22-a59c-4e7c6630019c" };
    const first = await request(app).post("/api/transactions").send(input).expect(201);
    const replay = await request(app).post("/api/transactions").send({ ...input, quantity: 99 }).expect(200);
    expect(replay.body).toEqual(first.body);
    expect(await repos.transactions.list(userA)).toHaveLength(1);
    await request(app).post("/api/transactions").set("Test-User", userB).send(input).expect(201);
    expect(await repos.transactions.list(userB)).toHaveLength(1);
    const invalid = await request(app).post("/api/transactions").send({ ...buy, clientRequestId: "invalid" }).expect(400);
    expect(invalid.body.error.fields.clientRequestId).toBeTruthy();
  });

  it("creates exactly one transaction for simultaneous requests with the same clientRequestId", async () => {
    const input = { ...buy, clientRequestId: randomUUID() };
    const results = await Promise.all([
      request(app).post("/api/transactions").send(input),
      request(app).post("/api/transactions").send(input),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 201]);
    expect(results[0]!.body).toEqual(results[1]!.body);
    expect(await repos.transactions.list(userA)).toEqual([results[0]!.body]);
  });

  it("replays a committed transaction after a PostgreSQL unique violation", async () => {
    const input = { ...buy, clientRequestId: randomUUID() };
    const existing = await repos.transactions.create(userA, input, timestamp);
    vi.spyOn(repos, "atomic").mockRejectedValueOnce({ code: "23505" });
    const response = await request(app).post("/api/transactions").send(input).expect(200);
    expect(response.body).toEqual(existing);
    expect(await repos.transactions.list(userA)).toEqual([existing]);
  });

  it("forwards database failures without exposing their details", async () => {
    const input = { ...buy, clientRequestId: randomUUID() };
    await repos.transactions.create(userA, input, timestamp);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      for (const code of ["08006", "23505"]) {
        vi.spyOn(repos, "atomic").mockRejectedValueOnce({ code, detail: "Internal database credentials" });
        const response = await request(app).post("/api/transactions")
          .send({ ...input, clientRequestId: code === "23505" ? randomUUID() : input.clientRequestId }).expect(500);
        expect(response.body.error.code).toBe("INTERNAL_ERROR");
        expect(JSON.stringify(response.body)).not.toContain("Internal database credentials");
      }
    } finally {
      log.mockRestore();
    }
  });

  it("exposes no foreign transaction and ignores client supplied user IDs", async () => {
    const foreign = await repos.transactions.create(userA, buy, timestamp);
    const listed = await request(app).get(`/api/transactions?instrumentId=${encodeURIComponent(instrument.id)}&userId=${userA}`)
      .set("Test-User", userB).expect(200);
    expect(listed.body.transactions).toEqual([]);
    await request(app).put(`/api/transactions/${foreign.id}`).set("Test-User", userB).send(buy).expect(404);
    await request(app).delete(`/api/transactions/${foreign.id}`).set("Test-User", userB).expect(404);
    const own = await request(app).post("/api/transactions").set("Test-User", userB).send({ ...buy, userId: userA }).expect(201);
    expect(await repos.transactions.get(userA, own.body.id)).toBeUndefined();
    expect(await repos.transactions.get(userA, foreign.id)).toBeDefined();
  });

  it("includes transactions before and after an inserted date in validation", async () => {
    await request(app).post("/api/transactions").send(buy).expect(201);
    await request(app).post("/api/transactions").send(sell).expect(201);
    // Today's positive balance cannot cover a sale preceding the first purchase.
    await request(app).post("/api/transactions").send({ ...sell, date: "2026-10-04", quantity: 1 }).expect(409);
    expect(await repos.transactions.list(userA)).toHaveLength(2);
  });

  it("creates, edits and deletes dividends and preserves sequence validation", async () => {
    await request(app).post("/api/transactions").send(dividend).expect(409);
    const purchase = await request(app).post("/api/transactions").send(buy).expect(201);
    const created = await request(app).post("/api/transactions").send(dividend).expect(201);
    expect(created.body).toMatchObject({ type: "DIVIDEND", ratio: null, quantity: 10, price: 2, fees: 1 });
    const updated = await request(app).put(`/api/transactions/${created.body.id}`).send({ ...dividend, price: 3, note: "Gutschrift" }).expect(200);
    expect(updated.body).toMatchObject({ price: 3, note: "Gutschrift" });
    await request(app).put(`/api/transactions/${created.body.id}`).send({ ...dividend, date: "2026-10-04" }).expect(409);
    await request(app).delete(`/api/transactions/${purchase.body.id}`).expect(409);
    await request(app).delete(`/api/transactions/${created.body.id}`).expect(204);
    await request(app).delete(`/api/transactions/${purchase.body.id}`).expect(204);
    expect(await repos.transactions.list(userA)).toEqual([]);
  });

  it("rejects dividend deductions above the gross amount", async () => {
    const response = await request(app).post("/api/transactions").send({ ...dividend, fees: 21 }).expect(400);
    expect(response.body.error.fields.fees).toBeTruthy();
    expect(await repos.transactions.list(userA)).toEqual([]);
  });

  it("creates, normalizes, edits and deletes splits", async () => {
    await request(app).post("/api/transactions").send(buy).expect(201);
    const created = await request(app).post("/api/transactions").send({ ...split, quantity: 99, price: 50, fees: 20 }).expect(201);
    expect(created.body).toMatchObject({ type: "SPLIT", ratio: 2, quantity: 0, price: 0, fees: 0 });
    const updated = await request(app).put(`/api/transactions/${created.body.id}`).send({ ...split, ratio: 0.5 }).expect(200);
    expect(updated.body.ratio).toBe(0.5);
    const invalid = await request(app).put(`/api/transactions/${created.body.id}`).send({ ...split, ratio: 1 }).expect(400);
    expect(invalid.body.error.fields.ratio).toBeTruthy();
    await request(app).delete(`/api/transactions/${created.body.id}`).expect(204);
    expect(await repos.transactions.list(userA)).toHaveLength(1);
  });

  it("rejects splits without stock and checks sales against the split-adjusted quantity", async () => {
    const empty = await request(app).post("/api/transactions").send(split).expect(409);
    expect(empty.body.error.message).toContain("Split");
    expect(await repos.transactions.list(userA)).toEqual([]);
    const purchase = await request(app).post("/api/transactions").send(buy).expect(201);
    const created = await request(app).post("/api/transactions").send(split).expect(201);
    await request(app).post("/api/transactions").send({ ...sell, date: "2026-10-07", quantity: 21 }).expect(409);
    await request(app).post("/api/transactions").send({ ...sell, date: "2026-10-07", quantity: 15 }).expect(201);
    await request(app).delete(`/api/transactions/${created.body.id}`).expect(409);
    await request(app).put(`/api/transactions/${created.body.id}`).send({ ...split, ratio: 0.5 }).expect(409);
    await request(app).put(`/api/transactions/${created.body.id}`).send({ ...split, date: "2026-10-04" }).expect(409);
    await request(app).delete(`/api/transactions/${purchase.body.id}`).expect(409);
    expect((await repos.transactions.get(userA, created.body.id))?.ratio).toBe(2);
    expect(await repos.transactions.list(userA)).toHaveLength(3);
  });

  it("imports all transaction types in request order and validates the entire sequence", async () => {
    const importId = randomUUID();
    const rows = [
      { ...sell, quantity: 15 }, split, buy,
      { ...dividend, clientRequestId: "Zeilenkennung wird ignoriert" },
      { ...buy, instrument: secondInstrument },
    ];
    const imported = await request(app).post("/api/transactions/import").send({ importId, transactions: rows }).expect(201);
    expect(imported.body.created).toBe(5);
    expect(imported.body.transactions.map((transaction: TransactionInput) => transaction.type)).toEqual(["SELL", "SPLIT", "BUY", "DIVIDEND", "BUY"]);
    expect(imported.body.transactions[1]).toMatchObject({ quantity: 0, price: 0, fees: 0, ratio: 2 });
    expect(await repos.transactions.listByClientRequestIdPrefix(userA, `${importId}:`)).toEqual(imported.body.transactions);
    expect(await repos.transactions.list(userA)).toHaveLength(5);
  });

  it("collects every row field error with its zero-based row index", async () => {
    const response = await request(app).post("/api/transactions/import").send({
      importId: randomUUID(), transactions: [buy, { ...buy, quantity: 0, date: "2026-10-13" }, { ...split, ratio: 1 }, null],
    }).expect(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(response.body.error.fields).toEqual({
      "rows.1.quantity": expect.any(String), "rows.1.date": expect.any(String),
      "rows.2.ratio": expect.any(String), "rows.3.instrument": expect.any(String),
    });
    expect(await repos.transactions.list(userA)).toEqual([]);
  });

  it("rolls back every imported row on conflict, preserves existing data and allows retry", async () => {
    const previous = await request(app).post("/api/transactions").send(buy).expect(201);
    const importId = randomUUID();
    const response = await request(app).post("/api/transactions/import").send({
      importId, transactions: [buy, { ...sell, instrument: secondInstrument }],
    }).expect(409);
    expect(response.body.error.code).toBe("CONFLICT");
    expect(response.body.error.message).toContain("SIE");
    expect(response.body.error.message).toContain("06.10.2026");
    expect(await repos.transactions.list(userA)).toEqual([previous.body]);
    expect(await repos.transactions.listByClientRequestIdPrefix(userA, `${importId}:`)).toEqual([]);
    await request(app).post("/api/transactions/import").send({
      importId, transactions: [buy, { ...buy, instrument: secondInstrument }],
    }).expect(201);
    expect(await repos.transactions.list(userA)).toHaveLength(3);
  });

  it("rejects an imported split without stock and leaves no imported transaction", async () => {
    const result = await request(app).post("/api/transactions/import").send({
      importId: randomUUID(), transactions: [{ ...buy, instrument: secondInstrument }, split],
    }).expect(409);
    expect(result.body.error.message).toContain("SAP");
    expect(result.body.error.message).toContain("Split");
    expect(await repos.transactions.list(userA)).toEqual([]);
  });

  it("replays importIds without duplicates and ignores clientRequestIds of import rows", async () => {
    const importId = randomUUID();
    const transactions = Array.from({ length: 12 }, (_, index) => ({ ...buy, quantity: index + 1, clientRequestId: 123 }));
    const first = await request(app).post("/api/transactions/import").send({ importId, transactions }).expect(201);
    const replay = await request(app).post("/api/transactions/import").send({ importId, transactions: [{ ...buy, quantity: 999 }] }).expect(200);
    expect(replay.body).toEqual(first.body);
    expect(await repos.transactions.list(userA)).toHaveLength(12);
    expect((await repos.transactions.findByClientRequestId(userA, `${importId}:10`))?.quantity).toBe(11);
  });

  it("creates one complete import for simultaneous requests with the same importId", async () => {
    const input = { importId: randomUUID(), transactions: [buy, sell] };
    const results = await Promise.all([
      request(app).post("/api/transactions/import").send(input),
      request(app).post("/api/transactions/import").send(input),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 201]);
    expect(results[0]!.body).toEqual(results[1]!.body);
    expect(results[0]!.body.created).toBe(2);
    expect(await repos.transactions.list(userA)).toHaveLength(2);
    expect(await repos.transactions.listByClientRequestIdPrefix(userA, `${input.importId}:`))
      .toEqual(results[0]!.body.transactions);
  });

  it("replays the complete committed import after a PostgreSQL unique violation", async () => {
    const input = { importId: randomUUID(), transactions: [buy, sell] };
    const first = await request(app).post("/api/transactions/import").send(input).expect(201);
    vi.spyOn(repos, "atomic").mockRejectedValueOnce({ code: "23505" });
    const replay = await request(app).post("/api/transactions/import").send(input).expect(200);
    expect(replay.body).toEqual(first.body);
    expect(await repos.transactions.list(userA)).toHaveLength(2);
  });

  it("validates import UUIDs, lists and the maximum row count", async () => {
    const invalidId = await request(app).post("/api/transactions/import").send({ importId: "keine UUID", transactions: [buy] }).expect(400);
    expect(invalidId.body.error.fields.importId).toBeTruthy();
    for (const transactions of [undefined, [], {}, Array.from({ length: MAX_IMPORT_TRANSACTIONS + 1 }, () => buy)]) {
      const response = await request(app).post("/api/transactions/import").send({ importId: randomUUID(), transactions }).expect(400);
      expect(response.body.error.fields.transactions).toBeTruthy();
    }
    expect(await repos.transactions.list(userA)).toEqual([]);
    const limit = await request(app).post("/api/transactions/import").send({
      importId: randomUUID(), transactions: Array.from({ length: MAX_IMPORT_TRANSACTIONS }, () => buy),
    }).expect(201);
    expect(limit.body.created).toBe(MAX_IMPORT_TRANSACTIONS);
    expect(await repos.transactions.list(userA)).toHaveLength(MAX_IMPORT_TRANSACTIONS);
  });

  it("keeps imported data and importId replay scoped to their owner", async () => {
    const importId = randomUUID();
    const first = await request(app).post("/api/transactions/import").send({ importId, transactions: [buy] }).expect(201);
    const id = first.body.transactions[0].id as string;
    const listed = await request(app).get(`/api/transactions?userId=${userA}`).set("Test-User", userB).expect(200);
    expect(listed.body.transactions).toEqual([]);
    await request(app).put(`/api/transactions/${id}`).set("Test-User", userB).send(buy).expect(404);
    await request(app).delete(`/api/transactions/${id}`).set("Test-User", userB).expect(404);
    await request(app).post("/api/transactions/import").set("Test-User", userB).send({ importId, transactions: [sell] }).expect(409);
    const own = await request(app).post("/api/transactions/import").set("Test-User", userB).send({ importId, transactions: [buy], userId: userA }).expect(201);
    expect(own.body.transactions[0].id).not.toBe(id);
    expect(await repos.transactions.list(userA)).toEqual(first.body.transactions);
    expect(await repos.transactions.list(userB)).toEqual(own.body.transactions);
  });
});
