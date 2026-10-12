# Aktien-Tracker

Responsive Web-App, mit der private Nutzer Aktien beobachten, ihr Portfolio verwalten und dessen Entwicklung nachvollziehen. Eine Codebasis für Smartphone, Tablet und Desktop. Oberfläche auf Deutsch, Basiswährung standardmäßig EUR.

Die App dient dem **Tracking**, nicht dem Handel. Sie berechnet keine Steuern und gibt keine Kauf- oder Verkaufsempfehlungen.

## Schnellstart

Voraussetzung: **Node.js 22.13 oder neuer** (empfohlen: 24). Eine Datenbank müssen Sie lokal nicht installieren: Ohne `DATABASE_URL` nutzt die App PGlite, ein vollwertiges PostgreSQL, das im Node-Prozess läuft und unter `data/pglite/` speichert. In Produktion verbindet sie sich über `DATABASE_URL` mit einem PostgreSQL-Server.

```bash
npm install
cp .env.example .env      # optional – ohne .env läuft die App im Demo-Modus
npm run dev               # startet API (Port 3001) und Oberfläche (Port 5173)
```

Danach im Browser **http://localhost:5173** öffnen, ein Konto registrieren und loslegen.

| Befehl | Zweck |
|---|---|
| `npm run dev` | Entwicklung: API-Server und Vite-Dev-Server mit Hot Reload |
| `npm test` | Alle Tests (Vitest) |
| `npm run typecheck` | TypeScript-Prüfung |
| `npm run build` | Typprüfung, Produktions-Build der Oberfläche nach `dist/` und des Servers nach `dist-server/` |
| `npm start` | Produktion: startet den gebauten Server (Port 3001), der API und Oberfläche ausliefert; vorher `npm run build` |

## Betriebsmodi

| Dienst | Nicht konfiguriert (Standard) | Konfiguriert |
|---|---|---|
| Marktdaten | **Demo-Modus**: erzeugte Beispielkurse, dauerhaft gekennzeichnet als „Demo – keine echten Marktdaten“ | Twelve Data über `TWELVE_DATA_API_KEY` |
| E-Mail (Passwort-Reset) | **Lokaler Modus**: der Reset-Link erscheint nur in der Server-Konsole; die Oberfläche weist darauf hin | SMTP über `SMTP_*` |

Demo- und echte Daten werden nie vermischt: Für jeden Marktdaten-Modus gibt es ein eigenes PostgreSQL-Schema (`demo` bzw. `live`). Konten, Transaktionen, Watchlists und Alarme aus dem Demo-Modus tauchen im echten Modus nicht auf.

> Hinweis zur Umstellung: Frühere Versionen speicherten in `data/demo.sqlite` bzw. `data/live.sqlite`. Diese Dateien werden nicht mehr gelesen und nicht automatisch übernommen.

Die Anmeldung ist in beiden Modi echt (gehashte Passwörter, serverseitige Sessions). Es gibt keine simulierte Anmeldung.

### Echte Marktdaten einrichten

