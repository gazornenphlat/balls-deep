# Balls Deep — project memory

Running notes on decisions, state and next steps. Update this when something durable changes.

## Goal
USA football roster and playtime manager for one team. Runs as a Claude artifact and standalone web app now; Android (Capacitor) once the feature set is settled.

## Decisions
- One team / one roster only.
- Substitution suggestions are auto-ranked but the coach can always override manually.
- Quarters are configurable (e.g. 4 x 8–12 min).
- "Play clock" = quarter countdown (not the 25 s between-plays clock). Game clock keeps running independently.
- Game clock auto-pauses when the quarter timer reaches zero; coach presses play to resume.
- "Side of the ball" radio = the 4-way unit selector (Offense / Defense / Kickoff / Punt). Selecting one shows only that unit plus the bench. No auto-pause on unit switch.
- Bench = every active player not in the live unit.
- Up to 8 positions per player per unit, weight 1–5.
- App name: "Balls Deep". Inputs must be black text on a light background.
- Final score is entered when ending a game.
- Game report is a self-contained HTML file (opponent, date, score, time on field by unit, possession log, subs, player playtime).

## Done
Roster + CSV import/export, per-game active toggles, positions and weights, starting lineups, live game with clocks, real-time subs with suggestions, sub log + CSV export, possession tracking, score entry, HTML report, README with local-run and Android steps, CLAUDE.md.

## Known limitations
- Artifact storage and browser localStorage are separate copies of the data.
- No whole-app backup/restore beyond the roster CSV.
- APK needs Android Studio on the coach's machine.

## Possible next steps
- Whole-app JSON export/import for backup and moving between devices.
- Play-count or per-quarter playtime balancing targets.
- Persist report HTML to a file via Capacitor Filesystem/Share on Android.
- Replace placeholder appId `com.yourteam.ballsdeep` before publishing.
