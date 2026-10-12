import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "./types";

const pg = vi.hoisted(() => {
  const connect = vi.fn();
  const end = vi.fn();
  const Pool = vi.fn(class {
    connect = connect;
    end = end;
    constructor(_options: unknown) {}
  });
  return { Pool, connect, end };
});

vi.mock("pg", () => ({ Pool: pg.Pool }));

import { openDatabase } from "./database";

interface PgResult {
  rows: unknown[];
  rowCount: number | null;
}

function createClient() {
  return {
    query: vi.fn(async (_text: string, _params?: unknown[]): Promise<PgResult> => ({ rows: [], rowCount: 0 })),
    release: vi.fn(),
  };
}

const databases: Database[] = [];
const url = "postgresql://user:password@example.invalid/tracker";

async function open(options: Parameters<typeof openDatabase>[0] = { url, schema: "live" }): Promise<Database> {
  const db = await openDatabase(options);
  databases.push(db);
  return db;
}

beforeEach(() => {
  pg.Pool.mockClear();
  pg.connect.mockReset();
  pg.end.mockReset().mockResolvedValue(undefined);
  pg.connect.mockResolvedValue(createClient());
});

afterEach(async () => {
  await Promise.allSettled(databases.splice(0).map((db) => db.close()));
});

describe("PostgreSQL database adapter", () => {
  it.each([
    { ssl: undefined, expected: { connectionString: url } },
    { ssl: false, expected: { connectionString: url, ssl: false } },
    { ssl: true, expected: { connectionString: url, ssl: { rejectUnauthorized: false } } },
  ])("passes connection options with ssl=$ssl to the pool", async ({ ssl, expected }) => {
    await open({ url, schema: "live", ssl });
    expect(pg.Pool).toHaveBeenCalledOnce();
    expect(pg.Pool).toHaveBeenCalledWith(expected);
  });

  it.each(["", "Live", "0live", "live.public", "live; DROP SCHEMA public", "two schemas", "ü", "a".repeat(64)])(
    "rejects invalid schema %s before creating a pool",
    async (schema) => {
      await expect(openDatabase({ url, schema })).rejects.toThrow("Ungültiger Datenbank-Schemaname.");
      expect(pg.Pool).not.toHaveBeenCalled();
      expect(pg.connect).not.toHaveBeenCalled();
    },
  );

  it("creates the quoted schema while holding a transaction advisory lock", async () => {
    const client = createClient();
    pg.connect.mockResolvedValue(client);
    const db = await open({ url, schema: "_live_2" });
    expect(db.schema).toBe("_live_2");
    expect(client.query.mock.calls).toEqual([
      ['SET search_path TO "_live_2"'],
      ["BEGIN"],
      ["SELECT pg_advisory_xact_lock(hashtext($1))", ["schema:_live_2"]],
      ['CREATE SCHEMA IF NOT EXISTS "_live_2"', undefined],
      ["COMMIT"],
    ]);
    expect(client.release).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("sets search_path on every acquired connection and preserves query parameters", async () => {
    const bootstrap = createClient();
    const first = createClient();
    const second = createClient();
    pg.connect.mockResolvedValueOnce(bootstrap).mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const db = await open();
    await Promise.all([db.query("SELECT $1::int", [1]), db.query("SELECT $1::int", [2])]);
    expect(pg.connect).toHaveBeenCalledTimes(3);
    expect(first.query.mock.calls).toEqual([['SET search_path TO "live"'], ["SELECT $1::int", [1]]]);
    expect(second.query.mock.calls).toEqual([['SET search_path TO "live"'], ["SELECT $1::int", [2]]]);
    expect(first.release).toHaveBeenCalledExactlyOnceWith();
    expect(second.release).toHaveBeenCalledExactlyOnceWith();
  });

  it("returns rows and maps a null PostgreSQL rowCount to zero", async () => {
    const client = createClient();
    client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }).mockResolvedValueOnce({ rows: [{ value: 42 }], rowCount: null });
    pg.connect.mockResolvedValueOnce(createClient()).mockResolvedValueOnce(client);
    const db = await open();
    await expect(db.query<{ value: number }>("SELECT 42 AS value")).resolves.toEqual({ rows: [{ value: 42 }], rowCount: 0 });
    expect(client.release).toHaveBeenCalledExactlyOnceWith();
  });

  it("commits all transaction queries on one dedicated connection", async () => {
    const client = createClient();
    pg.connect.mockResolvedValueOnce(createClient()).mockResolvedValueOnce(client);
    const db = await open();
    const result = await db.transaction(async (tx) => {
      await tx.query("INSERT INTO example VALUES ($1)", [1]);
      await tx.query("UPDATE example SET id = $1", [2]);
      return 42;
    });
    expect(result).toBe(42);
    expect(pg.connect).toHaveBeenCalledTimes(2);
    expect(client.query.mock.calls).toEqual([
      ['SET search_path TO "live"'],
      ["BEGIN"],
      ["INSERT INTO example VALUES ($1)", [1]],
      ["UPDATE example SET id = $1", [2]],
      ["COMMIT"],
    ]);
    expect(client.release).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("rolls back callback failures and releases the client", async () => {
    const client = createClient();
    const failure = new Error("operation failed");
    pg.connect.mockResolvedValueOnce(createClient()).mockResolvedValueOnce(client);
    const db = await open();
    await expect(db.transaction(async (tx) => {
      await tx.query("INSERT INTO example VALUES ($1)", [1]);
      throw failure;
    })).rejects.toBe(failure);
    expect(client.query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(client.query).not.toHaveBeenCalledWith("COMMIT");
    expect(client.release).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("rolls back failed commits and preserves their error", async () => {
    const client = createClient();
    const failure = new Error("commit failed");
    client.query.mockImplementation(async (text) => {
      if (text === "COMMIT") throw failure;
      return { rows: [], rowCount: 0 };
    });
    pg.connect.mockResolvedValueOnce(createClient()).mockResolvedValueOnce(client);
    const db = await open();
    await expect(db.transaction(async () => 42)).rejects.toBe(failure);
    expect(client.query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(client.release).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("discards a connection whose rollback failed and preserves the operation error", async () => {
    const client = createClient();
    const failure = new Error("operation failed");
    client.query.mockImplementation(async (text) => {
      if (text === "ROLLBACK") throw new Error("rollback failed");
      return { rows: [], rowCount: 0 };
    });
    pg.connect.mockResolvedValueOnce(createClient()).mockResolvedValueOnce(client);
    const db = await open();
    await expect(db.transaction(async () => { throw failure; })).rejects.toBe(failure);
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it.each(["SELECT pg_advisory_xact_lock(hashtext($1))", 'CREATE SCHEMA IF NOT EXISTS "live"'])(
    "rolls back failed schema initialization at %s and closes the pool",
    async (failedStatement) => {
      const client = createClient();
      const failure = new Error("bootstrap failed");
      client.query.mockImplementation(async (text) => {
        if (text === failedStatement) throw failure;
        return { rows: [], rowCount: 0 };
      });
      pg.connect.mockResolvedValue(client);
      await expect(openDatabase({ url, schema: "live" })).rejects.toBe(failure);
      expect(client.query).toHaveBeenLastCalledWith("ROLLBACK");
      expect(client.release).toHaveBeenCalledExactlyOnceWith(false);
      expect(pg.end).toHaveBeenCalledOnce();
    },
  );

  it("discards failed search_path initialization and closes the bootstrap pool", async () => {
    const client = createClient();
    const failure = new Error("search_path failed");
    client.query.mockRejectedValue(failure);
    pg.connect.mockResolvedValue(client);
    await expect(openDatabase({ url, schema: "live" })).rejects.toBe(failure);
    expect(client.query).toHaveBeenCalledExactlyOnceWith('SET search_path TO "live"');
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(pg.end).toHaveBeenCalledOnce();
  });

  it("preserves bootstrap errors if closing the pool also fails", async () => {
    const client = createClient();
    const failure = new Error("bootstrap failed");
    client.query.mockRejectedValue(failure);
    pg.connect.mockResolvedValue(client);
    pg.end.mockRejectedValue(new Error("close failed"));
    await expect(openDatabase({ url, schema: "live" })).rejects.toBe(failure);
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(pg.end).toHaveBeenCalledOnce();
  });

  it("releases standalone query connections after a query error", async () => {
    const client = createClient();
    const failure = new Error("query failed");
    client.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }).mockRejectedValueOnce(failure);
    pg.connect.mockResolvedValueOnce(createClient()).mockResolvedValueOnce(client);
    const db = await open();
    await expect(db.query("SELECT broken")).rejects.toBe(failure);
    expect(client.release).toHaveBeenCalledExactlyOnceWith();
  });

  it("closes the pool once and rejects later operations", async () => {
    const db = await open();
    await Promise.all([db.close(), db.close()]);
    expect(pg.end).toHaveBeenCalledOnce();
    await expect(db.query("SELECT 1")).rejects.toThrow("Die Datenbank ist geschlossen.");
    await expect(db.transaction(async () => 1)).rejects.toThrow("Die Datenbank ist geschlossen.");
    expect(pg.connect).toHaveBeenCalledOnce();
  });
});
