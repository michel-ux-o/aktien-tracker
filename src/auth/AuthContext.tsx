import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { LoginRequest, RegisterRequest, StatusResponse, UpdateSettingsRequest } from '@shared/api';
import type { User, UserSettings } from '@shared/types';
import { api, ApiError, SESSION_EXPIRED_EVENT } from '../api/client';

interface AuthValue {
  user: User | null;
  settings: UserSettings | null;
  status: StatusResponse | null;
  loading: boolean;
  error: unknown;
  statusError: unknown;
  settingsError: unknown;
  refresh: () => Promise<void>;
  refreshStatus: () => Promise<void>;
  login: (input: LoginRequest) => Promise<void>;
  register: (input: RegisterRequest) => Promise<void>;
  logout: () => Promise<void>;
  invalidateSession: () => void;
  updateSettings: (input: UpdateSettingsRequest) => Promise<UserSettings>;
}
const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [statusError, setStatusError] = useState<unknown>(null);
  const [settingsError, setSettingsError] = useState<unknown>(null);
  const generation = useRef(0);

  const invalidateSession = useCallback(() => {
    generation.current += 1;
    setUser(null); setSettings(null); setError(null); setSettingsError(null); setLoading(false);
  }, []);

  const loadSettings = useCallback(async (expectedGeneration: number) => {
    try {
      const value = await api.settings();
      if (generation.current === expectedGeneration) { setSettings(value); setSettingsError(null); }
    } catch (reason) { if (generation.current === expectedGeneration) setSettingsError(reason); }
  }, []);
  const refreshStatus = useCallback(async () => {
    try { setStatus(await api.status()); setStatusError(null); }
    catch (reason) { setStatusError(reason); }
  }, []);
  const refresh = useCallback(async () => {
    const expectedGeneration = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const response = await api.me();
      if (generation.current !== expectedGeneration) return;
      setUser(response.user);
      await loadSettings(expectedGeneration);
    } catch (reason) {
      if (generation.current !== expectedGeneration) return;
      if (reason instanceof ApiError && reason.status === 401) { setUser(null); setSettings(null); }
      else setError(reason);
    } finally { if (generation.current === expectedGeneration) setLoading(false); }
  }, [loadSettings]);
  useEffect(() => { void refresh(); void refreshStatus(); }, [refresh, refreshStatus]);
  useEffect(() => {
    window.addEventListener(SESSION_EXPIRED_EVENT, invalidateSession);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, invalidateSession);
  }, [invalidateSession]);
  useEffect(() => {
    const preference = user ? settings?.theme ?? 'system' : 'system';
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = preference === 'dark' || (preference === 'system' && media.matches);
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
      document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#101923' : '#f5f7f8');
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [user, settings?.theme]);

  const login = async (input: LoginRequest) => {
    const expectedGeneration = ++generation.current;
    const response = await api.login(input);
    setError(null);
    setUser(response.user);
    await loadSettings(expectedGeneration);
    setLoading(false);
  };
  const register = async (input: RegisterRequest) => {
    const expectedGeneration = ++generation.current;
    const response = await api.register(input);
    setError(null);
    setUser(response.user);
    await loadSettings(expectedGeneration);
    setLoading(false);
  };
  const logout = async () => { await api.logout(); invalidateSession(); };
  const updateSettings = async (input: UpdateSettingsRequest) => {
    const updated = await api.updateSettings(input);
    setSettings(updated);
    setSettingsError(null);
    return updated;
  };
  return <AuthContext.Provider value={{ user, settings, status, loading, error, statusError, settingsError, refresh, refreshStatus, login, register, logout, invalidateSession, updateSettings }}>{children}</AuthContext.Provider>;
}
export function useAuth(): AuthValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('AuthProvider fehlt.');
  return context;
}
