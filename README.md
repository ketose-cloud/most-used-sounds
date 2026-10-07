# Most Used Sounds

Durchsucht deine **FL Studio** (`.flp`) und **Ableton Live** (`.als`) Projekte, findet die Sounds, die du am häufigsten benutzt, und packt sie als Drum-Pack in eine ZIP-Datei.

- Läuft komplett im Browser. Es wird nichts hochgeladen, es gibt keinen Server.
- Ordner reinziehen → Scannen → Pack herunterladen.
- Wenige Einstellungen: Zeitraum (alles / 12 Monate / einzelne Jahre), Sounds pro Kategorie, nur Drums, Pack-Name.
- In Chrome, Edge, Arc und Brave merkt sich die App deine Ordner. Für ein neues Pack reicht dann ein Klick auf **Neu scannen**.

## So funktioniert's

1. **Projekte lesen.** `.als` ist gzip-komprimiertes XML: jede `<SampleRef>` ist ein benutzter Sound (Audio-Clips, Simpler, Sampler, Drum Racks). `.flp` ist ein binärer Event-Stream: Event 196 ist der Sample-Pfad eines Sampler-Kanals oder Audio-Clips.
2. **Zählen.** Ein Sound ist ein Dateiname. Gerankt wird danach, in wie vielen Projekten ein Sound vorkommt, danach nach der Gesamtzahl der Verwendungen. Backups, Autosaves, Aufnahmen und Freeze- bzw. Bounce-Dateien werden ignoriert.
3. **Einsortieren.** Die Kategorie (Kick, Snare, Clap, Hi-Hat, Open Hat, Cymbal, Perc, 808, FX, Vocal, Loop) kommt aus dem Dateinamen, sonst aus dem Ordnernamen.
4. **Finden und packen.** Die Projekte speichern nur Pfade. Deshalb wird jeder Sound in den Ordnern gesucht, die du hinzugefügt hast. Bei mehreren Treffern gewinnt die Datei, deren Ordner am besten zum gespeicherten Pfad passen. Das ZIP enthält `01 Kicks/01 …wav` usw. und eine `Most Used Sounds.txt` mit der Rangliste.

**Tipp:** Füge den Projektordner *und* deine Sample-Ordner hinzu, oder einfach einen Ordner, der alles enthält (z. B. `Musik`). FL-Studio-Factory-Samples liegen im Programmordner (`…/Image-Line/FL Studio/Data/Patches/Packs`). Chrome lässt diesen Ordner nicht über den normalen Dialog zu, deshalb gibt es dafür den Link **Geschützten Ordner wählen**.

**Grenzen:** Samples, die nur in Plugin-Daten stecken (z. B. FPC, Slicex, DirectWave in FL Studio), stehen nicht als normaler Pfad in der Datei und werden deshalb nicht erkannt.

## Lokal starten

```bash
npm start      # http://localhost:5173 (braucht nur Python)
npm test       # Parser-, Ranking- und ZIP-Tests (Node 20+)
```

Es gibt keinen Build-Schritt und keine Abhängigkeiten. Das Projekt besteht nur aus HTML, CSS und ES-Modulen.

## Kostenlos online stellen

Die App besteht nur aus statischen Dateien, Hosting kostet also nichts:

- **GitHub Pages:** Der Workflow `.github/workflows/pages.yml` testet und deployt bei jedem Push auf `main`. Einmalig unter *Settings → Pages → Source* „GitHub Actions“ auswählen. Bei einem privaten Repo braucht Pages einen bezahlten GitHub-Plan; dann das Repo öffentlich machen oder eine der folgenden Optionen nehmen.
- **Cloudflare Pages / Netlify / Vercel:** Repo verbinden, Build-Befehl leer lassen, Ausgabeordner `/`. Auch für private Repos kostenlos.
- Eine eigene Domain kann man bei allen dreien kostenlos verbinden.
