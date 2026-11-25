# Swiss Outlaws – Projektstand und Übergabe

Stand: 25.11.2026 · Phase 1 (Vertical Slice) spielbar · Branch `claude/festive-clarke-f0dmh1`

Dieses Dokument ist die Übergabe für die nächste Entwicklungs-Session: was existiert, was wirklich getestet wurde, was fehlt.

## Was implementiert ist

**Welt** (`src/shared/world`, deterministisch aus Code): 3,07 × 3,07 km Höhenkarte in 2-m-Auflösung; Zürich-inspirierte Stadt (Altstadt beidseits der Limmat, Bahnhofstrasse-Quartier, Zürich-West mit Hochhäusern, Industrie, Wohnquartiere, Villen am Zürichberg), See mit Quai und Uferstrassen, Hauptbahnhof mit Gleisfeld, Hardbrücke, Uetliberg mit Höhenstrasse und Aussichtsturm, Autobahn A1 mit Tunnel, Bergtal mit Dorf Alpwil, Passstrasse mit 7 Haarnadelkurven als Rundkurs zurück in die Stadt. 254 Kreuzungen, 54 km Strassen, ~1 960 Gebäude (13 Typen inkl. Landmarken), ~30 000 Bäume.

**Grafik** (`src/client/render`): PBR-Materialien, Sonne/Mond mit Schatten, Tag-Nacht-Zyklus mit Sternen und prozeduralen Wolken, Bild-basiertes Umgebungslicht, Nebel, Wasser mit Fresnel/Glitzern/Ufer-Schaum, Bloom, Tone Mapping, MSAA/FXAA, Ambient Occlusion (nur Ultra), Regen/Schnee/Gewitter mit nassen Strassen und Schneedecke, beleuchtete Fenster und Strassenlampen bei Nacht, Fahrzeuglichter/Bremslichter/Blaulicht. Terrain-Chunks mit 4 LOD-Stufen, gestreamte Gebäude-Chunks, instanzierte Bäume mit 2 LODs. Grafikprofile Low/Medium/High/Ultra plus Auto.

**Charakter**: prozedural erzeugtes, geriggtes Skinned Mesh (17 Bones) mit Aussehens-Editor; Gehen, Joggen, Sprinten, Springen, Ducken, Schwimmen, Hochziehen an Kanten, Nahkampf, Zielen/Schiessen, Sturz/Knockdown. Gang-Zyklus ist an die Geschwindigkeit gekoppelt (Bein-IK, Fussaufsatz auf dem Gelände).

**Fahrzeuge**: 7 Typen (Kompaktwagen, Limousine, Sportwagen, Geländewagen, Lieferwagen, Polizei, Linienbus) mit eigenen Fahrwerten; Einspurmodell mit Lastverlagerung, Reibungskreis, Automatikgetriebe, Federung, Kollisionen, Schaden bis zum Wrack.

**Lebendige Welt** (serverseitig): Verkehr mit Spurführung, Ampeln, Abstandhalten; Passanten auf Trottoirs mit Flucht-/Schreckreaktionen; Dichte nach Quartier und Tageszeit; geparkte Autos zum Mitnehmen; 5-stufiges Fahndungssystem mit Verfolgung, Beamten zu Fuss, Verhaftung und Entkommen.

**Gameplay**: Koop-Story-Mission «Der Kurier», 2 Checkpoint-Rennen mit Medaillen, wiederholbare Lieferjobs, 20 versteckte Goldvreneli, Fahrzeughandel, Werkstatt, Fahrzeugzustellung, CHF, XP/Level, Statistik.

**Multiplayer**: autoritativer Node/WebSocket-Server; Konten (Registrierung, Login, Gast, Sitzungs-Token), Freundesliste mit Anfragen/Online-Status/Einladungen, öffentliche und private Lobbys mit Code und Einladungslink, Chat mit Blockieren/Melden, Reconnect mit Avatar-Erhalt (90 s), persistente Profile. Client Prediction, Reconciliation, Interpolation, Interest Management.

**UI/Audio**: Titel, Hauptmenü, Charakter-Editor, Online/Lobby/Freunde, HUD (Minimap mit GPS-Route, Leben, Ausdauer, Geld, Fahndung, Tacho, Missionsanzeige), Weltkarte mit Wegpunkten, Pausenmenü, Händler, Einstellungen; durchgehend mit Controller bedienbar. Audio vollständig synthetisiert (Motoren, Reifen, Hupe, Zweiklang-Sirene, Ambiente je Zone/Wetter, Schritte je Untergrund, Tunnelhall, generative Musik).

## Tatsächlich durchgeführte Tests

| Test | Ergebnis |
| --- | --- |
| `npm run typecheck` | ohne Fehler |
| Unit-Tests (9): Welt-Determinismus und Strassennetz-Zusammenhang, Charakterbewegung, Schwimmen, Fahrdynamik aller 6 kaufbaren/fahrbaren Typen, lebendige Welt, Fahrzeug nehmen + Fahndung + Verfolger, Anti-Cheat, Koop-Mission, Reconnect | 9/9 bestanden |
| Server-Integration (10): echter Serverprozess, 4 WebSocket-Clients – Konten, Passwort-Hashing, Lobby-Code, Synchronisation, Chat-Limit, Freunde/Einladung, Reconnect per Token, gefälschte Käufe, Flood-Schutz | 10/10 bestanden |
| Browser-E2E (17): 4 unabhängige Chromium-Sessions, eine hinter einem Proxy mit 120 ms ± 30 ms pro Richtung, Verbindungsabbruch | 17/17 bestanden – Details in `docs/test-results/e2e-multiplayer.json` |
| `standalone/index.html` direkt per `file://` | startet, spielbar, keine Konsolenfehler |
| Sichtprüfung per Screenshot | Titel, Menü, HUD, Stadt bei Tag und Nacht, Bergdorf, Tunnelportal, Fahrzeuge |

