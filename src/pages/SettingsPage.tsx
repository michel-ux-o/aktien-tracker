import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { SUPPORTED_BASE_CURRENCIES } from "@shared/types";
import type { ThemePreference } from "@shared/types";
import { useAuth } from "../auth/AuthContext";
import { ErrorState } from "../components/ErrorState";
import { LoadingState } from "../components/LoadingState";

const themes: { value: ThemePreference; label: string; description: string }[] = [
  { value: "system", label: "System", description: "Folgt deinem Gerät" },
  { value: "light", label: "Hell", description: "Helle Darstellung" },
  { value: "dark", label: "Dunkel", description: "Dunkle Darstellung" },
];

export function SettingsPage() {
  const { user, settings, settingsError, status, statusError, refresh, refreshStatus, updateSettings, logout } = useAuth();
  const navigate = useNavigate();
  const [baseCurrency, setBaseCurrency] = useState(settings?.baseCurrency ?? "EUR");
  const [theme, setTheme] = useState<ThemePreference>(settings?.theme ?? "system");
  const [saving, setSaving] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [logoutError, setLogoutError] = useState<unknown>(null);
  const [success, setSuccess] = useState("");

  useEffect(() => {
    if (settings) {
      setBaseCurrency(settings.baseCurrency);
      setTheme(settings.theme);
    }
  }, [settings?.baseCurrency, settings?.theme]);

  async function savePreferences(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    setSuccess("");
    try {
      await updateSettings({ baseCurrency, theme });
      setSuccess("Deine Einstellungen wurden gespeichert.");
    } catch (error) {
      setSaveError(error);
    } finally {
      setSaving(false);
    }
  }

  async function signOut() {
    if (loggingOut) return;
    setLoggingOut(true);
    setLogoutError(null);
    try {
      await logout();
      navigate("/anmelden", { replace: true });
    } catch (error) {
      setLogoutError(error);
    } finally {
      setLoggingOut(false);
    }
  }

  const changed = baseCurrency !== settings?.baseCurrency || theme !== settings?.theme;

  return (
    <div className="section-stack">
      <div className="page-heading"><div><p className="eyebrow">Ganz nach deinen Bedürfnissen</p><h1>Einstellungen</h1><p className="muted">Passe die Auswertung und Darstellung deines Aktien-Trackers an.</p></div></div>
      <div className="grid-two">
        <section className="card" aria-labelledby="preferences-heading">
          <h2 id="preferences-heading">Deine Darstellung</h2>
          {!settings && (settingsError != null ? <ErrorState error={settingsError} onRetry={() => void refresh()} /> : <LoadingState label="Einstellungen werden geladen" />)}
          <form className="section-stack" onSubmit={savePreferences}>
            <div className="field">
              <label htmlFor="base-currency">Basiswährung</label>
              <select id="base-currency" value={baseCurrency} onChange={(event) => { setBaseCurrency(event.target.value); setSuccess(""); }} disabled={saving || !settings} aria-describedby="currency-note">
                {SUPPORTED_BASE_CURRENCIES.map((currency) => <option key={currency} value={currency}>{currency === "EUR" ? "EUR · Euro" : currency === "USD" ? "USD · US-Dollar" : currency === "CHF" ? "CHF · Schweizer Franken" : "GBP · Britisches Pfund"}</option>)}
              </select>
              <p id="currency-note" className="muted">Gesamtwerte werden mit den verfügbaren aktuellen Wechselkursen in dieser Währung angezeigt. Transaktionen bleiben in ihrer Handelswährung.</p>
            </div>
            <fieldset disabled={saving || !settings}>
              <legend>Darstellung</legend>
              <div className="theme-options">{themes.map((option) => <label key={option.value} className={`theme-option${theme === option.value ? " is-selected" : ""}`}>
                <input type="radio" name="theme" value={option.value} checked={theme === option.value} onChange={() => { setTheme(option.value); setSuccess(""); }} />
                <span><strong>{option.label}</strong><span className="muted">{option.description}</span></span>
              </label>)}</div>
            </fieldset>
            {saveError != null && <ErrorState error={saveError} onRetry={() => void savePreferences()} />}
            <p className="muted" aria-live="polite" role="status">{success}</p>
            <div className="actions"><button type="submit" className="button button-primary" disabled={saving || !settings || !changed}>{saving ? "Wird gespeichert …" : "Einstellungen speichern"}</button></div>
          </form>
        </section>

        <div className="section-stack">
          <section className="card" aria-labelledby="account-heading">
            <h2 id="account-heading">Dein Konto</h2>
            <dl className="definition-list"><dt>E-Mail-Adresse</dt><dd>{user?.email ?? "Nicht verfügbar"}</dd></dl>
            {logoutError != null && <ErrorState error={logoutError} onRetry={signOut} />}
            <button type="button" className="button button-secondary" disabled={loggingOut} onClick={signOut}>{loggingOut ? "Wird abgemeldet …" : "Abmelden"}</button>
          </section>
          <section className="card" aria-labelledby="source-heading">
            <h2 id="source-heading">Datenquelle und Aktualität</h2>
            {status ? <>
              <dl className="definition-list"><dt>Quelle</dt><dd>{status.marketData.source}</dd><dt>Modus</dt><dd>{status.marketData.mode === "demo" ? "Demo – keine echten Marktdaten" : "Marktdaten vom Anbieter"}</dd></dl>
              <p className={status.marketData.mode === "demo" ? "notice notice-warning" : "muted"}>{status.marketData.mode === "demo" ? "Die angezeigten Kurse sind Beispieldaten und bilden keine tatsächliche Marktentwicklung ab." : status.marketData.delayNote ?? "Die Verzögerung der Marktdaten ist nicht bekannt."}</p>
              {status.marketData.mode === "demo" && status.marketData.delayNote && <p className="muted">{status.marketData.delayNote}</p>}
            </> : statusError != null ? <ErrorState error={statusError} onRetry={() => void refreshStatus()} /> : <p className="muted">Informationen zur Datenquelle sind derzeit nicht verfügbar.</p>}
            <p className="muted">Quelle, Datenstand und bekannte Verzögerungen stehen bei den jeweiligen Kursangaben. Kurse werden bei sichtbarer App in Abständen von fünf Minuten aktualisiert.</p>
          </section>
        </div>
      </div>
    </div>
  );
}

export default SettingsPage;
