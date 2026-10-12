import { existsSync, mkdirSync } from "node:fs";
import type { Server } from "node:http";
import { resolve } from "node:path";
import { createApp } from "./app";
import { createRepositories } from "./db";
import { openDatabase } from "./db/database";
import type { Database } from "./db/types";
import { createMailerFromEnv } from "./mail";
import { CachingProvider, DemoProvider, TwelveDataProvider } from "./market";

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => { if (error) reject(error); else resolveClose(); });
    server.closeIdleConnections();
  });
}

async function main(): Promise<void> {
  let db: Database | undefined;
  let server: Server | undefined;
  let stage = "Konfiguration";
  try {
    if (existsSync(".env")) process.loadEnvFile(".env");
    const port = Number(process.env.PORT || 3001);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("PORT muss eine gültige Portnummer sein.");
    const proxyValue = process.env.TRUST_PROXY?.trim() || undefined;
    const trustProxy = proxyValue === undefined ? undefined : Number(proxyValue);
    if (proxyValue !== undefined && (!/^\d+$/.test(proxyValue) || !Number.isSafeInteger(trustProxy))) {
      throw new Error("TRUST_PROXY muss eine nichtnegative ganze Zahl von Proxy-Hops sein (0 deaktiviert Proxy-Vertrauen).");
    }
    const sslValue = process.env.DATABASE_SSL?.trim().toLowerCase() || undefined;
    if (sslValue !== undefined && !["true", "false"].includes(sslValue)) {
      throw new Error("DATABASE_SSL muss true oder false sein.");
    }
    const apiKey = process.env.TWELVE_DATA_API_KEY?.trim();
    const provider = apiKey ? new TwelveDataProvider({ apiKey }) : new DemoProvider();
    const market = new CachingProvider(provider);
    const url = process.env.DATABASE_URL?.trim() || undefined;
    const dataDir = resolve(process.env.DATA_DIR || "./data", "pglite");
    stage = url ? "PostgreSQL-Verbindung (DATABASE_URL und DATABASE_SSL prüfen)" : "PGlite-Datenbank (DATA_DIR und Schreibrechte prüfen)";
    if (!url) mkdirSync(dataDir, { recursive: true });
    db = await openDatabase({ url, dataDir, schema: provider.mode, ssl: sslValue === undefined ? undefined : sslValue === "true" });
    const repos = await createRepositories(db);
    stage = "Anwendungsinitialisierung";
    const mailer = createMailerFromEnv();
    const app = createApp({ repos, market, mailer, trustProxy });
    stage = `HTTP-Server auf Port ${port} (PORT und Portbelegung prüfen)`;
    server = app.listen(port);
    const listeningServer = server;
    await new Promise<void>((resolveListen, reject) => {
      listeningServer.once("error", reject);
      listeningServer.once("listening", () => {
        listeningServer.removeListener("error", reject);
        resolveListen();
      });
    });
    console.log(`Aktien-Tracker läuft auf Port ${port} (${provider.mode === "demo" ? "Demo – keine echten Marktdaten" : "Twelve Data"}).`);

    const runningDb = db;
    let shuttingDown = false;
    async function shutdown(): Promise<void> {
      if (shuttingDown) return;
      shuttingDown = true;
      try {
        await closeServer(listeningServer);
      } finally {
        await runningDb.close();
      }
    }
    const onSignal = () => {
      void shutdown().catch(() => {
        console.error("Der Server oder die Datenbank konnte beim Herunterfahren nicht sauber geschlossen werden.");
        process.exitCode = 1;
      });
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  } catch (error) {
    // Datenbank- und Anbieterfehler können Zugangsdaten enthalten; nur die betroffene Startphase loggen.
    const detail = stage === "Konfiguration" && error instanceof Error ? `: ${error.message}` : ".";
    console.error(`Aktien-Tracker konnte nicht gestartet werden – ${stage}${detail}`);
    if (server) await closeServer(server).catch(() => undefined);
    if (db) await db.close().catch(() => undefined);
    process.exitCode = 1;
  }
}

void main().catch(() => {
  console.error("Aktien-Tracker konnte nicht gestartet werden.");
  process.exitCode = 1;
});
