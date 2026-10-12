/**
 * HTTP-API-Vertrag zwischen Client (src/) und Server (server/).
 * Alle Pfade beginnen mit /api, Bodies sind JSON.
 *
 * Authentifizierung: httpOnly-Session-Cookie "sid" (SameSite=Lax, Secure in Produktion).
 * CSRF-Schutz: Jede Anfrage mit Methode POST/PUT/PATCH/DELETE muss den Header
 *   `X-Requested-With: aktien-tracker` tragen, sonst 403.
 * Fehlerformat (alle Status >= 400): ApiErrorBody.
 * Geschützte Endpunkte (alles außer /api/status und /api/auth/*) liefern ohne gültige Session 401.
 * Der Server ermittelt den Nutzer ausschließlich aus der Session – nie aus Parametern des Clients.
 */
import type {
  DataMeta,
  HistoryRange,
  Instrument,
  InstrumentId,
  InstrumentProfile,
  Portfolio,
  PortfolioHistory,
  PriceAlert,
  PriceAlertInput,
  PriceHistory,
  Quote,
  Transaction,
  TransactionInput,
  User,
  UserSettings,
  WatchlistItem,
} from "./types";

export const CSRF_HEADER = "X-Requested-With";
export const CSRF_HEADER_VALUE = "aktien-tracker";

export type ApiErrorCode =
  | "VALIDATION_ERROR" // 400, `fields` enthält Feldfehler
  | "UNAUTHENTICATED" // 401
  | "FORBIDDEN" // 403 (z. B. fehlender CSRF-Header)
  | "NOT_FOUND" // 404 (auch für Daten anderer Nutzer – keine Existenz verraten)
  | "CONFLICT" // 409 (z. B. E-Mail bereits registriert, Verkauf über Bestand)
  | "RATE_LIMITED" // 429
  | "MARKET_DATA_UNAVAILABLE" // 502/503: Anbieter nicht erreichbar oder Limit erreicht
  | "INTERNAL_ERROR"; // 500

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    /** Deutsche, für Nutzer verständliche Meldung. */
    message: string;
    /** Feldname -> deutsche Fehlermeldung. */
    fields?: Record<string, string>;
  };
}

// ---------- Status ----------
/** GET /api/status (öffentlich) */
export interface StatusResponse {
  marketData: {
    mode: "demo" | "live";
    /** Anzeigename, z. B. "Twelve Data" oder "Demo-Daten". */
    source: string;
    /** Allgemeiner Verzögerungshinweis der Quelle. */
    delayNote: string | null;
  };
  email: {
    /** "console" = kein SMTP konfiguriert, Reset-Links erscheinen nur in der Server-Konsole. */
    mode: "smtp" | "console";
  };
}

// ---------- Auth ----------
/** POST /api/auth/register  -> 201 AuthResponse, setzt Cookie. 409 CONFLICT wenn E-Mail existiert. */
export interface RegisterRequest {
  email: string;
  /** Mindestens 10 Zeichen. */
  password: string;
}
/** POST /api/auth/login -> 200 AuthResponse, setzt Cookie. 401 bei falschen Daten (generische Meldung), 429 bei zu vielen Versuchen. */
export interface LoginRequest {
  email: string;
  password: string;
}
export interface AuthResponse {
  user: User;
}
/** POST /api/auth/logout -> 204, löscht Session und Cookie. */
/** GET /api/auth/me -> 200 AuthResponse oder 401. */

/** POST /api/auth/password-reset/request -> 202 immer (verrät nicht, ob die E-Mail existiert). */
export interface PasswordResetRequest {
  email: string;
}
/**
 * POST /api/auth/password-reset/confirm -> 204. Token ist einmalig und 60 Minuten gültig.
 * Beendet alle bestehenden Sessions des Nutzers. 400 VALIDATION_ERROR bei ungültigem/abgelaufenem Token.
 * Der Link in der E-Mail lautet `${APP_URL}/passwort-zuruecksetzen?token=<token>`.
 */
export interface PasswordResetConfirm {
  token: string;
  password: string;
}

// ---------- Einstellungen ----------
/** GET /api/settings -> UserSettings; PUT /api/settings (Partial<UserSettings>) -> UserSettings */
export type SettingsResponse = UserSettings;
export type UpdateSettingsRequest = Partial<UserSettings>;

// ---------- Marktdaten (geschützt) ----------
/** GET /api/market/search?q=<min. 1 Zeichen> */
export interface SearchResponse {
  results: Instrument[];
  meta: DataMeta;
}
/** GET /api/market/quote?id=<InstrumentId> -> Quote (404 wenn unbekannt) */
export type QuoteResponse = Quote;
/** GET /api/market/quotes?ids=<id1>,<id2>  (max. 50) */
export interface QuotesResponse {
  /** Fehlende Einträge = für dieses Wertpapier kein Kurs verfügbar. */
  quotes: Record<InstrumentId, Quote>;
}
/** GET /api/market/history?id=<InstrumentId>&range=<HistoryRange> -> PriceHistory */
export type HistoryResponse = PriceHistory;
/** GET /api/market/profile?id=<InstrumentId> -> InstrumentProfile */
export type ProfileResponse = InstrumentProfile;

