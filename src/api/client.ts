import { CSRF_HEADER, CSRF_HEADER_VALUE } from '@shared/api';
import type { AlertsResponse, ApiErrorBody, AuthResponse, HistoryResponse, ImportTransactionsRequest, ImportTransactionsResponse, LoginRequest, PasswordResetConfirm, PasswordResetRequest, PortfolioHistoryResponse, PortfolioResponse, ProfileResponse, QuoteResponse, QuotesResponse, RegisterRequest, SearchResponse, SettingsResponse, StatusResponse, TransactionsResponse, UpdateSettingsRequest, WatchlistResponse } from '@shared/api';
import type { HistoryRange, Instrument, PriceAlert, PriceAlertInput, Transaction, TransactionInput, WatchlistItem } from '@shared/types';

export const SESSION_EXPIRED_EVENT = 'aktien-tracker:session-expired';

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorBody['error']['code'];
  readonly fields: Record<string, string>;
  readonly body: ApiErrorBody;
  constructor(status: number, body: ApiErrorBody) {
    super(body.error.message);
    this.name = 'ApiError';
    this.status = status;
    this.code = body.error.code;
    this.fields = body.error.fields ?? {};
    this.body = body;
  }
}

export class NetworkError extends Error {
  constructor() {
    super('Die Verbindung zum Server ist fehlgeschlagen. Prüfe deine Internetverbindung und versuche es erneut.');
    this.name = 'NetworkError';
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Die Anfrage konnte nicht abgeschlossen werden. Bitte versuche es erneut.';
}

async function request<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(method !== 'GET' ? { [CSRF_HEADER]: CSRF_HEADER_VALUE } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new NetworkError();
  }
  if (!response.ok) {
    let payload: ApiErrorBody;
    try {
      const value: unknown = await response.json();
      if (!value || typeof value !== 'object' || !('error' in value) || !value.error || typeof value.error !== 'object' || !('message' in value.error) || typeof value.error.message !== 'string' || !('code' in value.error)) throw new Error('Invalid response');
      payload = value as ApiErrorBody;
    } catch {
      payload = { error: { code: response.status === 401 ? 'UNAUTHENTICATED' : 'INTERNAL_ERROR', message: response.status === 401 ? 'Deine Sitzung ist abgelaufen. Bitte melde dich erneut an.' : `Die Anfrage konnte nicht abgeschlossen werden (HTTP ${response.status}). Bitte versuche es erneut.` } };
    }
    if (response.status === 401 && !path.startsWith('/auth/')) window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
    throw new ApiError(response.status, payload);
  }
  if (response.status === 204) return undefined as T;
  try { return await response.json() as T; }
  catch { throw new Error('Der Server hat eine ungültige Antwort gesendet. Bitte versuche es erneut.'); }
}

const query = (values: Record<string, string>) => new URLSearchParams(values).toString();
export const api = {
  status: () => request<StatusResponse>('/status'),
  me: () => request<AuthResponse>('/auth/me'),
  login: (input: LoginRequest) => request<AuthResponse>('/auth/login', 'POST', input),
  register: (input: RegisterRequest) => request<AuthResponse>('/auth/register', 'POST', input),
  logout: () => request<void>('/auth/logout', 'POST'),
  requestPasswordReset: (input: PasswordResetRequest) => request<void>('/auth/password-reset/request', 'POST', input),
  confirmPasswordReset: (input: PasswordResetConfirm) => request<void>('/auth/password-reset/confirm', 'POST', input),
  settings: () => request<SettingsResponse>('/settings'),
  updateSettings: (input: UpdateSettingsRequest) => request<SettingsResponse>('/settings', 'PUT', input),
  search: (q: string, signal?: AbortSignal) => request<SearchResponse>(`/market/search?${query({ q })}`, 'GET', undefined, signal),
  quote: (id: string) => request<QuoteResponse>(`/market/quote?${query({ id })}`),
  quotes: (ids: string[]) => request<QuotesResponse>(`/market/quotes?${query({ ids: ids.join(',') })}`),
  history: (id: string, range: HistoryRange) => request<HistoryResponse>(`/market/history?${query({ id, range })}`),
  profile: (id: string) => request<ProfileResponse>(`/market/profile?${query({ id })}`),
  watchlist: () => request<WatchlistResponse>('/watchlist'),
  addWatchlist: (instrument: Instrument) => request<WatchlistItem>('/watchlist', 'POST', { instrument }),
  removeWatchlist: (id: string) => request<void>(`/watchlist/${encodeURIComponent(id)}`, 'DELETE'),
  transactions: (instrumentId?: string) => request<TransactionsResponse>(`/transactions${instrumentId ? `?${query({ instrumentId })}` : ''}`),
  createTransaction: (input: TransactionInput) => request<Transaction>('/transactions', 'POST', input),
  updateTransaction: (id: string, input: TransactionInput) => request<Transaction>(`/transactions/${encodeURIComponent(id)}`, 'PUT', input),
  deleteTransaction: (id: string) => request<void>(`/transactions/${encodeURIComponent(id)}`, 'DELETE'),
  importTransactions: (input: ImportTransactionsRequest) => request<ImportTransactionsResponse>('/transactions/import', 'POST', input),
  alerts: (instrumentId?: string) => request<AlertsResponse>(`/alerts${instrumentId ? `?${query({ instrumentId })}` : ''}`),
  createAlert: (input: PriceAlertInput) => request<PriceAlert>('/alerts', 'POST', input),
  reactivateAlert: (id: string) => request<PriceAlert>(`/alerts/${encodeURIComponent(id)}/reactivate`, 'POST'),
  deleteAlert: (id: string) => request<void>(`/alerts/${encodeURIComponent(id)}`, 'DELETE'),
  portfolio: () => request<PortfolioResponse>('/portfolio'),
  portfolioHistory: (range: HistoryRange) => request<PortfolioHistoryResponse>(`/portfolio/history?${query({ range })}`),
};