Messwerte: E2E gemessener Ping 308 ms; Vorhersage reagiert vor der Serverantwort (0,26 m nach 140 ms); Korrekturen bei der Reconciliation 0 m (identischer Sim-Code); Positionsfehler zwischen Clients nach Stillstand 0 m; Datenrate 26,6 kB/s pro Client. Server: 0,2 ms pro Tick bei 4 Spielern, 49 Fahrzeugen, 29 Passanten (Budget 16,7 ms). Weltgenerierung 2,7 s, Ladezeit bis spielbar ~8 s (headless), JS-Heap 140–190 MB.

## Was NICHT getestet oder nicht belegt ist

- **Framerate auf echter Hardware.** Diese Umgebung hat keine GPU; gerendert wurde nur per Software (SwiftShader, 1–30 s pro Bild). Ob 60 FPS erreicht werden, ist offen. Belegt sind nur Draw Calls und Dreiecke pro Profil (`docs/test-results/performance.json`).
- **Controller und Xbox.** Die Gamepad-Unterstützung ist implementiert, wurde aber weder mit einem physischen Controller noch in Edge auf einer Xbox ausprobiert.
- **Audio.** Der Code läuft fehlerfrei, angehört hat ihn niemand.
- **Deployment.** In dieser Session gab es keinen Zugang zu Vercel oder einem Server-Hoster; es existiert noch kein öffentlicher Link. Konfigurationen liegen bei (`vercel.json`, `render.yaml`, `Dockerfile`).
- Die Freundeslisten-Oberfläche und die Koop-Mission wurden auf Protokoll- bzw. Server-Ebene getestet, nicht als kompletter Durchlauf im Browser. Fahrzeug-Synchronisation zwischen Browsern ist nur über die Server-Tests abgedeckt.

## Bekannte Schwächen und Fehler

- Figuren und Fahrzeuge sind stilisiert-prozedural, keine Motion-Capture-Animationen, kein physikalisches Ragdoll (posenbasierter Sturz), keine Ein-/Aussteige-Animation (Scheiben sind undurchsichtig, die Figur verschwindet).
- Fahrzeuge können sich nicht überschlagen; Schäden sind nur als Zustand vorhanden, nicht sichtbar verformt; kein Reifenrauch, keine Bremsspuren.
- Verkehrs-KI ist einfach: kein Spurwechsel in der Stadt, an Kreuzungen ohne Ampel nur Verlangsamen; festgefahrene Fahrzeuge werden ausser Sicht entfernt. Passanten weichen einander nicht aus.
- Brücken sind physikalisch massive Dämme (kein Durchfahren darunter); das Wasser spiegelt nur den Himmel.
- Einzelne Strassenabschnitte am Zürichberg sind bis ~20 % steil; Häuserzeilen haben stellenweise Lücken.
- Kein Occlusion Culling über Frustum- und Distanz-Culling hinaus. Gemessen am Spawn: Low 396 Draw Calls / 0,37 Mio. Dreiecke, Medium 557 / 0,64 Mio., High 726 / 0,67 Mio., Ultra 2 023 / 1,5 Mio.
- Nummernschilder und Strassenschilder ohne Beschriftung.
- Konten: kein Passwort-Reset, keine E-Mail; Speicherung als JSON-Datei.

## Nicht umgesetzt (aus dem Gesamtauftrag)

Weitere Städte (Winterthur, Bern, Basel, Luzern, Genf), Matterhorn, Eisenbahnbetrieb, echte Geodaten (OSM/swisstopo), Motorräder, Lastwagen, Boote, Helikopter, Rettungsdienste, Fahrzeug-Tuning, Immobilien/Garagen, Kleidungsläden, weitere Story-Missionen, NPC-Tagesabläufe, Unfälle/Staus als Ereignisse, native Konsolenversion.

## Nächster Entwicklungsauftrag

1. **Deployen und mit vier Personen auf echter Hardware spielen**: Render-Blueprint starten, Vercel-Projekt mit `VITE_SERVER_URL` verbinden, FPS je Profil auf mindestens einer integrierten und einer dedizierten GPU messen, Profile und Sichtweiten danach einstellen.
2. **Spielgefühl aus dem Playtest nachschärfen**: Fahrverhalten je Fahrzeug, Kamera, Gang-Animation; sichtbare Fahrzeugschäden, Reifenrauch, Ein-/Aussteige-Animation.
3. **Verkehrs-KI robuster machen** (Vortritt, Ausweichen, Spurwechsel) und zweite Story-Mission als Koop-Verfolgungsjagd über den Pass.
4. Erst danach die Welt erweitern (Phase 3).

Einstieg für eine neue Session: `npm install && npm test`, dann `npm run dev` und `npm run dev:server`. Debug-Zugriff im Browser über `window.__dbg` (App, Engine, Welt, Netz, im Einzelspieler auch der `room`). URL-Parameter: `?play=1` (direkt ins Spiel), `?q=low|medium|high|ultra`, `?server=ws://…`, `?join=CODE`, `?lag=120&jitter=30&loss=2` (Netz-Simulation im Einzelspieler), `?norender=1` (für automatisierte Tests).