// ---------- Watchlist (geschützt) ----------
/** GET /api/watchlist */
export interface WatchlistResponse {
  items: WatchlistItem[];
}
/** POST /api/watchlist -> 201 WatchlistItem (idempotent: existiert bereits -> 200 mit vorhandenem Eintrag) */
export interface AddToWatchlistRequest {
  instrument: Instrument;
}
/** DELETE /api/watchlist/:instrumentId (URL-kodiert) -> 204, 404 wenn nicht vorhanden */

// ---------- Transaktionen (geschützt) ----------
/** GET /api/transactions[?instrumentId=...] -> absteigend nach Datum */
export interface TransactionsResponse {
  transactions: Transaction[];
}
/**
 * POST /api/transactions (TransactionInput) -> 201 Transaction
 *   Gleiche clientRequestId erneut -> 200 mit der bereits angelegten Transaktion.
 * PUT /api/transactions/:id (TransactionInput) -> 200 Transaction
 * DELETE /api/transactions/:id -> 204
 * Jede Änderung wird gegen die komplette Transaktionsfolge des Wertpapiers geprüft:
 * Würde ein Verkauf den Bestand zu irgendeinem Zeitpunkt übersteigen -> 409 CONFLICT
 * (fields.quantity bzw. message erklärt das Problem).
 */
export type CreateTransactionRequest = TransactionInput;
export type UpdateTransactionRequest = TransactionInput;

/** Höchstzahl an Transaktionen je Import. */
export const MAX_IMPORT_TRANSACTIONS = 2000;

/**
 * POST /api/transactions/import -> 201 ImportTransactionsResponse (Body-Limit 2 MB)
 *   Alles-oder-nichts: Entweder werden alle Transaktionen angelegt oder keine.
 *   Jede Zeile wird wie bei POST /api/transactions geprüft (clientRequestId der Zeilen wird ignoriert).
 *   400 VALIDATION_ERROR: `fields` mit Schlüsseln "rows.<index>.<feld>" (index 0-basiert wie im Request),
 *     bzw. "transactions", wenn die Liste leer ist oder MAX_IMPORT_TRANSACTIONS überschreitet.
 *   409 CONFLICT: Die Transaktionsfolge eines Wertpapiers wäre (zusammen mit den vorhandenen
 *     Transaktionen) ungültig; message nennt Wertpapier und Datum.
 *   Gleiche importId erneut -> 200 mit den bereits angelegten Transaktionen (Schutz vor Doppel-Absenden).
 */
export interface ImportTransactionsRequest {
  /** Vom Client je Importvorgang erzeugte UUID. */
  importId: string;
  transactions: TransactionInput[];
}
export interface ImportTransactionsResponse {
  created: number;
  transactions: Transaction[];
}

// ---------- Kursalarme (geschützt) ----------
/** Höchstzahl an Kursalarmen je Nutzer. */
export const MAX_PRICE_ALERTS = 100;

/**
 * GET /api/alerts[?instrumentId=...] -> AlertsResponse
 *   Prüft dabei alle aktiven Alarme gegen aktuelle Kurse und speichert Auslösungen.
 *   Fehlende Kurse lassen den Alarm aktiv (quote = null). Sortierung: ausgelöste zuerst
 *   (neueste Auslösung zuerst), dann aktive nach createdAt absteigend.
 * POST /api/alerts (PriceAlertInput) -> 201 PriceAlert; 400 VALIDATION_ERROR; 409 CONFLICT bei mehr als MAX_PRICE_ALERTS.
 * POST /api/alerts/:id/reactivate -> 200 PriceAlert (triggeredAt/triggeredPrice wieder null)
 * DELETE /api/alerts/:id -> 204; fremde oder unbekannte Alarme -> 404.
 */
export interface AlertsResponse {
  alerts: PriceAlert[];
  /** Anzahl ausgelöster Alarme in `alerts`. */
  triggeredCount: number;
}
export type CreateAlertRequest = PriceAlertInput;

// ---------- Portfolio (geschützt) ----------
/** GET /api/portfolio -> Portfolio (in Basiswährung des Nutzers) */
export type PortfolioResponse = Portfolio;
/** GET /api/portfolio/history?range=<HistoryRange> -> PortfolioHistory */
export type PortfolioHistoryResponse = PortfolioHistory;

export type { HistoryRange, InstrumentId };
