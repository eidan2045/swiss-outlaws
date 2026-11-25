# Swiss Outlaws

Eigenständiges Open-World-Actionspiel in einer komprimierten, fiktionalisierten Schweiz – spielbar im Browser, allein oder online mit Freunden.
Vertical Slice: eine von Zürich inspirierte Stadt am See, Limmat, Uetliberg, Autobahn mit Tunnel, ein Bergtal mit Dorf und eine Passstrasse mit Haarnadelkurven (ca. 9 km² Gelände, 54 km Strassen, ~1 960 Gebäude, ~30 000 Bäume).

Alle Inhalte (Gelände, Stadt, Fahrzeuge, Figuren, Texturen, Klänge, Musik) werden **prozedural im Code erzeugt**. Es gibt keine fremden Modelle, Texturen, Sounds oder Kartendaten – und damit keine Lizenzrisiken.

## Schnellstart

```bash
npm install
npm run dev            # Client auf http://localhost:5173 (Einzelspieler sofort spielbar)
npm run dev:server     # Spielserver auf ws://localhost:8787 (für Online-Modus: ?server=ws://localhost:8787)
```

Ohne Installation: `standalone/index.html` herunterladen und im Browser öffnen (eine einzige Datei, ~1 MB, läuft offline von der Festplatte). Der Online-Modus funktioniert auch dort, sobald im Menü eine Serveradresse eingetragen ist.

| Befehl | Zweck |
| --- | --- |
| `npm run build` | Client nach `dist/` (Vercel) |
| `npm run build:single` | Eine einzelne HTML-Datei nach `standalone/index.html` |
| `npm run build:server` | Server-Bundle `dist-server/server.mjs` |
| `npm start` | Server starten (liefert zusätzlich `dist/` aus) |
| `npm test` | Unit- und Server-Integrationstests (Vitest) |
| `npm run test:e2e` | Browser-Multiplayer-Test mit 4 Sessions, Latenz und Verbindungsabbruch (benötigt Playwright + Chromium) |
| `node tests/e2e/features.cjs` | Browser-Test: Sandbox-Aimbot/ESP, Outfit-Sync, Freunde (ID-Suche, Beitreten, Einladen), Auto-Rejoin |
| `npm run map` | Debug-Karte der generierten Welt als PNG |

## Steuerung

| Aktion | Tastatur & Maus | Xbox-Controller |
| --- | --- | --- |
| Bewegen / Lenken | W A S D | Linker Stick |
| Kamera | Maus | Rechter Stick |
| Sprinten · Springen · Ducken | Shift · Leertaste · C | A halten · X · Steuerkreuz ↓ |
| Zielen · Schiessen · Schlagen | RMB · LMB · Q | LT · RT · B |
| Ein-/Aussteigen, Interagieren | E | Y |
| Gas · Bremse · Handbremse | W · S · Leertaste | RT · LT · A/RB |
| Hupe · Licht · Sirene | H · L · G | L3 · Steuerkreuz → · ← |
| Karte · Pause · Chat | M · Esc · T | Ansicht · Menü · – |
| Aimbot · ESP (nur Sandbox) | Y · U | über Einstellungen |

Alle Menüs sind mit Tastatur, Maus und Controller bedienbar.

**Sandbox-Modus:** Aimbot (Stärke 1–5, optional Auto-Feuer) und ESP (rote Umrisse durch Wände) sind nur im Einzelspieler und in privaten Sandbox-Lobbys (*Online › Private Sandbox-Lobby*) verfügbar; der Server setzt das Sandbox-Flag nur für private Lobbys. Konfiguration unter *Einstellungen › Sandbox*.

**Fortsetzen:** Nach Reload, Tab-Schliessen oder Neustart tritt das Spiel automatisch der letzten Welt wieder bei (`?menu` öffnet stattdessen das Menü). Existiert die Lobby nach einem Server-Neustart nicht mehr im Speicher, wird sie unter demselben Code neu erstellt; sonst geht es mit dem gespeicherten Fortschritt (Position, Geld, Munition, Outfits, Einstellungen, Freunde) in einer neuen Welt weiter.

## Deployment

Das Frontend ist statisch (Vercel). Der Mehrspielermodus braucht einen dauerhaft laufenden Prozess mit WebSockets – das können Vercel-Functions nicht, deshalb läuft der Spielserver getrennt.

**Variante A – ein Dienst für alles (am einfachsten):** Render-Dashboard → *New → Blueprint* → dieses Repository wählen (`render.yaml`). Der Dienst baut Client und Server und liefert beides unter einer Adresse aus; dieser Link ist direkt der Spiel-Link für Freunde. Alternativ `Dockerfile` (Fly.io, Railway, eigener Server).

