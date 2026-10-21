# 🎤 Duett-Karaoke (Version 2)

**Mac = Hauptbildschirm und Musik. Handys = Mikrofone.**

- Der Mac erstellt den Raum und zeigt einen QR-Code. Er spielt die Musik (Spotify Web Player im Browser) und zeigt Text, Tonhöhen-Balken und Punktestand aller.
- Die Handys scannen den QR-Code, geben ihren Namen ein und wählen ihr Mikro. Sie schicken nur die Tonhöhe.
- Auf dem Mac ordnest du jedes Handy einem Sänger zu (Mann, Frau, Zuschauer). Wer ins Mikro spricht, dessen Pegelbalken schlägt aus, so erkennst du das Gerät.

## Update einspielen (wenn Version 1 schon läuft)

1. ZIP entpacken.
2. GitHub-Repository öffnen → **Add file → Upload files**.
3. Diese Dateien und den Ordner `public` hineinziehen (überschreibt die alten): `server.js`, `package.json`, `package-lock.json`, `render.yaml`, `README.md`, Ordner `public`.
4. **Commit changes**. Render baut automatisch neu (ca. 1–2 Minuten, Status „Live" abwarten).
5. Die Spotify-App im Dashboard bleibt unverändert (Redirect-URI weiter `https://DEINE-ADRESSE.onrender.com/`).

## Erstes Einrichten (falls noch nichts läuft)

1. GitHub-Repository mit diesen Dateien, auf render.com **New → Web Service** (Build `npm install`, Start `npm start`, Free).
2. developer.spotify.com/dashboard → **Create app**, Redirect URI `https://DEINE-ADRESSE.onrender.com/` (mit `/` am Ende), **Web API** ankreuzen.
3. Client-ID kopieren. Entweder in Render unter **Environment** als `SPOTIFY_CLIENT_ID` setzen oder beim ersten Start am Mac eintragen.

## Ablauf am Abend

1. **Mac:** Safari oder Chrome, Adresse öffnen → **Raum erstellen** → bei Spotify einloggen (Premium). Beim ersten Mal nach dem Update einmal neu einloggen, weil der Web Player neue Rechte braucht.
2. **Mac:** Bluetooth-Box koppeln und in der Menüleiste unter **Ton** als Ausgabe wählen. Die Musik läuft im Browser-Tab, der Tab muss offen bleiben.
3. **Handys:** QR-Code scannen, Namen eingeben, unten **Mikro aktivieren**. Das Handy zeigt dann den Liedtext groß im Spotify-Stil (aktive Zeile färbt sich mit, deine Zeilen sind markiert). Mikro-Auswahl, Empfindlichkeit, Kalibrieren, Namen ändern und Raum verlassen stecken hinter dem Zahnrad oben rechts.
4. **Mac:** Geräte zuordnen (Mann/Frau).
5. **Mac:** Song suchen und antippen, Aufteilung wählen (alle beide / abwechselnd / strophenweise / Duett aus Notendatei, oder Zeilen einzeln antippen), **Los!**
6. Am Ende kommt die Rangliste. **Nächster Song** geht zurück in die Lobby.

Während des Songs: Pause (Leertaste), Von vorn, Text-Versatz und Noten-Versatz mit −/+ (Bluetooth-Boxen sind meist 0,1–0,3 s verzögert, dann Text-Versatz auf +0,2 s).

## Tonhöhen-Balken und Noten

- **Immer:** Jeder Sänger hat eine eigene Spur. Die gesungene Tonhöhe läuft als Linie mit, mit Notenname (z. B. A3).
- **Soll-Balken:** nur wenn für den Song Noten vorliegen. Spotify gibt weder Audio noch Noten heraus, deshalb gibt es für beliebige Songs keine automatische Quelle. Unterstützt werden Notendateien im **UltraStar-Format** (`.txt`).
- **Bibliothek:** Im Lobby-Fenster unter **Noten-Bibliothek** einmal einen ganzen Ordner mit solchen Dateien hineinziehen oder wählen. Die App erkennt Songs dann automatisch am Titel und Interpreten, gleicht die Zeiten mit dem Text ab und zeigt die Balken. In der Suche steht dann „Noten" am Song. Die Bibliothek bleibt in diesem Browser gespeichert (auf dem Mac, den du nutzt).
- Für einen einzelnen Song kannst du im Bereit-Fenster auch eine Datei direkt wählen. Stimmt das Timing nicht ganz, hilft der Noten-Feinabgleich.
- Ohne Noten zählt „Singen" (Mikro über der Schwelle) in den Zeilen, die dir zugeteilt sind. Mit Noten zählt, wenn du den Ton triffst (±1,5 Halbtöne, Oktave egal), goldene Noten doppelt. **Das ist die vorläufige Wertung**, das Modell passen wir später an.

## Tipps und Grenzen

- Handy nah an den Mund halten und einmal **Kalibrieren** (2,5 s nicht singen, Musik läuft). Die Box im Hintergrund stört sonst. Mit Kopfhörern klappt es am besten.
- Der Original-Gesang aus der Box kann die Tonhöhenerkennung verwirren, wenn jemand sehr leise singt. Lautere Box-Musik braucht eine höhere Empfindlichkeit-Einstellung.
- Handys sollten den Bildschirm anlassen (die App hält ihn wach), sonst bricht die Mikro-Übertragung ab.
- Render (Free) schläft nach ca. 15 Minuten ohne Besuch ein. Vor dem Abend einmal die Seite öffnen. Räume gehen beim Neustart des Servers verloren.
- Mac-Alternative zum Web Player: Auf dem Mac in der Lobby „Stattdessen Spotify-App verwenden" wählen (Spotify-App öffnen, einen Song antippen, Gerät wählen).

## Dateien

- `server.js` Server: Räume, Sync, Weiterleitung der Tonhöhen, Text-Suche (LRCLIB)
- `public/display.html` Mac-Bildschirm
- `public/phone.html` Handy-Mikro
- `public/index.html` Startseite (leitet auch den Spotify-Login weiter)
- `public/pitch.js` Tonhöhen-Erkennung, `public/ultrastar.js` Notendateien, `public/spotify.js` Spotify, `public/common.js` Verbindung
- `render.yaml` Konfiguration für Render
