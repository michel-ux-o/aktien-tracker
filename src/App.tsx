import { lazy, Suspense, useEffect, useRef } from 'react';
import { Link, NavLink, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';
import { ProtectedRoute } from './auth/ProtectedRoute';
import { DemoBanner } from './components/DemoBanner';
import { SearchBox } from './components/SearchBox';
import { LoginPage, RegisterPage, ForgotPasswordPage, ResetPasswordPage } from './pages/AuthPages';
import { LoadingState } from './components/LoadingState';
import { errorMessage } from './api/client';
import './styles/alerts.css';

const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const PortfolioPage = lazy(() => import('./pages/PortfolioPage'));
const WatchlistPage = lazy(() => import('./pages/WatchlistPage'));
const AlertsPage = lazy(() => import('./pages/AlertsPage'));
const StockPage = lazy(() => import('./pages/StockPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const SearchPage = lazy(() => import('./pages/SearchPage'));

const navigation = [
  { to: '/', label: 'Dashboard', icon: 'dashboard' },
  { to: '/portfolio', label: 'Portfolio', icon: 'portfolio' },
  { to: '/suche', label: 'Suche', icon: 'search' },
  { to: '/watchlist', label: 'Watchlist', icon: 'watchlist' },
  { to: '/alarme', label: 'Kursalarme', icon: 'alerts' },
  { to: '/einstellungen', label: 'Einstellungen', icon: 'settings' },
];
function Icon({ name }: { name: string }) {
  const paths: Record<string, React.ReactNode> = {
    dashboard: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
    portfolio: <><rect x="3" y="7" width="18" height="14" rx="2" /><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12h18M10 12v3h4v-3" /></>,
    search: <><circle cx="10.5" cy="10.5" r="7" /><path d="m16 16 5 5" /></>,
    watchlist: <path d="M6 4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17l-6-4-6 4Z" />,
    alerts: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4M12 2V1" /></>,
    settings: <><path d="m9 3-.5 3-2 1L4 6 2 9l2 2v2l-2 2 2 3 2.5-1 2 1 .5 3h6l.5-3 2-1 2.5 1 2-3-2-2v-2l2-2-2-3-2.5 1-2-1-.5-3Z" /><circle cx="12" cy="12" r="3" /></>,
  };
  return <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
function Brand() { return <Link className="brand" to="/" aria-label="Aktien-Tracker – Dashboard"><span className="brand-mark" aria-hidden="true"><svg viewBox="0 0 32 32" fill="none"><path d="M7 22V11m9 11V7m9 15V3" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" /><path d="M6 27h20" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg></span><span>Aktien<span className="brand-light">Tracker</span></span></Link>; }
function AppShell() {
  const { user, settingsError, refresh } = useAuth();
  return <div className="app-shell">
    <aside className="sidebar"><Brand /><span className="nav-caption">DEINE ÜBERSICHT</span><nav aria-label="Hauptnavigation">{navigation.filter(item => item.to !== '/suche').map(item => <NavLink end={item.to === '/'} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} key={item.to} to={item.to}><Icon name={item.icon} /><span>{item.label}</span></NavLink>)}</nav><div className="sidebar-bottom"><span className="sidebar-motto">Klarheit für<br />deine Anlagen.</span><div className="account-chip"><span className="avatar" aria-hidden="true">{user?.email.charAt(0).toUpperCase()}</span><div><strong>Dein Konto</strong><span>{user?.email}</span></div></div></div></aside>
    <div className="workspace"><header className="app-header"><div className="mobile-brand"><Brand /></div><div className="header-search"><SearchBox label="Aktien suchen" placeholder="Aktie oder Ticker suchen …" /></div><Link className="header-account" to="/einstellungen" aria-label="Kontoeinstellungen"><span className="avatar" aria-hidden="true">{user?.email.charAt(0).toUpperCase()}</span><span>Mein Konto</span></Link></header><div className="content-wrap">{settingsError != null && <div className="notice notice-warning" role="status">Einstellungen konnten nicht geladen werden. <button className="text-button" onClick={() => { void refresh(); }}>Erneut versuchen</button></div>}<Outlet /></div><footer className="app-footer"><span>Deine Zahlen. Deine Entscheidungen.</span><span>Keine Anlageempfehlung · Keine Steuerberechnung</span></footer></div>
    <nav className="bottom-nav" aria-label="Mobile Hauptnavigation">{navigation.filter(item => item.to !== '/alarme').map(item => <NavLink end={item.to === '/'} className={({ isActive }) => `bottom-nav-link ${isActive ? 'active' : ''}`} key={item.to} to={item.to}><Icon name={item.icon} /><span>{item.label}</span></NavLink>)}</nav>
  </div>;
}
function NotFoundPage() { return <section className="empty-state"><span className="eyebrow">404</span><h1>Diese Seite gibt es nicht.</h1><p className="muted">Über die Navigation findest du zurück zu deiner Übersicht.</p><Link className="button button-primary" to="/">Zum Dashboard</Link></section>; }
export default function App() {
  const { status, statusError, refreshStatus } = useAuth();
  const location = useLocation();
  const first = useRef(true);
  useEffect(() => {
    const titles: Record<string, string> = { '/': 'Dashboard', '/portfolio': 'Portfolio', '/watchlist': 'Watchlist', '/alarme': 'Kursalarme', '/suche': 'Suche', '/einstellungen': 'Einstellungen', '/anmelden': 'Anmelden', '/registrieren': 'Registrieren', '/passwort-vergessen': 'Passwort vergessen', '/passwort-zuruecksetzen': 'Passwort zurücksetzen' };
    document.title = `${titles[location.pathname] ?? (location.pathname.startsWith('/aktie/') ? 'Aktie' : 'Seite')} · Aktien-Tracker`;
    window.scrollTo({ top: 0, behavior: 'instant' });
    if (first.current) { first.current = false; return; }
    document.getElementById('main-content')?.focus({ preventScroll: true });
  }, [location.pathname]);
  return <><a className="skip-link" href="#main-content">Zum Inhalt springen</a><DemoBanner status={status} />{statusError != null && <div className="status-warning" role="status">Datenquellenstatus nicht verfügbar: {errorMessage(statusError)} <button className="text-button" onClick={() => { void refreshStatus(); }}>Wiederholen</button></div>}<main id="main-content" tabIndex={-1}><Suspense fallback={<div className="initial-state"><LoadingState label="Seite wird geladen …" /></div>}><Routes><Route path="/anmelden" element={<LoginPage />} /><Route path="/registrieren" element={<RegisterPage />} /><Route path="/passwort-vergessen" element={<ForgotPasswordPage />} /><Route path="/passwort-zuruecksetzen" element={<ResetPasswordPage />} /><Route element={<ProtectedRoute />}><Route element={<AppShell />}><Route index element={<DashboardPage />} /><Route path="/portfolio" element={<PortfolioPage />} /><Route path="/watchlist" element={<WatchlistPage />} /><Route path="/alarme" element={<AlertsPage />} /><Route path="/aktie/:id" element={<StockPage />} /><Route path="/einstellungen" element={<SettingsPage />} /><Route path="/suche" element={<SearchPage />} /><Route path="*" element={<NotFoundPage />} /></Route></Route></Routes></Suspense></main></>;
}
