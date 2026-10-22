# Balls Deep — CLAUDE.md

USA football roster and live playtime manager for coaches. React + Vite web app, later packaged for Android with Capacitor. Also runs as a Claude artifact.

## Commands
- `npm install` — install dependencies (Node 18+)
- `npm run dev` — dev server
- `npm run build` — production build to `dist/` (run after every change to confirm it compiles)
- `npm run preview` — serve the built app
- `npm run cap:sync` / `npm run cap:open` — copy build into the Android project / open Android Studio (after `npx cap add android` once)

## Layout
- `src/App.jsx` is the **entire app** (about 1,900 lines): no router, no state library, no backend.
- `src/App.jsx` must stay identical to the standalone artifact file `balls-deep.jsx`. Edit one, copy to the other.
- `src/main.jsx`, `src/index.css`, Tailwind 3, `lucide-react` icons.
- `capacitor.config.json`: appId `com.yourteam.ballsdeep`, appName "Balls Deep", webDir `dist`.

## Data model
Everything is one JSON blob under storage key `app-data`, read and written through the `storage` adapter (`window.storage` in the Claude artifact, `localStorage` standalone).
- `players`: number, name, active flag, and a position list per unit.
- Four units: `offense`, `defense`, `kickoff`, `punt` (`UNIT_DEFS`). Each player has up to 8 positions per unit (`MAX_POSITIONS_PER_PLAYER`), each with weight 1–5.
- `games`: `id, opponent, date, status (setup|live|ended), currentUnit, quarter, quarterMinutes, quarterStartElapsed, activePlayerIds`, four lineups, `playerStats{id:{secondsPlayed,onFieldSince}}`, `subLog`, `possessionLog`, `currentSessionStart`, `score{us,them}|null`, `clock{running,accumulatedSeconds,startedAt}`.

## Rules for changes
- Get a unit's lineup with `lineupKeyForUnit(unit)`. Never hardcode offense/defense pairs.
- Any new game field needs a backfill default in the load path so older saved games still open.
- Keep game logic as pure functions outside components (`toggleUnit`, `setLineupSlot`, `closePossessionSegment`, `rankCandidates`, ...).
- Make small, targeted edits.

## How time works
- Timestamp-based. Nothing is written per tick; elapsed time comes from `Date.now()`. A 1 s interval only forces re-render. State is saved on start, pause, sub, unit switch, quarter change, end.
- Two clocks: the **game clock** is free-running and drives all playtime; the **quarter clock** counts down from `quarterMinutes`, reset via `quarterStartElapsed`. When the quarter hits zero the game clock auto-pauses and the coach presses play.
- Only `currentUnit` accrues playtime. `toggleUnit` banks the outgoing unit, starts the incoming one, and closes a `possessionLog` segment.
- `setLineupSlot` appends to `subLog` when the game is live.
- Substitution suggestions: `rankCandidates` score = `weight*15 + benchSeconds/60`.
- Ending a game closes the possession segment, pauses the clock, then stores the final score.

## Hard-won rules (the artifact sandbox breaks these)
1. No `confirm()`, `alert()` or `prompt()`. Use `ConfirmModal` / `ScoreModal`.
2. No programmatic `<a download>` or reliance on Clipboard API. Use `ExportModal` (CSV) and `ReportModal` (HTML report) with pre-selected text and a Copy button.
3. No nested `<button>`. Inside a button use the read-only `StarDisplay`, not `StarRating`.
4. All inputs are black text on a light background: use `.td-input` / `.td-select` (applies to date and number types too).
5. Never touch `localStorage` or `window.storage` directly; use the `storage` adapter.
6. Run all user text that goes into the HTML report through `escapeHtml`.

## Testing notes
- No test framework ships with the project. For logic, extract the pure functions into a scratch Node script.
- If using vitest + jsdom + Testing Library temporarily: `vi.useFakeTimers()` hangs `findBy*` queries, so test logic purely instead; watch for React `validateDOMNesting` warnings; the score renders as `21–14` inside one span, so match on `textContent`. Remove test deps before shipping.

## Android
Build with `npm run build`, then `npx cap add android` (first time), `npm run cap:sync`, `npm run cap:open`, and build the APK in Android Studio. See README.md. No APK can be built in the cloud sandbox.

## Style
Green/gold palette, Oswald (headings) and Inter (body). The printable HTML report uses a light palette.
