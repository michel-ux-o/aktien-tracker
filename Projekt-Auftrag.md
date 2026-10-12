Du bist ein erfahrener Full-Stack-Entwickler und UI/UX-Designer.
Entwickle einen modernen Aktientracker als responsive Web-App.

ZIEL
Die Anwendung soll privaten Nutzern ermöglichen, Aktien zu beobachten,
ihr Portfolio zu verwalten und dessen Entwicklung nachzuvollziehen.
Sie muss auf Smartphones, Tablets und Desktop-Rechnern gut bedienbar
sein. Verwende dafür eine gemeinsame Codebasis und ein responsives
Layout, keine getrennten Anwendungen.

Die Benutzeroberfläche soll auf Deutsch sein. Verwende deutsche
Zahlen- und Datumsformate sowie EUR als voreingestellte Basiswährung.
Die Anwendung dient dem Tracking, nicht dem tatsächlichen Aktienhandel.

1. DESIGN UND BENUTZERFÜHRUNG

Gestalte eine übersichtliche, hochwertige Finanz-App mit klarer
Typografie, großzügigen Abständen und einer gut erkennbaren
Informationshierarchie. Vermeide eine überladene Trading-Oberfläche.

Biete einen hellen und einen dunklen Modus an. Stelle Gewinne und
Verluste nicht ausschließlich über Farben dar, sondern zusätzlich
durch Vorzeichen und Beschriftungen.

Desktop:
Verwende eine linke Seitenleiste mit Dashboard, Portfolio, Watchlist
und Einstellungen. Platziere die Aktiensuche gut sichtbar im oberen
Bereich. Nutze den verfügbaren Platz für Kennzahlen, Diagramme und
übersichtliche Tabellen.

Smartphone:
Verwende eine untere Navigation mit den wichtigsten Bereichen.
Ordne Inhalte überwiegend einspaltig an. Wandle breite Tabellen in
gut lesbare Karten oder kompakte Listen um. Wichtige Funktionen
müssen ohne Hover und ohne horizontales Scrollen erreichbar sein.
Verwende ausreichend große Schaltflächen und Touch-Flächen.

Berücksichtige Tastaturbedienung, sichtbare Fokuszustände,
verständliche Formularbeschriftungen und gute Kontraste.
Prüfe die Darstellung insbesondere bei 360, 768 und 1440 Pixel Breite.

2. DASHBOARD

Zeige auf der Startseite die wichtigsten Informationen:
aktueller Portfoliowert, investiertes Kapital der offenen Positionen,
unrealisierter Gewinn oder Verlust sowie die Tagesveränderung,
sofern dafür passende Daten verfügbar sind.

Ergänze ein Diagramm zur Portfolioentwicklung mit auswählbaren
Zeiträumen. Stelle die Verteilung des Portfolios nach Positionen
übersichtlich dar. Zeige darunter die größten Gewinner und
Verlierer der gehaltenen Aktien sowie eine Watchlist-Vorschau.

Biete gut sichtbare Aktionen wie „Transaktion hinzufügen“ und
„Aktie suchen“ an.

Bei einem leeren Portfolio soll ein hilfreicher Einstiegsbildschirm
erscheinen, der erklärt, wie die erste Position angelegt wird.

3. AKTIENSUCHE, WATCHLIST UND DETAILANSICHT

Implementiere eine Suche nach Aktienname und Ticker.
Zeige bei Suchergebnissen auch Börsenplatz und Handelswährung,
damit ähnlich benannte Wertpapiere unterscheidbar sind.

Nutzer sollen Aktien zur Watchlist hinzufügen und daraus entfernen
können. Zeige je Aktie Name, Ticker, letzten verfügbaren Kurs,
Währung sowie absolute und prozentuale Tagesveränderung.

Die Watchlist soll nach Name und Tagesveränderung sortierbar sein.

Ein Klick auf eine Aktie öffnet eine Detailansicht mit Kurs,
Kursverlauf, verfügbaren Basisinformationen und den Aktionen
„Zur Watchlist hinzufügen“ sowie „Transaktion erfassen“.

Biete im Kursdiagramm verschiedene Zeiträume an, soweit die
Datenquelle diese unterstützt. Zeige fehlende Daten verständlich an,
statt Werte zu erfinden.

4. PORTFOLIO UND TRANSAKTIONEN

Nutzer sollen Käufe und Verkäufe manuell erfassen, bearbeiten und
nach einer Bestätigung löschen können.

Eine Transaktion enthält:
Aktie beziehungsweise Wertpapierkennung, Kauf oder Verkauf,
Datum, Stückzahl, Preis pro Aktie, Gebühren und Handelswährung.
Unterstütze auch Bruchstücke von Aktien.

