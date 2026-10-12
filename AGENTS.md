# AGENTS.md – Aktien-Tracker

Anweisungen für Codex-Agenten (`gpt-6.1-sol`) in diesem Projekt. Du wirst von Claude beauftragt. Claude koordiniert mehrere Agenten, die gleichzeitig an verschiedenen Teilen arbeiten.

## Arbeitsweise

- Bearbeite nur die Dateien und Ordner, die in deiner Anweisung genannt sind. Andere Agenten arbeiten parallel an anderen Teilen.
- Brauchst du eine Änderung außerhalb deines Bereichs, mach sie nicht, sondern nenne sie in deiner Abschlussmeldung.
- Halte dich an den bestehenden Stil und die Struktur des Codes.
- Prüfe deine Arbeit mit dem Prüfbefehl aus der Anweisung (oder den Tests unten) und behebe Fehler, die du selbst verursacht hast.
- Keine Commits, keine Pushes und keine neuen Abhängigkeiten ohne ausdrücklichen Auftrag.
- Lösche keine Dateien, die du nicht selbst angelegt hast.

## Abschlussmeldung

Beende deine Arbeit mit einer kurzen Zusammenfassung:

- geänderte oder neue Dateien
- Ergebnis der Prüfung (z. B. Tests grün oder welche fehlschlagen)
- offene Punkte oder Fragen an Claude

## Projekt

<!-- Ergänze hier: Build- und Testbefehle, Konventionen, Ordner, die nicht verändert werden dürfen. -->

Stack: Node 24 + TypeScript, Express 5 (server/), node:sqlite, React 19 + Vite 8 + react-router 7 + Recharts (src/), Vitest + Supertest, zod.
- Gemeinsame Verträge: `shared/types.ts`, `shared/api.ts` – nur lesen, nicht ändern (Änderungswünsche in der Abschlussmeldung nennen).
- Portfolio-Logik: `shared/portfolio/` (reine Funktionen).
- Prüfbefehle: `npm test` (Vitest), `npm run typecheck` (tsc), `npm run build`.
- Imports aus shared im Client über `@shared/...`, im Server über relative Pfade (`../shared/...`).
- Abhängigkeiten sind installiert; es gibt keinen Netzwerkzugang zum Nachinstallieren.
- UI-Texte auf Deutsch, Zahlen/Datum im deutschen Format (Intl, Locale "de-DE").

## Wenn deine Anweisung mit [Planung beginnt

Dann bist du der **Planungsagent**. Du berätst Claude nur bei der Planung:

- Ändere keine Dateien und führe nichts aus außer Lesen (Dateien ansehen, suchen), um den Plan zu beurteilen.
- Prüfe keine Ergebnisse und setze nichts um.
- Antworte knapp (höchstens etwa 300 Wörter) in diesem Aufbau:
  1. **Einschätzung:** Passt der Plan zum Auftrag?
  2. **Verbesserungsvorschläge:** nummeriert, zu allen Themen, die zählen (Aufteilung, Architektur, Benutzerführung, Sicherheit, Tests, Betrieb, Aufwand).
  3. **Hinterfragt:** Entscheidungen von Claude, die du anders treffen würdest, mit Begründung. Hat Claude einen deiner Vorschläge abgelehnt, sag, ob dich die Begründung überzeugt.
  4. **Risiken und offene Fragen.**
