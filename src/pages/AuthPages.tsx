import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError, errorMessage } from '../api/client';
import { useAuth } from '../auth/AuthContext';

type Mode = 'login' | 'register' | 'forgot' | 'reset';
const copy = {
  login: { title: 'Willkommen zurück.', description: 'Dein Portfolio. Klar im Blick.', submit: 'Anmelden' },
  register: { title: 'Ein guter Anfang.', description: 'Erstelle dein Konto und behalte deine Anlagen im Blick.', submit: 'Konto erstellen' },
  forgot: { title: 'Passwort vergessen?', description: 'Fordere einen Link an, um dein Passwort zurückzusetzen.', submit: 'Link anfordern' },
  reset: { title: 'Ein neues Passwort.', description: 'Wähle ein sicheres Passwort für dein Konto.', submit: 'Passwort speichern' },
};

function AuthPage({ mode }: { mode: Mode }) {
  const auth = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [done, setDone] = useState(false);
  const info = copy[mode];
  if (auth.user && (mode === 'login' || mode === 'register')) return <Navigate to="/" replace />;
  const hasEmail = mode !== 'reset';
  const hasPassword = mode !== 'forgot';
  const newPassword = mode === 'register' || mode === 'reset';
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || ((mode === 'login' || mode === 'register') && auth.loading)) return;
    const errors: Record<string, string> = {};
    if (hasEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) errors.email = 'Bitte gib eine gültige E-Mail-Adresse ein.';
    if (hasPassword && !password) errors.password = 'Bitte gib dein Passwort ein.';
    if (newPassword && password.length < 10) errors.password = 'Das Passwort muss mindestens 10 Zeichen enthalten.';
    if (newPassword && confirmation !== password) errors.confirmation = 'Die Passwörter stimmen nicht überein.';
    if (mode === 'reset' && !token) errors.token = 'Der Link enthält kein gültiges Token. Bitte fordere einen neuen Link an.';
    setFields(errors);
    setError('');
    if (Object.keys(errors).length) {
      requestAnimationFrame(() => document.querySelector<HTMLInputElement>('[aria-invalid="true"]')?.focus());
      return;
    }
    setPending(true);
    try {
      if (mode === 'login' || mode === 'register') {
        await auth[mode]({ email: email.trim(), password });
        const from = (location.state as { from?: string } | null)?.from;
        navigate(from?.startsWith('/') && !from.startsWith('//') ? from : '/', { replace: true });
      } else if (mode === 'forgot') { await api.requestPasswordReset({ email: email.trim() }); setDone(true); }
      else { await api.confirmPasswordReset({ token, password }); auth.invalidateSession(); setDone(true); }
    } catch (reason) {
      setError(errorMessage(reason));
      if (reason instanceof ApiError) setFields(reason.fields);
    } finally { setPending(false); }
  }
  return <div className="auth-layout">
    <div className="auth-story" aria-hidden="true"><span className="eyebrow">MEHR ÜBERBLICK. MEHR RUHE.</span><h2>Deine Anlagen.<br />Deine Perspektive.</h2><p>Verstehe, wie sich dein Portfolio entwickelt. Mit klaren Zahlen und transparenter Berechnung.</p><div className="story-visual"><span className="story-line" /><span className="story-dot" /><div className="story-caption">Alles an einem Ort</div></div><span className="story-footer">Kurse · Portfolio · Watchlist</span></div>
    <section className="auth-card" aria-labelledby="auth-title">
      <span className="eyebrow">AKTIEN-TRACKER</span><h1 id="auth-title">{info.title}</h1><p className="muted">{info.description}</p>
      {mode === 'forgot' && auth.status?.email.mode === 'console' && <div className="notice notice-warning"><strong>Lokaler Modus: Es wird keine E-Mail versendet.</strong><p>Der Link zum Zurücksetzen erscheint in der Server-Konsole. Dort kann er lokal geöffnet werden.</p></div>}
      {done ? <div className="section-stack"><div className="notice notice-success" role="status"><strong>{mode === 'forgot' ? 'Anfrage aufgenommen' : 'Passwort gespeichert'}</strong><p>{mode === 'forgot' ? auth.status?.email.mode === 'console' ? 'Falls ein Konto zu dieser Adresse existiert, findest du den Link in der Server-Konsole.' : 'Falls ein Konto zu dieser Adresse existiert, erhältst du einen Link zum Zurücksetzen. Er ist 60 Minuten gültig.' : 'Deine bisherigen Sitzungen wurden beendet. Du kannst dich jetzt mit deinem neuen Passwort anmelden.'}</p></div><Link className="button button-primary" to="/anmelden">Zur Anmeldung</Link></div> : <form className="auth-form" onSubmit={submit} noValidate>
        {hasEmail && <div className="form-field"><label htmlFor="auth-email">E-Mail-Adresse</label><input id="auth-email" type="email" autoComplete="email" value={email} onChange={event => setEmail(event.target.value)} required aria-invalid={!!fields.email} aria-describedby={fields.email ? 'email-error' : undefined} /><FieldError id="email-error" message={fields.email} /></div>}
        {hasPassword && <div className="form-field"><div className="label-line"><label htmlFor="auth-password">{newPassword ? 'Neues Passwort' : 'Passwort'}</label>{mode === 'login' && <Link to="/passwort-vergessen">Vergessen?</Link>}</div><input id="auth-password" type="password" autoComplete={newPassword ? 'new-password' : 'current-password'} value={password} onChange={event => setPassword(event.target.value)} required minLength={newPassword ? 10 : undefined} aria-invalid={!!fields.password} aria-describedby={fields.password ? 'password-error' : newPassword ? 'password-hint' : undefined} />{newPassword && <small id="password-hint" className="muted">Mindestens 10 Zeichen.</small>}<FieldError id="password-error" message={fields.password} /></div>}
        {newPassword && <div className="form-field"><label htmlFor="auth-confirmation">Passwort wiederholen</label><input id="auth-confirmation" type="password" autoComplete="new-password" value={confirmation} onChange={event => setConfirmation(event.target.value)} required aria-invalid={!!fields.confirmation} aria-describedby={fields.confirmation ? 'confirmation-error' : undefined} /><FieldError id="confirmation-error" message={fields.confirmation} /></div>}
        <div aria-live="polite" aria-atomic="true">{(error || fields.token) && <p className="form-error" role="alert">{error || fields.token}</p>}</div>
        <button className="button button-primary auth-submit" disabled={pending || ((mode === 'login' || mode === 'register') && auth.loading) || (mode === 'reset' && !token)} type="submit">{pending ? 'Wird verarbeitet …' : (mode === 'login' || mode === 'register') && auth.loading ? 'Sitzung wird geprüft …' : info.submit}<span aria-hidden="true">→</span></button>
        {mode === 'reset' && !token && <p className="form-error">Der Link enthält kein Token. <Link to="/passwort-vergessen">Neuen Link anfordern</Link></p>}
      </form>}
      <div className="auth-links">{mode === 'login' ? <>Noch kein Konto? <Link to="/registrieren">Jetzt registrieren</Link></> : mode === 'register' ? <>Bereits registriert? <Link to="/anmelden">Anmelden</Link></> : <Link to="/anmelden">Zurück zur Anmeldung</Link>}</div>
      <p className="auth-note">Transparente Übersicht. Keine Anlageempfehlung.</p>
    </section>
  </div>;
}
function FieldError({ id, message }: { id: string; message?: string }) { return message ? <small id={id} className="field-error" aria-live="polite">{message}</small> : null; }
export function LoginPage() { return <AuthPage mode="login" />; }
export function RegisterPage() { return <AuthPage mode="register" />; }
export function ForgotPasswordPage() { return <AuthPage mode="forgot" />; }
export function ResetPasswordPage() { return <AuthPage mode="reset" />; }
