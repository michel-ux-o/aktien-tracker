import { PGlite } from "@electric-sql/pglite";
import type { Transaction as PGliteTransaction } from "@electric-sql/pglite";
import { Pool } from "pg";
import type { PoolClient } from "pg";
import type { Database, QueryResult, SqlClient } from "./types";

function quoteSchema(schema: string): string {
  // PostgreSQL truncates identifiers after 63 bytes; rejecting longer names avoids collisions.
  if (!/^[a-z_][a-z0-9_]*$/.test(schema) || schema.length > 63) {
    throw new Error("Ungültiger Datenbank-Schemaname.");
  }
  return `"${schema}"`;
}

function postgresClient(client: PoolClient): SqlClient {
  return {
    async query<Row = Record<string, unknown>>(text: string, params?: unknown[]): Promise<QueryResult<Row>> {
      const result = await client.query(text, params);
      return { rows: result.rows as Row[], rowCount: result.rowCount ?? 0 };
    },
  };
}

function pgliteClient(client: PGliteTransaction): SqlClient {
  return {
    async query<Row = Record<string, unknown>>(text: string, params?: unknown[]): Promise<QueryResult<Row>> {
      const result = await client.query<Row>(text, params);
      return { rows: result.rows, rowCount: result.rowCount ?? result.affectedRows ?? result.rows.length };
    },
  };
}

async function initializeSchema(client: SqlClient, schema: string, quotedSchema: string): Promise<void> {
  // CREATE SCHEMA IF NOT EXISTS alone can race against another PostgreSQL connection.
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`schema:${schema}`]);
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${quotedSchema}`);
}

/** Internal adapter for the shared PGlite engine used by database tests. */
export async function createPGliteDatabase(instance: PGlite, schema: string, ownsInstance = false): Promise<Database> {
  const quotedSchema = quoteSchema(schema);
  let closed = false;
  let closing: Promise<void> | undefined;

  function assertOpen(): void {
    if (closed) throw new Error("Die Datenbank ist geschlossen.");
  }

  const db: Database = {
    schema,
    async query<Row = Record<string, unknown>>(text: string, params?: unknown[]): Promise<QueryResult<Row>> {
      // PGlite has one connection. Keeping SET LOCAL and the query in its native
      // transaction queue prevents search_path from leaking between shared schemas.
      return db.transaction((tx) => tx.query<Row>(text, params));
    },
    async transaction<T>(operation: (tx: SqlClient) => Promise<T>): Promise<T> {
      assertOpen();
      return instance.transaction(async (tx) => {
        await tx.query(`SET LOCAL search_path TO ${quotedSchema}`);
        return operation(pgliteClient(tx));
      });
    },
    async close(): Promise<void> {
      if (!closing) {
        closed = true;
        closing = ownsInstance ? instance.close() : Promise.resolve();
      }
      return closing;
    },
  };

  await db.transaction((tx) => initializeSchema(tx, schema, quotedSchema));
  return db;
}

export async function openDatabase(options: { url?: string; dataDir?: string; schema: string; ssl?: boolean }): Promise<Database> {
  const quotedSchema = quoteSchema(options.schema);
  if (!options.url) {
    const instance = new PGlite(options.dataDir);
    try {
      return await createPGliteDatabase(instance, options.schema, true);
    } catch (error) {
      await instance.close().catch(() => undefined);
      throw error;
    }
  }

  const pool = new Pool({
    connectionString: options.url,
    ...(options.ssl === undefined ? {} : { ssl: options.ssl ? { rejectUnauthorized: false } : false }),
  });
  let closed = false;
  let closing: Promise<void> | undefined;

  async function acquire(): Promise<PoolClient> {
    if (closed) throw new Error("Die Datenbank ist geschlossen.");
    const client = await pool.connect();
    try {
      // Await initialization on every checkout, including newly created connections.
      await client.query(`SET search_path TO ${quotedSchema}`);
      return client;
    } catch (error) {
      client.release(true);
      throw error;
    }
  }

  const db: Database = {
    schema: options.schema,
    async query<Row = Record<string, unknown>>(text: string, params?: unknown[]): Promise<QueryResult<Row>> {
      const client = await acquire();
      try {
        return await postgresClient(client).query<Row>(text, params);
      } finally {
        client.release();
      }
    },
    async transaction<T>(operation: (tx: SqlClient) => Promise<T>): Promise<T> {
      const client = await acquire();
      let discard = false;
      try {
        await client.query("BEGIN");
        const result = await operation(postgresClient(client));
        await client.query("COMMIT");
        return result;
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {
          discard = true;
        }
        throw error;
      } finally {
        client.release(discard);
      }
    },
    async close(): Promise<void> {
      if (!closing) {
        closed = true;
        closing = pool.end();
      }
      return closing;
    },
  };

  try {
    await db.transaction((tx) => initializeSchema(tx, options.schema, quotedSchema));
    return db;
  } catch (error) {
    await db.close().catch(() => undefined);
    throw error;
  }
}
