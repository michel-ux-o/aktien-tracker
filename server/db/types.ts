/**
 * Vertrag der Datenbankschicht (PostgreSQL). Produktion: `pg` mit DATABASE_URL.
 * Lokal und in Tests: PGlite (Postgres als WebAssembly, keine Installation nötig).
 *
 * Konventionen:
 * - Zeitpunkte werden als ISO-Text gespeichert (wie bisher), Beträge als DOUBLE PRECISION.
 * - Demo- und Live-Daten liegen in getrennten Postgres-Schemas ("demo" bzw. "live"), nie gemischt.
 * - Jede Abfrage auf Nutzerdaten filtert nach user_id. Fremde Datensätze verhalten sich wie nicht vorhandene.
 */
import type { Instrument, PriceAlert, PriceAlertInput, Transaction, TransactionInput, User, UserSettings } from "../../shared/types";

export interface QueryResult<Row> {
  rows: Row[];
  /** Anzahl betroffener Zeilen (UPDATE/DELETE/INSERT). */
  rowCount: number;
}

/** Eine Verbindung oder eine laufende Transaktion. Parameter als $1, $2, … */
export interface SqlClient {
  query<Row = Record<string, unknown>>(text: string, params?: unknown[]): Promise<QueryResult<Row>>;
}

export interface Database extends SqlClient {
  /** Name des Postgres-Schemas, in dem alle Tabellen liegen ("demo" oder "live"; in Tests beliebig). */
  readonly schema: string;
  /** Führt `operation` auf einer einzigen Verbindung in BEGIN … COMMIT aus; bei Fehler ROLLBACK und Fehler weiterwerfen. */
  transaction<T>(operation: (tx: SqlClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface StoredUser extends User {
  passwordHash: string;
}

export interface StoredSession {
  userId: string;
  tokenHash: string;
  expiresAt: string;
  createdAt: string;
}

export type StoredPasswordReset = StoredSession;

export interface StoredWatchlistItem {
  instrument: Instrument;
  addedAt: string;
}

export type StoredPriceAlert = Omit<PriceAlert, "quote">;

export interface AtomicOptions {
  /**
   * Serialisiert alle atomic-Abschnitte mit gleichem Schlüssel (pg_advisory_xact_lock).
   * Routen übergeben die Nutzer-ID, damit z. B. Bestandsprüfungen paralleler Anfragen
   * desselben Nutzers nicht gegeneinander laufen (Ersatz für SQLite BEGIN IMMEDIATE).
   */
  lockKey?: string;
}

/**
 * Gleiche Methoden und Semantik wie die bisherige SQLite-Schicht, aber asynchron.
 * `undefined` bedeutet „nicht gefunden“, boolean = „mindestens eine Zeile betroffen“.
 */
export interface Repositories {
  /**
   * Führt `operation` in einer Datenbanktransaktion aus. `operation` erhält Repositories, die an diese
   * Transaktion gebunden sind, und muss ausschließlich diese verwenden. Wirft `operation`, wird alles
   * zurückgerollt. Verschachtelte Aufrufe von `atomic` auf den übergebenen Repositories laufen in derselben
   * Transaktion weiter (ohne neue Transaktion).
   */
  atomic<T>(operation: (repos: Repositories) => Promise<T>, options?: AtomicOptions): Promise<T>;

  users: {
    findByEmail(email: string): Promise<StoredUser | undefined>;
    findById(userId: string): Promise<StoredUser | undefined>;
    /** Legt Nutzer und Standard-Einstellungen gemeinsam an. E-Mail wird getrimmt und klein geschrieben. */
    create(email: string, passwordHash: string, now: string): Promise<StoredUser>;
    updatePassword(userId: string, passwordHash: string): Promise<boolean>;
  };
  sessions: {
    create(userId: string, tokenHash: string, expiresAt: string, now: string): Promise<void>;
    findValid(tokenHash: string, now: string): Promise<StoredSession | undefined>;
    delete(tokenHash: string): Promise<boolean>;
    deleteForUser(userId: string): Promise<void>;
  };
  passwordResets: {
    create(userId: string, tokenHash: string, expiresAt: string, now: string): Promise<void>;
    findValid(tokenHash: string, now: string): Promise<StoredPasswordReset | undefined>;
    consume(tokenHash: string): Promise<boolean>;
  };
  settings: {
    get(userId: string): Promise<UserSettings>;
    update(userId: string, changes: Partial<UserSettings>): Promise<UserSettings>;
  };
  watchlist: {
    list(userId: string): Promise<StoredWatchlistItem[]>;
    add(userId: string, instrument: Instrument, now: string): Promise<{ item: StoredWatchlistItem; created: boolean }>;
    delete(userId: string, instrumentId: string): Promise<boolean>;
  };
  transactions: {
    /** Absteigend nach Datum, createdAt, id. */
    list(userId: string, instrumentId?: string): Promise<Transaction[]>;
    get(userId: string, id: string): Promise<Transaction | undefined>;
    findByClientRequestId(userId: string, requestId: string): Promise<Transaction | undefined>;
    /** Für den Import: client_request_id = `${importId}:${index}`, sortiert nach numerischem Index. */
    listByClientRequestIdPrefix(userId: string, prefix: string): Promise<Transaction[]>;
    create(userId: string, input: TransactionInput, now: string): Promise<Transaction>;
    update(userId: string, id: string, input: TransactionInput, now: string): Promise<Transaction | undefined>;
    delete(userId: string, id: string): Promise<boolean>;
  };
  alerts: {
    list(userId: string, instrumentId?: string): Promise<StoredPriceAlert[]>;
    get(userId: string, id: string): Promise<StoredPriceAlert | undefined>;
    count(userId: string): Promise<number>;
    create(userId: string, input: PriceAlertInput, now: string): Promise<StoredPriceAlert>;
    /** Erhält die erste Auslösung bis zur Reaktivierung. */
    markTriggered(userId: string, id: string, triggeredAt: string, price: number): Promise<StoredPriceAlert | undefined>;
    reactivate(userId: string, id: string): Promise<StoredPriceAlert | undefined>;
    delete(userId: string, id: string): Promise<boolean>;
  };
}