**Variante B – Vercel + Spielserver:**
1. Spielserver wie in Variante A starten und die Adresse notieren (z. B. `wss://swiss-outlaws.onrender.com`).
2. Vercel → *Add New Project* → dieses Repository importieren (`vercel.json` ist vorhanden).
3. In den Projekteinstellungen die Umgebungsvariable `VITE_SERVER_URL` auf die Serveradresse setzen und neu deployen.

Ohne `VITE_SERVER_URL` ist der Vercel-Link als Einzelspieler voll spielbar; die Serveradresse lässt sich dann im Spiel unter *Online spielen* eintragen oder per Link mitgeben: `https://…/?server=wss://…`. Freunde einladen: Pausenmenü → *Lobby* zeigt Code und Einladungslink (`?join=CODE`).

Kosten und Grenzen: Der kostenlose Render-Plan schläft nach 15 Minuten ohne Verkehr ein (erster Aufruf danach ~1 Minute) und hat kein dauerhaftes Dateisystem – Konten gehen bei einem Neu-Deploy verloren, solange kein persistentes Laufwerk (`DATA_DIR`) angehängt ist. Gemessen: ein Server-Tick mit 4 Spielern, 49 Fahrzeugen und 29 Passanten kostet rund 0,2 ms (Budget 16,7 ms); eine kleine Instanz reicht für mehrere Lobbys.

## Architektur

```
src/shared/   deterministischer Kern – läuft identisch im Browser und auf dem Server
  world/      Gelände (2-m-Höhenkarte), Strassengraph, Zonen, Gebäude, Collider
  sim/        Charakter- und Fahrzeugphysik, GameRoom, Verkehr, Passanten, Polizei, Missionen
  net/        Protokoll: binäre Inputs/Snapshots, JSON für alles andere
src/client/   Three.js-Renderer, Entities, Kamera, Eingabe, UI, Audio, Netz-Client
src/server/   HTTP + WebSocket, Konten (scrypt), Lobbys, Freunde, Persistenz
```

- **Engine:** Three.js (WebGL 2) mit TypeScript/Vite. Gewählt wegen kleinem Bundle (die ganze Anwendung ist < 1 MB), voller Kontrolle über prozedurale Geometrie und Shader und breiter Browser-Unterstützung inkl. Edge auf Xbox. Babylon.js bringt mehr Fertigbausteine mit (Physik, GUI), ist aber deutlich grösser; PlayCanvas ist editorzentriert und passt schlecht zu einer rein code-generierten Welt.
- **Server-Autorität:** Der `GameRoom` simuliert alles (Bewegung, Fahrphysik, Schaden, Geld, Missionen, Fahndung, Verkehr). Clients senden nur Eingaben. Dieselbe Sim läuft im Client als Prediction; Snapshots (20 Hz) werden per Reconciliation eingespielt, fremde Entities interpoliert. Interest Management: Fahrzeuge 300 m, Passanten 150 m.
- **Einzelspieler** nutzt denselben `GameRoom` im Browser (Loopback-Transport) – ein Codepfad für offline und online.
- **Physik:** eigenes 2.5D-Modell (Einspurmodell mit Lastverlagerung, Reibungskreis, Automatikgetriebe, gefederter Aufbau), bewusst ohne Überschläge.

## Stand, Tests und offene Punkte

Siehe [`docs/STATUS.md`](docs/STATUS.md) – dort stehen die tatsächlich durchgeführten Tests, bekannte Fehler, nicht umgesetzte Punkte und der nächste Entwicklungsauftrag.

## Xbox

Das Spiel ist eine Web-Anwendung. Es unterstützt Xbox-Controller über die Gamepad-API und sollte in Microsoft Edge auf der Xbox als **Browser-Spiel** laufen – das ist **kein natives Xbox-Spiel** und wurde auf Konsolen-Hardware nicht getestet. Eine native Version (Unreal Engine oder Unity) wäre ein eigenes Projekt; der deterministische Sim- und Netzwerkkern ist dafür als Referenz gedacht, nicht als portierbarer Code.

## Lizenzen

Eigener Code und alle prozeduralen Inhalte dieses Repositories. Abhängigkeiten: three (MIT), ws (MIT), Vite/Vitest/esbuild/TypeScript (MIT/Apache-2.0). Keine externen Assets, keine Geodaten. Ortsnamen sind real, die Geografie ist frei komprimiert.
