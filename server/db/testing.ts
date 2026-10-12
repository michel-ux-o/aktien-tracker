import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { createPGliteDatabase } from "./database";
import { createRepositories } from "./index";
import type { Database, Repositories } from "./types";

// Vitest isolates modules per test file, so expensive WASM startup happens once per file.
let sharedInstance: PGlite | undefined;

export async function createTestRepositories(): Promise<{ db: Database; repos: Repositories; close(): Promise<void> }> {
  sharedInstance ??= new PGlite();
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  const db = await createPGliteDatabase(sharedInstance, schema);
  let closing: Promise<void> | undefined;

  function close(): Promise<void> {
    closing ??= (async () => {
      await db.query(`DROP SCHEMA "${schema}" CASCADE`);
      await db.close();
    })();
    return closing;
  }

  try {
    const repos = await createRepositories(db);
    return { db, repos, close };
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
}