1. Kostenlosen API-Schlüssel bei [Twelve Data](https://twelvedata.com) anlegen.
2. In `.env` eintragen: `TWELVE_DATA_API_KEY=...`
3. Server neu starten. Das Demo-Banner verschwindet, Kurse zeigen „Twelve Data“ als Quelle.

Der Schlüssel bleibt auf dem Server; der Browser spricht nur mit der eigenen API. Der kostenlose Tarif ist begrenzt (derzeit 8 Anfragen pro Minute, 800 pro Tag). Deshalb cacht der Server Kurse (Standard 5 Min.), Kursverläufe (1 Std.) und Suchergebnisse (24 Std.); die Werte lassen sich über `*_CACHE_TTL_SECONDS` anpassen. Die Oberfläche aktualisiert Kurse höchstens alle 5 Minuten. Je nach Börse und Tarif sind Kurse verzögert; das wird bei jeder Kursangabe angezeigt.

### E-Mail-Versand einrichten

`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD` und `SMTP_FROM` in `.env` setzen und `APP_URL` auf die öffentliche Adresse der App stellen (für den Link in der Reset-E-Mail).

## Veröffentlichen auf Render

Betrieb: **Render** (Web-Service, Frankfurt) + **Supabase** (PostgreSQL, Frankfurt) + **Resend** (E-Mail per SMTP). Die Konfiguration steht im Render-Blueprint `render.yaml`.

**Einmalig vorbereiten**

- *Supabase:* Projekt anlegen (Region `eu-central-1`). Als `DATABASE_URL` die **Session-Pooler**-Verbindung verwenden (Dashboard → Connect → Session pooler, Port 5432): Sie ist per IPv4 erreichbar. Nicht den Transaction-Pooler (Port 6543) nutzen – die App setzt das Schema (`demo`/`live`) pro Verbindung, das ginge dort verloren.
- *Resend:* Domain unter **Domains** hinzufügen und die angezeigten DNS-Einträge (SPF/DKIM) beim Domain-Anbieter setzen, bis sie als *Verified* erscheint. Dann unter **API Keys** einen Schlüssel mit „Sending access“ anlegen. Ohne verifizierte Domain stellt Resend nur an die eigene Konto-Adresse zu.

**Deployment**

1. Im Render-Dashboard **New → Blueprint** wählen und dieses GitHub-Repository verbinden (bei privaten Repos Render den Zugriff in GitHub erlauben).
2. Render fragt die geheimen Werte ab: `DATABASE_URL` (Supabase), `TWELVE_DATA_API_KEY` (leer = Demo-Modus), `SMTP_PASSWORD` (Resend-API-Schlüssel) und `SMTP_FROM` (z. B. `Aktien-Tracker <noreply@deine-domain.de>`). Sie werden nur bei Render gespeichert, nie im Repository.
3. **Apply** klicken. Render installiert, baut (`npm ci --include=dev && npm run build`), startet den gebauten Server (`node dist-server/index.js`) und prüft `/api/status`. Beim ersten Start legt die App ihre Tabellen in Supabase an. Jeder Push auf den Hauptzweig löst danach automatisch ein neues Deployment aus.

Die öffentliche Adresse (`https://….onrender.com`) wird automatisch als `APP_URL` für Reset-Links verwendet (`RENDER_EXTERNAL_URL`); eine eigene Domain kann über `APP_URL` gesetzt werden. `TRUST_PROXY=1` sorgt dafür, dass die Ratenbegrenzung hinter dem Render-Proxy die echte Client-IP sieht. Schlägt der Mailversand fehl, antwortet die App trotzdem normal und protokolliert den Fehler im Render-Log.

**Pläne und Kosten** – alles auf den kostenlosen Plänen möglich, mit diesen Einschränkungen:

- Render `free`: schläft nach 15 Minuten ohne Zugriffe ein (Aufwachen ca. 1 Minute). Ausgehend sind die SMTP-Ports 25/465/587 gesperrt; Resend wird daher über Port **2587** (STARTTLS) angesprochen.
- Supabase Free: 500 MB Datenbank; das Projekt **pausiert nach 7 Tagen ohne Datenbankzugriffe**. Die Daten bleiben erhalten, das Projekt muss dann im Supabase-Dashboard wieder gestartet werden.
- Resend Free: 100 E-Mails pro Tag, 3.000 pro Monat.

## Tech-Stack und Begründung

Es gab keinen vorgegebenen Stack. Gewählt wurde ein verbreiteter, gut wartbarer TypeScript-Stack mit möglichst wenigen beweglichen Teilen:

- **TypeScript durchgängig**: Client und Server teilen sich Typen, API-Vertrag und Portfolio-Logik (`shared/`). Das verhindert, dass Berechnungen oder Validierung auseinanderlaufen.
- **React + Vite** für die Oberfläche: verbreitet, schnell, einfach auf PWA erweiterbar. **Recharts** für Diagramme, eigenes CSS mit Custom Properties für hell/dunkel.
- **Express** als API-Server: bewährt, minimal, leicht testbar (Supertest).
- **PostgreSQL** (`pg`) für den Betrieb, **PGlite** lokal und in Tests: dieselbe SQL-Schicht und dieselben Migrationen überall, lokal trotzdem ohne Datenbank-Installation. Schreibende Abschnitte laufen in Transaktionen mit einer Sperre je Nutzer (`pg_advisory_xact_lock`), damit parallele Anfragen die Bestandsprüfung nicht umgehen.
- **Eigene Session-Authentifizierung** mit bewährten Bausteinen (scrypt, zufällige Session-Tokens, httpOnly-Cookies). Sie braucht keinen externen Dienst und funktioniert damit auch lokal vollständig.

## Projektstruktur

```
shared/            Gemeinsamer Code für Client und Server
  types.ts         Domänentypen (Vertrag)
  api.ts           HTTP-API-Vertrag: Endpunkte, Request/Response, Fehlerformat
  portfolio/       Portfolio-Berechnung und Transaktionsvalidierung (reine Funktionen + Tests)
server/            API-Server (Express)
  db/              PostgreSQL/PGlite-Anbindung, Schema, Migrationen, Repositories (jede Abfrage nach user_id gefiltert)
  auth/            Passwort-Hashing, Sessions, Passwort-Reset
  market/          Austauschbare Marktdaten-Schnittstelle: Demo, Twelve Data, Cache
  routes/          HTTP-Endpunkte
src/               Oberfläche (React)
  api/             Typisierter API-Client
  auth/            Anmeldezustand, geschützte Routen
  components/      Wiederverwendbare Bausteine (Kennzahlen, Listen, Diagramme, Formulare)
  pages/           Seiten
  styles/          CSS
public/            Web-App-Manifest und Icon (PWA-Vorbereitung)
data/              Lokale PGlite-Datenbank (nicht im Git)
render.yaml        Render-Blueprint für das Hosting
```

## So rechnet die App

Die Logik liegt in `shared/portfolio/` und ist durch Tests abgesichert. Dieselbe Validierung läuft im Browser (für schnelle Rückmeldung) und auf dem Server (verbindlich).

**Durchschnittskostenmethode** je Wertpapier, alle Beträge zunächst in der Handelswährung:

- **Kauf:** Stückzahl steigt, der Einstand steigt um *Stückzahl × Preis + Gebühren*. Ein Kauf verändert nie das Ergebnis; neu investiertes Geld erscheint deshalb nicht als Rendite.
- **Verkauf:** Es wird der anteilige Durchschnittseinstand ausgebucht. **Realisiertes Ergebnis** = *Stückzahl × Verkaufspreis − Gebühren − anteiliger Einstand*.
- **Unrealisiertes Ergebnis** = *aktueller Marktwert − Einstand der offenen Stücke*. Realisierte und unrealisierte Ergebnisse werden getrennt ausgewiesen.
- **Dividende:** *berechtigte Stück × Dividende je Aktie − Abzüge* (z. B. Quellensteuer, wie vom Nutzer eingegeben). Dividenden ändern weder Stückzahl noch Einstand und werden getrennt von Kursergebnissen ausgewiesen. Eine Dividende setzt einen vorherigen Kauf voraus.
- **Split / Zusammenlegung:** Die Stückzahl wird mit dem Verhältnis *neu : alt* multipliziert (4 : 1 → ×4, 1 : 10 → ×0,1), der Einstand bleibt gleich, der Durchschnittskurs sinkt bzw. steigt entsprechend. Ein Split setzt einen Bestand voraus.
- **Tagesveränderung** = *Stückzahl × (letzter Kurs − Vortagesschluss)*.
- **Reihenfolge am selben Tag:** Split, Kauf, Dividende, Verkauf. Ein Verkauf darf den Bestand zu keinem Zeitpunkt übersteigen; das wird auch beim Bearbeiten, Löschen und Importieren geprüft.
- **Bruchstücke** sind erlaubt (bis 8 Nachkommastellen). Intern wird nicht zwischengerundet.

**Währungen:** Beträge in verschiedenen Währungen werden nie ohne Umrechnung addiert. Der Einstand wird parallel in der Basiswährung geführt, und zwar zum **historischen Wechselkurs des jeweiligen Kauftags** (letzter verfügbarer Tageskurs am oder vor dem Datum). Realisierte Ergebnisse rechnen den Erlös zum Kurs des Verkaufstags um, Dividenden zum Kurs des Dividendentags. Der Marktwert nutzt den aktuellen Wechselkurs. Der **Währungseffekt** (*Einstand in Handelswährung × aktueller Kurs − Einstand zu historischen Kursen*) wird als Anteil des unrealisierten Ergebnisses gesondert ausgewiesen. Fehlt ein aktueller oder historischer Wechselkurs, wird kein Ersatzkurs verwendet: Die betroffenen Werte bleiben leer, und die Oberfläche zeigt „Eingeschränkte Gesamtauswertung“ mit Begründung.

**Portfolioentwicklung:** Für jeden Handelstag im Zeitraum wird der damalige Bestand mit dem Schlusskurs und dem Wechselkurs dieses Tages bewertet; daneben steht das investierte Kapital zu historischen Kauf-Kursen. So ist sichtbar, welcher Anstieg aus Einzahlungen und welcher aus Kursbewegungen stammt. Kursreihen gelten als split-bereinigt; Bestände vor einem Split werden für die Bewertung mit dem Split-Verhältnis umgerechnet. Vor dem ersten verfügbaren Kurs eines Wertpapiers wird kein Wert erfunden.

**Kursalarme:** Pro Aktie lassen sich Alarme „Kurs steigt auf oder über“ bzw. „fällt auf oder unter“ einen Zielkurs anlegen (höchstens 100). Der Server prüft aktive Alarme, sobald die Alarmliste abgerufen wird (Dashboard, Alarmseite, Detailansicht), gegen die gecachten aktuellen Kurse. Ein ausgelöster Alarm bleibt mit Zeitpunkt und Kurs gespeichert, bis er reaktiviert oder gelöscht wird. Es gibt bewusst keinen Hintergrundabruf, damit das API-Kontingent geschont wird, und keine Push- oder E-Mail-Benachrichtigung.

**CSV-Import:** Importiert wird das Format des CSV-Exports (Semikolon, deutsches Datum und Dezimalkomma; ältere Exporte ohne Spalte „Verhältnis“ werden ebenfalls gelesen). Vor dem Import zeigt eine Vorschau gültige, fehlerhafte und doppelte Zeilen; Duplikate werden standardmäßig übersprungen. Der Import ist atomar: Verletzt eine Zeile die Bestandsprüfung, wird nichts gespeichert. Höchstens 2.000 Zeilen je Import.

## Getroffene Standardentscheidungen

- **Handelswährung = Währung des Wertpapiers.** Eine Transaktion in abweichender Währung wird abgelehnt; damit bleiben Einstand und Kurs vergleichbar.
- **Wertpapierkennung** ist `Symbol:MIC` (z. B. `SAP:XETR`), damit gleichnamige Wertpapiere an verschiedenen Börsen unterscheidbar bleiben.
- **„Heute“ beim Datum:** Der Server akzeptiert jedes Datum bis zum aktuellen Tag in der östlichsten Zeitzone, damit eine Buchung kurz nach Mitternacht nicht als „Zukunft“ abgelehnt wird.
- **Basiswährungen:** EUR (Standard), USD, CHF, GBP.
- **Doppelte Transaktionen:** Der Absenden-Button ist während der Anfrage gesperrt, zusätzlich trägt jedes Formular eine Kennung, die der Server nur einmal annimmt.
- **Sicherheit:** Passwörter mit scrypt gehasht; Sessions und Reset-Token werden nur als Hash gespeichert; Cookie httpOnly und SameSite=Lax; ändernde Anfragen brauchen einen eigenen Header (CSRF-Schutz); Anmelde-, Registrierungs- und Reset-Endpunkte sind ratenbegrenzt. Jede Datenbankabfrage auf Nutzerdaten filtert serverseitig nach der Nutzer-ID aus der Session; fremde Datensätze liefern 404.
- **PWA-Vorbereitung:** Web-App-Manifest und Icon sind eingebunden, eine Service-Worker-Registrierung liegt deaktiviert in `src/pwa.ts`.

## Funktionsstand

**Funktioniert (MVP):**

- Registrierung, Anmeldung, Abmeldung, Passwort zurücksetzen (per E-Mail oder im lokalen Modus über die Server-Konsole)
- Aktiensuche nach Name und Ticker mit Börsenplatz und Währung
- Watchlist: hinzufügen, entfernen, sortieren nach Name und Tagesveränderung
- Detailansicht mit Kurs, Kursverlauf (1W bis MAX), Basisinformationen, eigener Position und Transaktionen
- Transaktionen erfassen, bearbeiten, nach Bestätigung löschen; Prüfung auf ungültige Eingaben und Verkäufe über den Bestand
- Portfolio mit Positionen, realisierten und unrealisierten Ergebnissen, Portfolioanteilen und Mehrwährungsumrechnung
- Dashboard mit Kennzahlen, Portfolioentwicklung, Verteilung, Gewinnern und Verlierern, Watchlist-Vorschau, Einstiegsbildschirm bei leerem Portfolio
- Hell- und Dunkelmodus, Basiswährung wählbar, alles dauerhaft im Backend gespeichert und geräteübergreifend verfügbar
- Demo-Modus ohne API-Schlüssel, dauerhaft gekennzeichnet
- Dividenden sowie Splits und Zusammenlegungen als eigene Transaktionsarten
- Historische Wechselkurse für Einstand, realisierte Ergebnisse, Dividenden und Verlauf; Währungseffekt getrennt ausgewiesen
- CSV-Export und CSV-Import von Transaktionen mit Vorschau und Duplikaterkennung
- Kursalarme je Aktie mit Übersichtsseite (`/alarme`) und Hinweis im Dashboard

**Einzurichten für den echten Betrieb:**

- Twelve-Data-API-Schlüssel (`TWELVE_DATA_API_KEY`) für echte Kurse
- SMTP-Zugang (`SMTP_*`) und `APP_URL` für Passwort-Reset-E-Mails
- Hosting mit HTTPS (das Session-Cookie ist in Produktion nur über HTTPS gültig)

**Bekannte Einschränkungen:**

- Wechselkurse: Es werden Tagesschlusskurse verwendet, keine Kurse zum genauen Ausführungszeitpunkt. Der Währungseffekt wird nur für das unrealisierte Ergebnis getrennt ausgewiesen; realisierte Ergebnisse enthalten ihn ungetrennt.
- Dividenden werden in der Handelswährung des Wertpapiers erfasst; abweichende Auszahlungswährungen des Brokers sind nicht abbildbar. Kapitalmaßnahmen außer Splits (z. B. Spin-offs, Bezugsrechte) werden nicht unterstützt.
- Kursalarme werden nur beim Abruf geprüft (siehe oben); kurze Kursspitzen zwischen zwei Abrufen werden nicht erkannt.
- Die Tagesveränderung einer heute gekauften Position bezieht sich auf den Vortagesschluss, nicht auf den eigenen Kaufpreis.
- Kurse sind je nach Börse und Twelve-Data-Tarif verzögert; die App zeigt das an und behauptet keine Echtzeit. Nicht jede Börse und jedes Basisinformationsfeld ist im kostenlosen Tarif verfügbar; fehlende Angaben erscheinen als „Nicht verfügbar“.
- Bei vielen Positionen kann der kostenlose Twelve-Data-Tarif (8 Anfragen/Minute) beim ersten Laden des Kursverlaufs an seine Grenze stoßen; danach greift der Cache.
- Rate-Limits und Caches liegen im Arbeitsspeicher eines einzelnen Serverprozesses (nach einem Neustart oder Einschlafen auf dem Free-Plan sind sie leer). Für mehrere Instanzen wäre zusätzlich Redis o. ä. nötig; die Datenbank ist bereits mehrinstanzfähig.
- Bewusst später: Broker-Anbindungen, Nachrichten, Push- und E-Mail-Benachrichtigungen für Kursalarme, Offline-Betrieb (Service Worker).