Berechne Positionen aus den gespeicherten Transaktionen. Zeige
Stückzahl, durchschnittlichen Einstandskurs, aktuellen Marktwert,
Portfolioanteil und unrealisierten Gewinn oder Verlust.

Weise realisierte und unrealisierte Ergebnisse getrennt aus.
Dokumentiere die verwendete Berechnungsmethode verständlich.
Einzahlungen und neu erfasste Käufe dürfen nicht fälschlich als
Anlagerendite erscheinen.

Verhindere unzulässige Eingaben, beispielsweise negative Stückzahlen
oder Verkäufe über den vorhandenen Bestand hinaus.

Addiere unterschiedliche Währungen nicht ohne Umrechnung.
Zeige verwendete Wechselkurse und deren Datenstand an. Fehlen
Wechselkurse, kennzeichne die eingeschränkte Gesamtauswertung.

Die Anwendung soll keine Steuerberechnung und keine Kauf- oder
Verkaufsempfehlungen enthalten.

5. KURSDATEN UND TRANSPARENZ

Binde Marktdaten über eine austauschbare Schnittstelle an.
Zeige bei Kursangaben Datenquelle, letzten Aktualisierungszeitpunkt
und gegebenenfalls eine zeitliche Verzögerung an.

Berücksichtige API-Limits durch Caching und angemessene
Aktualisierungsintervalle. Halte geheime API-Schlüssel ausschließlich
auf der Serverseite.

Falls keine Marktdaten-Zugangsdaten vorliegen, implementiere einen
voll funktionsfähigen Demo-Modus mit Beispieldaten. Kennzeichne ihn
dauerhaft sichtbar als „Demo – keine echten Marktdaten“.

Vermische Demo-Daten nicht mit echten Nutzerdaten. Behaupte keine
Echtzeitversorgung, wenn die Datenquelle diese nicht bereitstellt.

6. BENUTZERKONTEN UND DATENSPEICHERUNG

Implementiere Registrierung, Anmeldung, Abmeldung und eine Funktion
zum Zurücksetzen des Passworts über eine geeignete
Authentifizierungslösung.

Speichere Portfolio, Transaktionen, Watchlist und Einstellungen
dauerhaft im Backend. Nach der Anmeldung sollen dieselben Daten
auf Smartphone und Desktop verfügbar sein.

Stelle serverseitig sicher, dass jeder Nutzer ausschließlich auf
seine eigenen Daten zugreifen kann. Eine Filterung im Frontend
allein reicht dafür nicht aus.

Falls externe Dienste noch nicht konfiguriert sind, ermögliche
einen separat gekennzeichneten lokalen Demo-Modus. Simuliere
keine vermeintlich sichere Anmeldung.

7. TECHNISCHE UMSETZUNG UND QUALITÄT

Nutze den vorhandenen Tech-Stack. Falls keiner vorgegeben ist,
wähle einen verbreiteten, wartbaren Stack und begründe die Wahl kurz.

Trenne Benutzeroberfläche, Datenzugriff, Authentifizierung und
Portfolio-Berechnungen sauber voneinander. Verwende wiederverwendbare
Komponenten für Kennzahlen, Aktienlisten, Diagramme und Formulare.

Berücksichtige Ladezustände, leere Ansichten, Netzwerkfehler,
ungültige Eingaben und fehlende Kursdaten. Verhindere doppelte
Transaktionen durch mehrfaches Absenden eines Formulars.

Ergänze Tests für Portfolio-Berechnungen, Transaktionsvalidierung
und den Zugriffsschutz auf Nutzerdaten.

Bereite die Architektur so vor, dass die Web-App später als
Progressive Web App installierbar gemacht werden kann.

8. ERGEBNIS UND UMFANG

Erstelle zunächst ein lauffähiges MVP mit den oben beschriebenen
Kernfunktionen, nicht nur einen Designentwurf oder statische Screens.

Alle sichtbaren Schaltflächen und Formulare der Kernfunktionen
müssen funktionieren. Verschiebe Zusatzfunktionen wie Kursalarme,
Broker-Anbindungen, Nachrichtenfeeds und Push-Benachrichtigungen
auf eine spätere Ausbaustufe.

Liefere den Quellcode, die Projektstruktur, eine verständliche
Startanleitung sowie eine Beispieldatei für benötigte
Umgebungsvariablen ohne echte Zugangsdaten.

Beschreibe abschließend, welche Funktionen bereits funktionieren,
welche externen Dienste eingerichtet werden müssen und welche
Einschränkungen bestehen.

Triff bei offenen Gestaltungsfragen sinnvolle Standardentscheidungen
und dokumentiere sie kurz. Priorisiere Bedienbarkeit, korrekte
Berechnungen und zuverlässige Datenspeicherung vor dekorativen
Effekten.