import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  Plus, X, Trash2, Pencil, Users, Settings as SettingsIcon,
  CalendarDays, History as HistoryIcon, Star, ChevronLeft, ChevronRight,
  Play, Pause, Square, AlertCircle, Minus, Download, Upload, Copy, Check
} from "lucide-react";

/* ---------------------------------------------------------------
   Balls Deep — roster & live playtime manager

   players:          [{ id, name, number, positions: [{unit, position, weight}] }]
   offensePositions / defensePositions / kickoffPositions / puntPositions:
                      [{ name, slots }]
   games: [{
     id, opponent, date,
     quarter, quarterMinutes, quarterStartElapsed,
     status: 'setup' | 'live' | 'ended', currentUnit: 'offense'|'defense'|'kickoff'|'punt',
     activePlayerIds: [id],
     offenseLineup / defenseLineup / kickoffLineup / puntLineup: { posName: [id|null, ...] },
     playerStats: { [id]: { secondsPlayed: number, onFieldSince: ms|null } },
     clock: { running: bool, accumulatedSeconds: number, startedAt: ms|null }
   }]
   All data is combined into a single storage key so saves stay atomic.
   The live clock is never written every tick — only on start/pause/sub/end,
   with elapsed time between events computed from timestamps on render.

   Two clocks are shown during a live game:
   - Game clock: a free-running stopwatch for the whole game (used for total
     playtime accounting) — unaffected by quarter changes.
   - Quarter clock: counts down from `quarterMinutes`, reset whenever the
     quarter is bumped. Purely a display/pacing aid; doesn't gate anything.
------------------------------------------------------------------*/

const UNIT_DEFS = [
  { id: "offense", label: "Offense" },
  { id: "defense", label: "Defense" },
  { id: "kickoff", label: "Kickoff" },
  { id: "punt", label: "Punt" },
];
const UNIT_LINEUP_KEY = {
  offense: "offenseLineup",
  defense: "defenseLineup",
  kickoff: "kickoffLineup",
  punt: "puntLineup",
};
const lineupKeyForUnit = (unit) => UNIT_LINEUP_KEY[unit] || "offenseLineup";
const MAX_POSITIONS_PER_PLAYER = 8;

const DEFAULT_OFFENSE_POSITIONS = [
  { name: "QB", slots: 1 },
  { name: "RB", slots: 1 },
  { name: "WR", slots: 2 },
  { name: "TE", slots: 1 },
  { name: "OL", slots: 3 },
];
const DEFAULT_DEFENSE_POSITIONS = [
  { name: "DL", slots: 3 },
  { name: "LB", slots: 2 },
  { name: "CB", slots: 2 },
  { name: "S", slots: 1 },
];
const DEFAULT_KICKOFF_POSITIONS = [
  { name: "K", slots: 1 },
  { name: "COV", slots: 4 },
];
const DEFAULT_PUNT_POSITIONS = [
  { name: "P", slots: 1 },
  { name: "PROT", slots: 4 },
];

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/* ---------------------------- roster CSV import / export ----------------------------
   Wide format, one row per player, so it opens cleanly in Excel/Sheets:
   Number, Name, Unit 1, Position 1, Weight 1, Unit 2, Position 2, Weight 2, ...
   Unit/Position columns are only as wide as MAX_POSITIONS_PER_PLAYER needs. */

function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      rows.push(row); row = [];
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ""));
}

function toCSVField(value) {
  const s = String(value ?? "");
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function playersToCSV(players) {
  const header = ["Number", "Name"];
  for (let i = 1; i <= MAX_POSITIONS_PER_PLAYER; i++) header.push(`Unit ${i}`, `Position ${i}`, `Weight ${i}`);
  const lines = [header.map(toCSVField).join(",")];
  players.forEach((p) => {
    const row = [p.number || "", p.name || ""];
    const positions = p.positions || [];
    for (let i = 0; i < MAX_POSITIONS_PER_PLAYER; i++) {
      const pp = positions[i];
      if (pp) {
        const unitLabel = UNIT_DEFS.find((u) => u.id === pp.unit)?.label || pp.unit;
        row.push(unitLabel, pp.position, pp.weight);
      } else {
        row.push("", "", "");
      }
    }
    lines.push(row.map(toCSVField).join(","));
  });
  return lines.join("\r\n");
}

function playerLabel(playersById, id, emptyLabel) {
  if (!id) return emptyLabel;
  const p = playersById[id];
  if (!p) return "Unknown player";
  return (p.number ? `#${p.number} ` : "") + p.name;
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* Builds a self-contained, styled HTML game report: score, time on field per
   unit, the possession log, the substitution log, and player playtime. No
   external assets — everything (including fonts fallback) is inline so the
   file works standalone once saved. */
function buildGameReportHTML(game, players) {
  const playersById = Object.fromEntries(players.map((p) => [p.id, p]));
  const label = (id, fallback) => escapeHtml(playerLabel(playersById, id, fallback));

  const unitTotals = {};
  UNIT_DEFS.forEach((u) => (unitTotals[u.id] = 0));
  (game.possessionLog || []).forEach((seg) => { unitTotals[seg.unit] = (unitTotals[seg.unit] || 0) + seg.duration; });

  const hasScore = game.score && (game.score.us != null || game.score.them != null);
  const scoreLine = hasScore
    ? `<div class="score"><span class="us">${game.score.us ?? "–"}</span><span class="dash"> – </span><span class="them">${game.score.them ?? "–"}</span></div>`
    : "";

  const summaryCards = UNIT_DEFS.map((u) => `
    <div class="summary-card">
      <div class="label">${escapeHtml(u.label)}</div>
      <div class="value">${formatDuration(unitTotals[u.id] || 0)}</div>
    </div>`).join("");

  const possessionRows = (game.possessionLog || []).map((seg) => {
    const unitLabel = UNIT_DEFS.find((u) => u.id === seg.unit)?.label || seg.unit;
    return `<tr><td>Q${seg.quarter}</td><td>${escapeHtml(unitLabel)}</td><td>${formatDuration(seg.startElapsed)}</td><td>${formatDuration(seg.endElapsed)}</td><td>${formatDuration(seg.duration)}</td></tr>`;
  }).join("") || `<tr><td colspan="5" class="empty">No possession changes recorded.</td></tr>`;

  const subRows = (game.subLog || []).map((entry) => {
    const unitLabel = UNIT_DEFS.find((u) => u.id === entry.unit)?.label || entry.unit;
    return `<tr><td>Q${entry.quarter}</td><td>${formatDuration(entry.gameElapsed)}</td><td>${escapeHtml(unitLabel)}</td><td>${escapeHtml(entry.position)}</td><td>${label(entry.outPlayerId, "(empty slot)")}</td><td>${label(entry.inPlayerId, "Bench")}</td></tr>`;
  }).join("") || `<tr><td colspan="6" class="empty">No substitutions recorded.</td></tr>`;

  const playtimeRows = Object.entries(game.playerStats || {})
    .map(([pid, stat]) => ({ pid, seconds: stat.secondsPlayed || 0 }))
    .sort((a, b) => b.seconds - a.seconds)
    .map(({ pid, seconds }) => `<tr><td>${label(pid, "Unknown player")}</td><td>${formatDuration(seconds)}</td></tr>`)
    .join("") || `<tr><td colspan="2" class="empty">No playtime recorded.</td></tr>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(game.opponent)} — Game Report</title>
<style>
  body { font-family: Georgia, 'Times New Roman', serif; background:#F6F3E7; color:#20302A; margin:0; padding:40px 32px; }
  .wrap { max-width: 760px; margin: 0 auto; }
  .header { border-bottom: 3px solid #D9A441; padding-bottom:18px; margin-bottom:28px; }
  .brand { font-family: Arial, Helvetica, sans-serif; text-transform:uppercase; letter-spacing:0.08em; font-size:12px; color:#8E742F; margin-bottom:6px; }
  h1 { font-family: Arial, Helvetica, sans-serif; text-transform:uppercase; letter-spacing:0.03em; color:#16302A; margin:0 0 6px; font-size:26px; }
  .meta { color:#5b6660; font-size:14px; }
  .score { font-family: Arial, Helvetica, sans-serif; font-size:36px; font-weight:bold; margin-top:10px; }
  .score .us { color:#16302A; } .score .them { color:#9aa39c; } .score .dash { color:#c8cdc6; }
  h2 { font-family: Arial, Helvetica, sans-serif; text-transform:uppercase; font-size:13px; letter-spacing:0.08em; color:#8E742F; border-bottom:1px solid #e3ddc9; padding-bottom:8px; margin-top:34px; }
  table { width:100%; border-collapse:collapse; font-size:13px; margin-top:10px; }
  th { text-align:left; background:#EDE8D6; padding:7px 10px; font-family:Arial, Helvetica, sans-serif; text-transform:uppercase; font-size:10.5px; letter-spacing:0.05em; color:#6b7268; }
  td { padding:7px 10px; border-bottom: 1px solid #ece6d4; }
  tr:nth-child(even) td { background:#FBF9F0; }
  td.empty { text-align:center; color:#9aa39c; font-style:italic; }
  .summary-grid { display:flex; gap:14px; margin-top:10px; flex-wrap:wrap; }
  .summary-card { background:#EDE8D6; padding:12px 18px; border-radius:6px; min-width:110px; }
  .summary-card .label { font-family: Arial, Helvetica, sans-serif; font-size:10.5px; text-transform:uppercase; color:#8E742F; letter-spacing:0.06em; }
  .summary-card .value { font-family: Arial, Helvetica, sans-serif; font-size:22px; font-weight:bold; color:#16302A; margin-top:2px; }
  .footer { margin-top:44px; font-size:11px; color:#a3aca5; text-align:center; font-family: Arial, Helvetica, sans-serif; }
</style>
</head>
<body>
  <div class="wrap">
    <div class="header">
      <div class="brand">Balls Deep — Game Report</div>
      <h1>vs ${escapeHtml(game.opponent)}</h1>
      <div class="meta">${escapeHtml(game.date)}</div>
      ${scoreLine}
    </div>

    <h2>Time on field by unit</h2>
    <div class="summary-grid">${summaryCards}</div>

    <h2>Possession log</h2>
    <table>
      <thead><tr><th>Qtr</th><th>Unit</th><th>Start</th><th>End</th><th>Duration</th></tr></thead>
      <tbody>${possessionRows}</tbody>
    </table>

    <h2>Substitutions</h2>
    <table>
      <thead><tr><th>Qtr</th><th>Time</th><th>Unit</th><th>Position</th><th>Player Out</th><th>Player In</th></tr></thead>
      <tbody>${subRows}</tbody>
    </table>

    <h2>Player playtime</h2>
    <table>
      <thead><tr><th>Player</th><th>Time played</th></tr></thead>
      <tbody>${playtimeRows}</tbody>
    </table>

    <div class="footer">Generated by Balls Deep</div>
  </div>
</body>
</html>`;
}

const NUMBER_HEADER_ALIASES = ["number", "#", "jersey", "jersey number", "no"];
const NAME_HEADER_ALIASES = ["name", "player", "player name"];

/* Parses CSV text into player objects. Doesn't touch app state — the caller
   decides how to merge `players` in and which `newPositionsNeeded` entries
   (position names not yet defined in Settings) to add. */
function csvToPlayers(text) {
  const rows = parseCSV(text);
  if (rows.length < 1) return { error: "The file appears to be empty." };
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const numberIdx = header.findIndex((h) => NUMBER_HEADER_ALIASES.includes(h));
  const nameIdx = header.findIndex((h) => NAME_HEADER_ALIASES.includes(h));
  if (nameIdx === -1) return { error: 'Couldn\'t find a "Name" column in the file.' };

  const groups = [];
  for (let i = 1; i <= MAX_POSITIONS_PER_PLAYER; i++) {
    const uIdx = header.indexOf(`unit ${i}`);
    const pIdx = header.indexOf(`position ${i}`);
    const wIdx = header.indexOf(`weight ${i}`);
    if (uIdx !== -1 || pIdx !== -1 || wIdx !== -1) groups.push({ uIdx, pIdx, wIdx });
  }

  const players = [];
  const newPositionsNeeded = { offense: new Set(), defense: new Set(), kickoff: new Set(), punt: new Set() };

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.every((c) => c.trim() === "")) continue;
    const name = (row[nameIdx] || "").trim();
    if (!name) continue;
    const number = numberIdx !== -1 ? (row[numberIdx] || "").trim().replace(/[^0-9]/g, "") : "";

    const positions = [];
    groups.forEach((g) => {
      const posRaw = g.pIdx !== -1 ? (row[g.pIdx] || "").trim() : "";
      if (!posRaw) return;
      const unitRaw = (g.uIdx !== -1 ? (row[g.uIdx] || "") : "").trim().toLowerCase();
      const unitMatch = UNIT_DEFS.find((u) => u.id === unitRaw || u.label.toLowerCase() === unitRaw);
      const unit = unitMatch ? unitMatch.id : "offense";
      let weight = parseInt(g.wIdx !== -1 ? row[g.wIdx] : "", 10);
      if (!Number.isFinite(weight) || weight < 1) weight = 3;
      if (weight > 5) weight = 5;
      const posName = posRaw.toUpperCase();
      positions.push({ unit, position: posName, weight });
      newPositionsNeeded[unit].add(posName);
    });

    players.push({ id: uid(), number, name, positions: positions.slice(0, MAX_POSITIONS_PER_PLAYER) });
  }

  if (players.length === 0) return { error: "No player rows found in the file." };
  return { players, newPositionsNeeded };
}

/* ---------------------------- time / lineup helpers ---------------------------- */

function liveGameElapsed(game, now) {
  const c = game.clock;
  return c.accumulatedSeconds + (c.running && c.startedAt ? (now - c.startedAt) / 1000 : 0);
}

function livePlayerSeconds(game, playerId, now) {
  const stat = game.playerStats[playerId];
  if (!stat) return 0;
  return stat.secondsPlayed + (stat.onFieldSince ? (now - stat.onFieldSince) / 1000 : 0);
}

function currentStintSeconds(game, playerId, now) {
  const stat = game.playerStats[playerId];
  if (!stat || !stat.onFieldSince) return 0;
  return (now - stat.onFieldSince) / 1000;
}

function onFieldIdSet(game) {
  const key = lineupKeyForUnit(game.currentUnit);
  return new Set(Object.values(game[key] || {}).flat().filter(Boolean));
}

function quarterElapsedSeconds(game, now) {
  return Math.max(0, liveGameElapsed(game, now) - (game.quarterStartElapsed || 0));
}

function quarterRemainingSeconds(game, now) {
  return Math.max(0, (game.quarterMinutes || 0) * 60 - quarterElapsedSeconds(game, now));
}

function startClock(game) {
  if (game.clock.running) return game;
  const now = Date.now();
  const ids = onFieldIdSet(game);
  const playerStats = { ...game.playerStats };
  ids.forEach((pid) => {
    const prev = playerStats[pid] || { secondsPlayed: 0, onFieldSince: null };
    playerStats[pid] = { ...prev, onFieldSince: now };
  });
  return { ...game, clock: { ...game.clock, running: true, startedAt: now }, playerStats };
}

function pauseClock(game) {
  if (!game.clock.running) return game;
  const now = Date.now();
  const elapsedThisStint = (now - game.clock.startedAt) / 1000;
  const playerStats = { ...game.playerStats };
  Object.keys(playerStats).forEach((pid) => {
    const stat = playerStats[pid];
    if (stat.onFieldSince) {
      playerStats[pid] = {
        secondsPlayed: stat.secondsPlayed + (now - stat.onFieldSince) / 1000,
        onFieldSince: null,
      };
    }
  });
  return {
    ...game,
    clock: { ...game.clock, running: false, accumulatedSeconds: game.clock.accumulatedSeconds + elapsedThisStint, startedAt: null },
    playerStats,
  };
}

function closePossessionSegment(game, now) {
  const elapsedNow = liveGameElapsed(game, now);
  const startElapsed = game.currentSessionStart || 0;
  const duration = Math.max(0, elapsedNow - startElapsed);
  const possessionLog = [
    ...(game.possessionLog || []),
    { id: uid(), unit: game.currentUnit, quarter: game.quarter, startElapsed, endElapsed: elapsedNow, duration },
  ];
  return { possessionLog, elapsedNow };
}

function toggleUnit(game, newUnit) {
  if (game.currentUnit === newUnit) return game;
  const now = Date.now();
  let playerStats = { ...game.playerStats };

  if (game.clock.running) {
    // Bank time for the unit coming off the field.
    onFieldIdSet(game).forEach((pid) => {
      const stat = playerStats[pid];
      if (stat && stat.onFieldSince) {
        playerStats[pid] = { secondsPlayed: stat.secondsPlayed + (now - stat.onFieldSince) / 1000, onFieldSince: null };
      }
    });
  }

  // Close out the possession segment for the unit coming off, start a new one.
  const { possessionLog, elapsedNow } = closePossessionSegment(game, now);

  const nextGame = { ...game, currentUnit: newUnit, playerStats, possessionLog, currentSessionStart: elapsedNow };

  if (game.clock.running) {
    // Start time for the unit taking the field.
    const stats2 = { ...nextGame.playerStats };
    onFieldIdSet(nextGame).forEach((pid) => {
      const prev = stats2[pid] || { secondsPlayed: 0, onFieldSince: null };
      stats2[pid] = { ...prev, onFieldSince: now };
    });
    return { ...nextGame, playerStats: stats2 };
  }
  return nextGame;
}

function setLineupSlot(game, unit, positionName, slotIndex, newPlayerId) {
  const now = Date.now();
  const isLiveUnit = unit === game.currentUnit;
  const lineupKey = lineupKeyForUnit(unit);
  const lineup = { ...game[lineupKey] };
  const outgoingId = (lineup[positionName] || [])[slotIndex] || null;
  const incomingId = newPlayerId || null;
  let playerStats = { ...game.playerStats };

  if (outgoingId && isLiveUnit && game.clock.running) {
    const stat = playerStats[outgoingId];
    if (stat && stat.onFieldSince) {
      playerStats[outgoingId] = { secondsPlayed: stat.secondsPlayed + (now - stat.onFieldSince) / 1000, onFieldSince: null };
    }
  }

  // A player can only occupy one slot within the same unit at a time.
  const newLineup = {};
  Object.entries(lineup).forEach(([pos, ids]) => {
    newLineup[pos] = (ids || []).map((id) => (id === newPlayerId ? null : id));
  });
  const arr = [...(newLineup[positionName] || [])];
  arr[slotIndex] = incomingId;
  newLineup[positionName] = arr;

  if (incomingId && isLiveUnit && game.clock.running) {
    const stat = playerStats[incomingId] || { secondsPlayed: 0, onFieldSince: null };
    playerStats[incomingId] = { ...stat, onFieldSince: now };
  }

  // Log every real change made once the game is live — not lineup-building
  // during setup, and not a no-op re-selection of the same player.
  let subLog = game.subLog || [];
  if (game.status === "live" && outgoingId !== incomingId) {
    subLog = [
      ...subLog,
      {
        id: uid(),
        time: now,
        gameElapsed: liveGameElapsed(game, now),
        quarter: game.quarter,
        unit,
        position: positionName,
        outPlayerId: outgoingId,
        inPlayerId: incomingId,
      },
    ];
  }

  return { ...game, [lineupKey]: newLineup, playerStats, subLog };
}

function emptyLineup(positionDefs) {
  const l = {};
  positionDefs.forEach((p) => (l[p.name] = Array.from({ length: p.slots }, () => null)));
  return l;
}

function autoFillUnit(activePlayers, positionDefs, unit) {
  const used = new Set();
  const posOrder = [...positionDefs].sort((a, b) => {
    const eligA = activePlayers.filter((p) => (p.positions || []).some((pp) => pp.unit === unit && pp.position === a.name)).length;
    const eligB = activePlayers.filter((p) => (p.positions || []).some((pp) => pp.unit === unit && pp.position === b.name)).length;
    return eligA - eligB;
  });
  const lineup = emptyLineup(positionDefs);
  posOrder.forEach((posDef) => {
    const pool = activePlayers.filter((p) => !used.has(p.id));
    const scored = pool
      .map((p) => {
        const match = (p.positions || []).find((pp) => pp.unit === unit && pp.position === posDef.name);
        return { player: p, weight: match ? match.weight : 0 };
      })
      .sort((a, b) => b.weight - a.weight);
    const withSkill = scored.filter((s) => s.weight > 0);
    const chosen = withSkill.slice(0, posDef.slots);
    lineup[posDef.name] = Array.from({ length: posDef.slots }, (_, i) => {
      const c = chosen[i];
      if (c) used.add(c.player.id);
      return c ? c.player.id : null;
    });
  });
  return lineup;
}

function rankCandidates(game, players, unit, positionName, now) {
  const activeIds = new Set(game.activePlayerIds);
  const liveOnField = onFieldIdSet(game); // players currently on the field for whichever unit is live
  const unitLineupIds = new Set(
    Object.values(game[lineupKeyForUnit(unit)] || {}).flat().filter(Boolean)
  ); // players already placed elsewhere in the unit being edited
  const excluded = new Set([...liveOnField, ...unitLineupIds]);
  const elapsed = liveGameElapsed(game, now);
  const candidates = players.filter((p) => activeIds.has(p.id) && !excluded.has(p.id));
  const scored = candidates.map((p) => {
    const match = (p.positions || []).find((pp) => pp.unit === unit && pp.position === positionName);
    const weight = match ? match.weight : 0;
    const played = livePlayerSeconds(game, p.id, now);
    const benchSeconds = Math.max(0, elapsed - played);
    const score = weight * 15 + benchSeconds / 60;
    return { player: p, weight, benchSeconds, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/* ---------------------------- UI atoms ---------------------------- */

const colors = {
  bg: "#0F2A22",
  panel: "#1B4636",
  panelLight: "#234F3D",
  chalk: "#F6F3E7",
  chalkMuted: "#AEBDAF",
  gold: "#D9A441",
  goldDim: "#8E742F",
  brick: "#C1503F",
  line: "rgba(246,243,231,0.12)",
};

function GlobalStyle() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Oswald:wght@400;500;600;700&family=Inter:wght@400;500;600&display=swap');
      .td-root { font-family: 'Inter', sans-serif; color: ${colors.chalk}; }
      .td-display { font-family: 'Oswald', sans-serif; letter-spacing: 0.02em; }
      .td-mono { font-variant-numeric: tabular-nums; }
      .td-scroll::-webkit-scrollbar { height: 6px; width: 6px; }
      .td-scroll::-webkit-scrollbar-thumb { background: ${colors.goldDim}; border-radius: 3px; }
      select.td-select { -webkit-appearance: none; appearance: none; }
      input.td-input, select.td-select {
        background: ${colors.chalk}; color: #111111; border: 1px solid ${colors.line};
      }
      input.td-input::placeholder { color: #6b6f63; }
      button:focus-visible, input:focus-visible, select:focus-visible {
        outline: 2px solid ${colors.gold}; outline-offset: 1px;
      }
      button:disabled { opacity: 0.4; }
    `}</style>
  );
}

function StarRating({ value, onChange, size = 16 }) {
  return (
    <div className="flex gap-0.5">
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} type="button" onClick={() => onChange(n)} aria-label={`Set rating ${n}`} style={{ lineHeight: 0 }}>
          <Star size={size} fill={n <= value ? colors.gold : "none"} color={n <= value ? colors.gold : colors.chalkMuted} />
        </button>
      ))}
    </div>
  );
}

/* Non-interactive star display — safe to use inside another clickable
   element (a <button> can't contain another <button> per HTML spec, and
   nesting them makes clicks unreliable in real browsers, not just invalid). */
function StarDisplay({ value, size = 16 }) {
  return (
    <div className="flex gap-0.5">
      {[1, 2, 3, 4, 5].map((n) => (
        <Star key={n} size={size} fill={n <= value ? colors.gold : "none"} color={n <= value ? colors.gold : colors.chalkMuted} style={{ lineHeight: 0 }} />
      ))}
    </div>
  );
}

function Pill({ children, tone = "default" }) {
  const map = {
    default: { bg: "rgba(217,164,65,0.15)", fg: colors.gold },
    defense: { bg: "rgba(174,189,175,0.15)", fg: colors.chalkMuted },
    special: { bg: "rgba(111,168,160,0.18)", fg: "#8FC9C0" },
    bench: { bg: "rgba(193,80,63,0.18)", fg: colors.brick },
  };
  const { bg, fg } = map[tone] || map.default;
  return (
    <span className="td-display text-xs px-2 py-0.5 rounded" style={{ background: bg, color: fg, letterSpacing: "0.05em" }}>
      {children}
    </span>
  );
}

function EmptyState({ icon: Icon, title, body }) {
  return (
    <div className="flex flex-col items-center text-center py-16 px-6" style={{ color: colors.chalkMuted }}>
      <Icon size={32} color={colors.goldDim} />
      <div className="td-display text-lg mt-3" style={{ color: colors.chalk }}>{title}</div>
      <div className="text-sm mt-1 max-w-xs">{body}</div>
    </div>
  );
}

function Modal({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 flex items-end sm:items-center justify-center p-0 sm:p-4 z-50" style={{ background: "rgba(0,0,0,0.6)" }} onClick={onClose}>
      <div className="td-scroll w-full sm:max-w-md max-h-[90vh] overflow-y-auto" style={{ background: colors.panel, borderTop: `2px solid ${colors.gold}` }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 sticky top-0" style={{ background: colors.panel, borderBottom: `1px solid ${colors.line}` }}>
          <div className="td-display text-base uppercase" style={{ color: colors.chalk }}>{title}</div>
          <button onClick={onClose} aria-label="Close"><X size={20} color={colors.chalkMuted} /></button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="block mb-3">
      <div className="td-display text-xs uppercase mb-1" style={{ color: colors.chalkMuted, letterSpacing: "0.08em" }}>{label}</div>
      {children}
    </label>
  );
}

/* Some sandboxed environments (like Claude's artifact iframe) block the
   browser's native confirm()/alert() dialogs, which makes any button gated
   behind window.confirm() silently do nothing. This is a self-contained
   substitute that never touches the browser dialog APIs. */
function ConfirmModal({ title, body, confirmLabel = "Delete", danger = true, onConfirm, onCancel }) {
  return (
    <Modal title={title} onClose={onCancel}>
      <div className="text-sm mb-4" style={{ color: colors.chalkMuted }}>{body}</div>
      <div className="flex gap-2">
        <button onClick={onCancel} className="td-display flex-1 py-2.5 uppercase text-sm" style={{ background: "transparent", color: colors.chalk, border: `1px solid ${colors.line}` }}>
          Cancel
        </button>
        <button onClick={onConfirm} className="td-display flex-1 py-2.5 uppercase text-sm" style={{ background: danger ? colors.brick : colors.gold, color: danger ? colors.chalk : colors.bg }}>
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

function ScoreModal({ title, body, confirmLabel, initialUs, initialThem, onConfirm, onCancel }) {
  const [us, setUs] = useState(initialUs != null ? String(initialUs) : "");
  const [them, setThem] = useState(initialThem != null ? String(initialThem) : "");

  const submit = () => {
    const parse = (v) => (v.trim() === "" ? null : Math.max(0, parseInt(v, 10) || 0));
    onConfirm(parse(us), parse(them));
  };

  return (
    <Modal title={title} onClose={onCancel}>
      {body && <div className="text-sm mb-4" style={{ color: colors.chalkMuted }}>{body}</div>}
      <div className="flex gap-3 mb-4">
        <div className="flex-1"><Field label="Us">
          <input type="number" min={0} className="td-input w-full px-3 py-2 text-sm text-center" value={us} onChange={(e) => setUs(e.target.value)} placeholder="0" />
        </Field></div>
        <div className="flex-1"><Field label="Opponent">
          <input type="number" min={0} className="td-input w-full px-3 py-2 text-sm text-center" value={them} onChange={(e) => setThem(e.target.value)} placeholder="0" />
        </Field></div>
      </div>
      <div className="flex gap-2">
        <button onClick={onCancel} className="td-display flex-1 py-2.5 uppercase text-sm" style={{ background: "transparent", color: colors.chalk, border: `1px solid ${colors.line}` }}>
          Cancel
        </button>
        <button onClick={submit} className="td-display flex-1 py-2.5 uppercase text-sm" style={{ background: colors.gold, color: colors.bg }}>
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

/* Shows CSV text pre-selected so a plain Ctrl/Cmd+C works even if the
   Clipboard API and programmatic file downloads are both unavailable —
   which is the case in some sandboxed hosts. No download attempt here on
   purpose: that path is exactly what silently failed before. */
function ExportModal({ csv, filename, onClose }) {
  const textareaRef = useRef(null);
  const [copyStatus, setCopyStatus] = useState("idle"); // idle | copied | failed

  useEffect(() => {
    const t = textareaRef.current;
    if (t) { t.focus(); t.select(); }
  }, []);

  const handleCopy = async () => {
    try {
      if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error("no clipboard api");
      await navigator.clipboard.writeText(csv);
      setCopyStatus("copied");
    } catch (e) {
      if (textareaRef.current) textareaRef.current.select();
      setCopyStatus("failed");
    }
  };

  return (
    <Modal title="Export roster" onClose={onClose}>
      <div className="text-sm mb-3" style={{ color: colors.chalkMuted }}>
        The text below is already selected — press <strong style={{ color: colors.chalk }}>Ctrl/Cmd+C</strong> to
        copy it, then paste into a new file and save it as <strong style={{ color: colors.chalk }}>{filename}</strong>.
      </div>
      <textarea
        ref={textareaRef}
        readOnly
        value={csv}
        onFocus={(e) => e.target.select()}
        rows={10}
        className="td-input w-full px-2 py-2 text-xs mb-3"
        style={{ fontFamily: "monospace", resize: "vertical" }}
      />
      <button
        onClick={handleCopy}
        className="td-display w-full py-2.5 uppercase text-sm flex items-center justify-center gap-2"
        style={{ background: colors.gold, color: colors.bg, letterSpacing: "0.05em" }}
      >
        {copyStatus === "copied" ? <><Check size={15} /> Copied</> : <><Copy size={15} /> Copy to clipboard</>}
      </button>
      {copyStatus === "failed" && (
        <div className="text-xs mt-2" style={{ color: colors.brick }}>
          Automatic copy isn't available here — the text above is selected, so Ctrl/Cmd+C will still work.
        </div>
      )}
    </Modal>
  );
}

/* Same reliable copy-based pattern as ExportModal, plus a live rendered
   preview (a sandboxed iframe via srcDoc — no download/permission needed)
   so a "pretty" HTML report is actually visible before saving it. */
function ReportModal({ html, filename, onClose }) {
  const textareaRef = useRef(null);
  const [copyStatus, setCopyStatus] = useState("idle"); // idle | copied | failed

  useEffect(() => {
    const t = textareaRef.current;
    if (t) t.select();
  }, []);

  const handleCopy = async () => {
    try {
      if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error("no clipboard api");
      await navigator.clipboard.writeText(html);
      setCopyStatus("copied");
    } catch (e) {
      if (textareaRef.current) textareaRef.current.select();
      setCopyStatus("failed");
    }
  };

  return (
    <Modal title="Game report" onClose={onClose}>
      <div className="text-sm mb-3" style={{ color: colors.chalkMuted }}>
        Preview below. Copy the source underneath and save it as <strong style={{ color: colors.chalk }}>{filename}</strong> —
        opening that file in any browser shows the full report.
      </div>
      <div style={{ border: `1px solid ${colors.line}`, background: "#fff" }} className="mb-3">
        <iframe title="Game report preview" srcDoc={html} style={{ width: "100%", height: 260, border: "none", display: "block" }} />
      </div>
      <textarea
        ref={textareaRef}
        readOnly
        value={html}
        onFocus={(e) => e.target.select()}
        rows={6}
        className="td-input w-full px-2 py-2 text-xs mb-3"
        style={{ fontFamily: "monospace", resize: "vertical" }}
      />
      <button
        onClick={handleCopy}
        className="td-display w-full py-2.5 uppercase text-sm flex items-center justify-center gap-2"
        style={{ background: colors.gold, color: colors.bg, letterSpacing: "0.05em" }}
      >
        {copyStatus === "copied" ? <><Check size={15} /> Copied</> : <><Copy size={15} /> Copy HTML source</>}
      </button>
      {copyStatus === "failed" && (
        <div className="text-xs mt-2" style={{ color: colors.brick }}>
          Automatic copy isn't available here — the text above is selected, so Ctrl/Cmd+C will still work.
        </div>
      )}
    </Modal>
  );
}

/* ---------------------------- Player form ---------------------------- */

function PlayerForm({ player, positionsByUnit, onSave }) {
  const [name, setName] = useState(player?.name || "");
  const [number, setNumber] = useState(player?.number || "");
  const [positions, setPositions] = useState(player?.positions || []);
  const [pickUnit, setPickUnit] = useState("offense");
  const [pickPos, setPickPos] = useState("");
  const [pickWeight, setPickWeight] = useState(3);
  const [error, setError] = useState("");

  const unitList = positionsByUnit[pickUnit] || [];
  const availableToAdd = unitList.filter((pd) => !positions.some((p) => p.unit === pickUnit && p.position === pd.name));

  useEffect(() => {
    if (!availableToAdd.some((pd) => pd.name === pickPos)) setPickPos(availableToAdd[0]?.name || "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickUnit, positions.length]);

  const addPosition = () => {
    if (!pickPos) return;
    if (positions.length >= MAX_POSITIONS_PER_PLAYER) { setError(`A player can have up to ${MAX_POSITIONS_PER_PLAYER} positions.`); return; }
    setPositions([...positions, { unit: pickUnit, position: pickPos, weight: pickWeight }]);
    setError("");
  };

  const removePosition = (unit, posName) => setPositions(positions.filter((p) => !(p.unit === unit && p.position === posName)));
  const updateWeight = (unit, posName, w) =>
    setPositions(positions.map((p) => (p.unit === unit && p.position === posName ? { ...p, weight: w } : p)));

  const submit = () => {
    if (!name.trim()) { setError("Enter a player name."); return; }
    onSave({ id: player?.id || uid(), name: name.trim(), number: number.toString().trim(), positions });
  };

  const unitTone = (unit) => (unit === "offense" ? "default" : unit === "defense" ? "defense" : "special");
  const unitAbbrev = { offense: "OFF", defense: "DEF", kickoff: "KO", punt: "PT" };

  return (
    <div>
      <Field label="Name">
        <input className="td-input w-full px-3 py-2 text-sm" value={name} onChange={(e) => setName(e.target.value)} placeholder="Player name" />
      </Field>
      <Field label="Number">
        <input className="td-input w-full px-3 py-2 text-sm" value={number} onChange={(e) => setNumber(e.target.value.replace(/[^0-9]/g, ""))} placeholder="e.g. 24" inputMode="numeric" />
      </Field>

      <div className="td-display text-xs uppercase mb-2" style={{ color: colors.chalkMuted, letterSpacing: "0.08em" }}>Positions ({positions.length}/{MAX_POSITIONS_PER_PLAYER})</div>

      <div className="flex flex-col gap-2 mb-3">
        {positions.map((p) => (
          <div key={`${p.unit}:${p.position}`} className="flex items-center justify-between px-3 py-2" style={{ background: colors.bg, border: `1px solid ${colors.line}` }}>
            <div className="flex items-center gap-2">
              <Pill tone={unitTone(p.unit)}>{unitAbbrev[p.unit] || p.unit}</Pill>
              <span className="text-sm font-medium">{p.position}</span>
            </div>
            <div className="flex items-center gap-3">
              <StarRating value={p.weight} onChange={(w) => updateWeight(p.unit, p.position, w)} />
              <button onClick={() => removePosition(p.unit, p.position)} aria-label={`Remove ${p.position}`}><Trash2 size={16} color={colors.brick} /></button>
            </div>
          </div>
        ))}
        {positions.length === 0 && <div className="text-sm" style={{ color: colors.chalkMuted }}>No positions assigned yet.</div>}
      </div>

      {positions.length < MAX_POSITIONS_PER_PLAYER && (
        <div className="mb-2">
          <div className="grid grid-cols-4 gap-1 mb-2">
            {UNIT_DEFS.map((u) => (
              <button key={u.id} onClick={() => setPickUnit(u.id)} className="td-display text-[11px] uppercase px-1 py-1.5"
                style={{ background: pickUnit === u.id ? colors.gold : "transparent", color: pickUnit === u.id ? colors.bg : colors.chalkMuted, border: `1px solid ${colors.gold}` }}>
                {u.label}
              </button>
            ))}
          </div>
          {availableToAdd.length > 0 ? (
            <div className="flex items-center gap-2">
              <select className="td-select flex-1 px-2 py-2 text-sm" value={pickPos} onChange={(e) => setPickPos(e.target.value)}>
                {availableToAdd.map((pd) => <option key={pd.name} value={pd.name}>{pd.name}</option>)}
              </select>
              <StarRating value={pickWeight} onChange={setPickWeight} />
              <button onClick={addPosition} className="px-2 py-2" style={{ background: colors.gold, color: colors.bg }} aria-label="Add position"><Plus size={16} /></button>
            </div>
          ) : (
            <div className="text-xs" style={{ color: colors.chalkMuted }}>All {pickUnit} positions already assigned.</div>
          )}
        </div>
      )}

      {error && <div className="flex items-center gap-1 text-sm mt-1" style={{ color: colors.brick }}><AlertCircle size={14} /> {error}</div>}

      <button onClick={submit} className="td-display w-full mt-4 py-2.5 uppercase text-sm" style={{ background: colors.gold, color: colors.bg, letterSpacing: "0.05em" }}>
        Save player
      </button>
    </div>
  );
}

/* ---------------------------- Roster tab ---------------------------- */

function RosterTab({ players, positionsByUnit, onAdd, onUpdate, onDelete, onImport }) {
  const [modal, setModal] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [importPreview, setImportPreview] = useState(null); // { players, newPositionsNeeded } | { error }
  const fileInputRef = useRef(null);
  const unitTone = (unit) => (unit === "offense" ? "default" : unit === "defense" ? "defense" : "special");

  const [exportData, setExportData] = useState(null); // { csv, filename } | null

  const handleExport = () => {
    setExportData({
      csv: playersToCSV(players),
      filename: `balls-deep-roster-${new Date().toISOString().slice(0, 10)}.csv`,
    });
  };

  const handleFileChange = (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = ""; // allow re-selecting the same file later
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setImportPreview(csvToPlayers(String(reader.result || "")));
    reader.onerror = () => setImportPreview({ error: "Couldn't read that file." });
    reader.readAsText(file);
  };

  const newPositionCount = importPreview && !importPreview.error
    ? Object.values(importPreview.newPositionsNeeded).reduce((sum, set) => sum + set.size, 0)
    : 0;

  return (
    <div className="px-4 pb-24">
      <div className="flex items-center justify-between mt-4 mb-3">
        <div className="td-display text-xl uppercase">Roster</div>
        <button onClick={() => setModal("new")} className="flex items-center gap-1 td-display text-xs uppercase px-3 py-2" style={{ background: colors.gold, color: colors.bg, letterSpacing: "0.05em" }}>
          <Plus size={14} /> Add player
        </button>
      </div>

      <div className="flex gap-2 mb-4">
        <button onClick={() => fileInputRef.current && fileInputRef.current.click()} className="flex items-center justify-center gap-1.5 flex-1 td-display text-xs uppercase px-3 py-2" style={{ border: `1px solid ${colors.gold}`, color: colors.gold }}>
          <Upload size={14} /> Import CSV
        </button>
        <button onClick={handleExport} disabled={players.length === 0} className="flex items-center justify-center gap-1.5 flex-1 td-display text-xs uppercase px-3 py-2" style={{ border: `1px solid ${colors.line}`, color: colors.chalkMuted }}>
          <Download size={14} /> Export CSV
        </button>
        <input ref={fileInputRef} type="file" accept=".csv,text/csv" className="hidden" onChange={handleFileChange} />
      </div>

      {players.length === 0 ? (
        <EmptyState icon={Users} title="No players yet" body="Add your first player, or import a roster CSV to get started." />
      ) : (
        <div className="flex flex-col gap-2">
          {players.slice().sort((a, b) => (a.number || "").localeCompare(b.number || "", undefined, { numeric: true })).map((p) => (
            <div key={p.id} className="flex items-center justify-between px-3 py-3" style={{ background: colors.panel, borderLeft: `3px solid ${colors.gold}` }}>
              <div>
                <div className="flex items-baseline gap-2">
                  <span className="td-display text-base" style={{ color: colors.gold }}>{p.number || "—"}</span>
                  <span className="font-medium text-sm">{p.name}</span>
                </div>
                <div className="flex gap-1 mt-1.5 flex-wrap">
                  {(p.positions || []).length === 0 ? (
                    <span className="text-xs" style={{ color: colors.chalkMuted }}>No positions set</span>
                  ) : (
                    p.positions.map((pp) => (
                      <Pill key={`${pp.unit}:${pp.position}`} tone={unitTone(pp.unit)}>{pp.position} · {pp.weight}★</Pill>
                    ))
                  )}
                </div>
              </div>
              <div className="flex gap-3 pl-2">
                <button onClick={() => setModal(p)} aria-label={`Edit ${p.name}`}><Pencil size={16} color={colors.chalkMuted} /></button>
                <button onClick={() => setDeleteTarget(p)} aria-label={`Delete ${p.name}`}><Trash2 size={16} color={colors.brick} /></button>
              </div>
            </div>
          ))}
        </div>
      )}

      {modal && (
        <Modal title={modal === "new" ? "Add player" : "Edit player"} onClose={() => setModal(null)}>
          <PlayerForm
            player={modal === "new" ? null : modal}
            positionsByUnit={positionsByUnit}
            onSave={(p) => { modal === "new" ? onAdd(p) : onUpdate(p); setModal(null); }}
          />
        </Modal>
      )}

      {exportData && (
        <ExportModal csv={exportData.csv} filename={exportData.filename} onClose={() => setExportData(null)} />
      )}

      {importPreview && (
        <Modal title="Import roster" onClose={() => setImportPreview(null)}>
          {importPreview.error ? (
            <div className="text-sm mb-4" style={{ color: colors.brick }}>{importPreview.error}</div>
          ) : (
            <div className="text-sm mb-4" style={{ color: colors.chalkMuted }}>
              Found <strong style={{ color: colors.chalk }}>{importPreview.players.length}</strong> player{importPreview.players.length === 1 ? "" : "s"} in the file.
              Existing players are matched by jersey number and will be updated; everyone else is added as new.
              {newPositionCount > 0 && ` This will also add ${newPositionCount} new position${newPositionCount === 1 ? "" : "s"} to your Positions settings.`}
            </div>
          )}
          <div className="flex gap-2">
            <button onClick={() => setImportPreview(null)} className="td-display flex-1 py-2.5 uppercase text-sm" style={{ background: "transparent", color: colors.chalk, border: `1px solid ${colors.line}` }}>
              Cancel
            </button>
            {!importPreview.error && (
              <button
                onClick={() => { onImport(importPreview.players, importPreview.newPositionsNeeded); setImportPreview(null); }}
                className="td-display flex-1 py-2.5 uppercase text-sm"
                style={{ background: colors.gold, color: colors.bg }}
              >
                Import
              </button>
            )}
          </div>
        </Modal>
      )}

      {deleteTarget && (
        <ConfirmModal
          title="Remove player"
          body={`Remove ${deleteTarget.name} from the roster? This can't be undone.`}
          confirmLabel="Remove"
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => { onDelete(deleteTarget.id); setDeleteTarget(null); }}
        />
      )}
    </div>
  );
}

/* ---------------------------- Positions/Settings tab ---------------------------- */

function PositionListEditor({ title, positions, onChange }) {
  const [newName, setNewName] = useState("");

  const addPosition = () => {
    const name = newName.trim().toUpperCase();
    if (!name || positions.some((p) => p.name === name)) return;
    onChange([...positions, { name, slots: 1 }]);
    setNewName("");
  };
  const updateSlots = (name, slots) => onChange(positions.map((p) => (p.name === name ? { ...p, slots: Math.max(1, slots) } : p)));
  const removePosition = (name) => onChange(positions.filter((p) => p.name !== name));

  return (
    <div className="mb-6">
      <div className="td-display text-sm uppercase mb-2" style={{ color: colors.gold, letterSpacing: "0.06em" }}>{title}</div>
      <div className="flex flex-col gap-2 mb-3">
        {positions.map((p) => (
          <div key={p.name} className="flex items-center justify-between px-3 py-2" style={{ background: colors.panel, border: `1px solid ${colors.line}` }}>
            <span className="td-display text-sm">{p.name}</span>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <span className="text-xs" style={{ color: colors.chalkMuted }}>Slots</span>
                <input type="number" min={1} className="td-input w-14 px-2 py-1 text-sm text-center" value={p.slots} onChange={(e) => updateSlots(p.name, parseInt(e.target.value || "1", 10))} />
              </div>
              <button onClick={() => removePosition(p.name)} aria-label={`Remove ${p.name}`}><Trash2 size={16} color={colors.brick} /></button>
            </div>
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <input className="td-input flex-1 px-3 py-2 text-sm" placeholder={`New ${title.toLowerCase()} position`} value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addPosition()} />
        <button onClick={addPosition} className="px-3 py-2" style={{ background: colors.gold, color: colors.bg }} aria-label={`Add ${title} position`}><Plus size={16} /></button>
      </div>
    </div>
  );
}

function PositionsTab({ offensePositions, defensePositions, kickoffPositions, puntPositions, onChangeOffense, onChangeDefense, onChangeKickoff, onChangePunt }) {
  return (
    <div className="px-4 pb-24">
      <div className="td-display text-xl uppercase mt-4 mb-1">Positions</div>
      <div className="text-sm mb-4" style={{ color: colors.chalkMuted }}>
        Set your depth chart for each unit — position names and how many players fill each one on the field at once.
      </div>
      <PositionListEditor title="Offense" positions={offensePositions} onChange={onChangeOffense} />
      <PositionListEditor title="Defense" positions={defensePositions} onChange={onChangeDefense} />
      <PositionListEditor title="Kickoff" positions={kickoffPositions} onChange={onChangeKickoff} />
      <PositionListEditor title="Punt" positions={puntPositions} onChange={onChangePunt} />
    </div>
  );
}

/* ---------------------------- Game Day: lineup panel ---------------------------- */

function LineupPanel({ title, unit, positionDefs, lineup, players, playersById, game, now, onOpenSlot, interactive, isLiveUnit }) {
  return (
    <div className="mb-4">
      <div className="flex items-center gap-2 mb-2">
        <div className="td-display text-sm uppercase" style={{ color: isLiveUnit ? colors.gold : colors.chalkMuted, letterSpacing: "0.06em" }}>{title}</div>
        {game.status !== "setup" && (
          <Pill tone={isLiveUnit ? "default" : "bench"}>{isLiveUnit ? "On field" : "Off field"}</Pill>
        )}
      </div>
      <div className="flex flex-col gap-2" style={{ opacity: game.status !== "setup" && !isLiveUnit ? 0.6 : 1 }}>
        {positionDefs.map((pos) => (
          <div key={pos.name} style={{ background: colors.panel, border: `1px solid ${colors.line}` }} className="p-2.5">
            <div className="td-display text-xs uppercase mb-1.5" style={{ color: colors.chalkMuted, letterSpacing: "0.08em" }}>{pos.name}</div>
            <div className="flex flex-col gap-1.5">
              {Array.from({ length: pos.slots }).map((_, slotIdx) => {
                const pid = (lineup[pos.name] || [])[slotIdx] || null;
                const p = pid ? playersById[pid] : null;
                const stint = pid ? currentStintSeconds(game, pid, now) : 0;
                const total = pid ? livePlayerSeconds(game, pid, now) : 0;
                return (
                  <button
                    key={slotIdx}
                    disabled={!interactive}
                    onClick={() => onOpenSlot(unit, pos.name, slotIdx)}
                    className="flex items-center justify-between px-2.5 py-2 text-left w-full"
                    style={{ background: p ? "rgba(217,164,65,0.1)" : colors.bg, border: `1px dashed ${p ? colors.goldDim : colors.line}` }}
                  >
                    {p ? (
                      <>
                        <span className="text-sm font-medium">{p.number ? `#${p.number} ` : ""}{p.name}</span>
                        <span className="td-mono text-xs" style={{ color: colors.chalkMuted }}>
                          {isLiveUnit && game.clock.running && <span style={{ color: colors.gold }}>{formatDuration(stint)} · </span>}
                          {formatDuration(total)} tot
                        </span>
                      </>
                    ) : (
                      <span className="text-sm" style={{ color: colors.chalkMuted }}>+ Assign player</span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SubSuggestModal({ unit, positionName, game, players, now, onPick, onClose }) {
  const ranked = rankCandidates(game, players, unit, positionName, now);
  return (
    <Modal title={`Sub in — ${positionName}`} onClose={onClose}>
      <button
        onClick={() => onPick(null)}
        className="flex items-center gap-2 w-full px-3 py-2.5 mb-3 text-sm"
        style={{ background: "rgba(193,80,63,0.12)", color: colors.brick, border: `1px solid ${colors.brick}` }}
      >
        <Minus size={15} /> Leave slot empty
      </button>
      {ranked.length === 0 ? (
        <div className="text-sm" style={{ color: colors.chalkMuted }}>No available players on the bench right now.</div>
      ) : (
        <div className="flex flex-col gap-2">
          {ranked.map((r, i) => (
            <button
              key={r.player.id}
              onClick={() => onPick(r.player.id)}
              className="flex items-center justify-between px-3 py-2.5 text-left"
              style={{ background: i === 0 ? "rgba(217,164,65,0.15)" : colors.bg, border: `1px solid ${i === 0 ? colors.gold : colors.line}` }}
            >
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{r.player.number ? `#${r.player.number} ` : ""}{r.player.name}</span>
                  {i === 0 && <Pill>Best fit</Pill>}
                </div>
                <div className="flex items-center gap-1 mt-1">
                  <StarDisplay value={r.weight} size={12} />
                  {r.weight === 0 && <span className="text-xs ml-1" style={{ color: colors.chalkMuted }}>unrated</span>}
                </div>
              </div>
              <div className="text-right">
                <div className="td-mono text-xs" style={{ color: colors.chalkMuted }}>resting</div>
                <div className="td-mono text-sm" style={{ color: colors.gold }}>{formatDuration(r.benchSeconds)}</div>
              </div>
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}

/* ---------------------------- Game Day tab ---------------------------- */

function NewGameForm({ onCreate }) {
  const [opponent, setOpponent] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [quarterMinutes, setQuarterMinutes] = useState(10);
  return (
    <div>
      <Field label="Opponent">
        <input className="td-input w-full px-3 py-2 text-sm" value={opponent} onChange={(e) => setOpponent(e.target.value)} placeholder="e.g. Eagles" />
      </Field>
      <Field label="Date">
        <input type="date" className="td-input w-full px-3 py-2 text-sm" value={date} onChange={(e) => setDate(e.target.value)} />
      </Field>
      <Field label="Minutes per quarter">
        <input type="number" min={1} className="td-input w-full px-3 py-2 text-sm" value={quarterMinutes} onChange={(e) => setQuarterMinutes(parseInt(e.target.value || "1", 10))} />
      </Field>
      <button onClick={() => onCreate({ opponent: opponent.trim() || "Untitled game", date, quarterMinutes: quarterMinutes || 10 })} className="td-display w-full mt-2 py-2.5 uppercase text-sm" style={{ background: colors.gold, color: colors.bg, letterSpacing: "0.05em" }}>
        Create game
      </button>
    </div>
  );
}

function GameDayTab({ players, offensePositions, defensePositions, kickoffPositions, puntPositions, games, currentGameId, setCurrentGameId, onCreateGame, onUpdateGame, onDeleteGame }) {
  const [showList, setShowList] = useState(games.length === 0);
  const [subTarget, setSubTarget] = useState(null); // { unit, positionName, slotIdx }
  const [confirmAction, setConfirmAction] = useState(null); // 'delete' | 'end' | null
  const [scoreEdit, setScoreEdit] = useState(false);
  const [reportExport, setReportExport] = useState(null); // { html, filename } | null
  const [now, setNow] = useState(Date.now());

  const game = games.find((g) => g.id === currentGameId) || null;
  const playersById = Object.fromEntries(players.map((p) => [p.id, p]));
  const positionDefsByUnit = { offense: offensePositions, defense: defensePositions, kickoff: kickoffPositions, punt: puntPositions };

  useEffect(() => {
    if (!game || !game.clock.running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [game && game.id, game && game.clock.running]);

  // Auto-pause the game clock the moment the quarter clock runs out.
  // The player still has to hit Play again to resume — this just stops
  // time (and playtime accrual) from silently running past the buzzer.
  useEffect(() => {
    if (!game || !game.clock.running || game.status !== "live") return;
    if (quarterRemainingSeconds(game, now) <= 0) {
      onUpdateGame(pauseClock(game));
    }
  }, [now, game && game.clock.running, game && game.id]);

  if (showList || !game) {
    return (
      <div className="px-4 pb-24">
        <div className="td-display text-xl uppercase mt-4 mb-3">Game day</div>
        {games.length > 0 && (
          <div className="flex flex-col gap-2 mb-4">
            {games.slice().sort((a, b) => (a.date < b.date ? 1 : -1)).map((g) => (
              <button key={g.id} onClick={() => { setCurrentGameId(g.id); setShowList(false); }} className="flex items-center justify-between px-3 py-3 text-left" style={{ background: colors.panel, border: `1px solid ${colors.line}` }}>
                <div>
                  <div className="text-sm font-medium">{g.opponent}</div>
                  <div className="text-xs" style={{ color: colors.chalkMuted }}>
                    {g.date} · {g.status === "live" ? "In progress" : g.status === "ended" ? "Final" : "Not started"}
                    {g.status === "ended" && g.score && (g.score.us != null || g.score.them != null) ? ` · ${g.score.us ?? "–"}-${g.score.them ?? "–"}` : ""}
                  </div>
                </div>
                <ChevronRight size={16} color={colors.chalkMuted} />
              </button>
            ))}
          </div>
        )}
        <div style={{ background: colors.panel, border: `1px solid ${colors.line}` }} className="p-4">
          <div className="td-display text-sm uppercase mb-3" style={{ color: colors.gold }}>New game</div>
          <NewGameForm onCreate={(g) => {
            const id = uid();
            onCreateGame({
              id, ...g, quarter: 1, quarterStartElapsed: 0, status: "setup", currentUnit: "offense",
              activePlayerIds: [],
              offenseLineup: emptyLineup(offensePositions),
              defenseLineup: emptyLineup(defensePositions),
              kickoffLineup: emptyLineup(kickoffPositions),
              puntLineup: emptyLineup(puntPositions),
              playerStats: {},
              subLog: [],
              possessionLog: [],
              currentSessionStart: 0,
              score: null,
              clock: { running: false, accumulatedSeconds: 0, startedAt: null },
            });
            setCurrentGameId(id);
            setShowList(false);
          }} />
        </div>
      </div>
    );
  }

  const toggleActive = (playerId) => {
    const wasActive = game.activePlayerIds.includes(playerId);
    let nextGame = game;
    if (wasActive) {
      // Deactivating (e.g. injury) — pull them off the field first so their clock stops.
      UNIT_DEFS.forEach((u) => {
        const key = lineupKeyForUnit(u.id);
        Object.entries(nextGame[key]).forEach(([pos, ids]) => {
          const idx = ids.indexOf(playerId);
          if (idx !== -1) nextGame = setLineupSlot(nextGame, u.id, pos, idx, null);
        });
      });
    }
    const active = wasActive ? nextGame.activePlayerIds.filter((id) => id !== playerId) : [...nextGame.activePlayerIds, playerId];
    onUpdateGame({ ...nextGame, activePlayerIds: active });
  };

  const autoFill = () => {
    const activePlayers = players.filter((p) => game.activePlayerIds.includes(p.id));
    onUpdateGame({
      ...game,
      offenseLineup: autoFillUnit(activePlayers, offensePositions, "offense"),
      defenseLineup: autoFillUnit(activePlayers, defensePositions, "defense"),
      kickoffLineup: autoFillUnit(activePlayers, kickoffPositions, "kickoff"),
      puntLineup: autoFillUnit(activePlayers, puntPositions, "punt"),
    });
  };

  const startGame = () => onUpdateGame({ ...game, status: "live" });
  const toggleClock = () => onUpdateGame(game.clock.running ? pauseClock(game) : startClock(game));
  const switchUnit = (unit) => onUpdateGame(toggleUnit(game, unit));
  const endGame = (us, them) => {
    const now = Date.now();
    const { possessionLog, elapsedNow } = closePossessionSegment(game, now);
    const paused = pauseClock({ ...game, possessionLog });
    onUpdateGame({ ...paused, status: "ended", currentSessionStart: elapsedNow, score: { us, them } });
  };
  const saveScore = (us, them) => onUpdateGame({ ...game, score: { us, them } });
  const bumpQuarter = (delta) => {
    const nextQuarter = Math.max(1, game.quarter + delta);
    if (nextQuarter === game.quarter) return;
    onUpdateGame({ ...game, quarter: nextQuarter, quarterStartElapsed: liveGameElapsed(game, Date.now()) });
  };
  const setQuarterMinutes = (mins) => onUpdateGame({ ...game, quarterMinutes: Math.max(1, mins || 1) });

  const openSlot = (unit, positionName, slotIdx) => {
    if (game.status === "ended") return;
    setSubTarget({ unit, positionName, slotIdx });
  };
  const applySub = (playerId) => {
    onUpdateGame(setLineupSlot(game, subTarget.unit, subTarget.positionName, subTarget.slotIdx, playerId));
    setSubTarget(null);
  };

  const activePlayers = players.filter((p) => game.activePlayerIds.includes(p.id));
  const onField = onFieldIdSet(game);
  const benchPlayers = activePlayers
    .filter((p) => !onField.has(p.id))
    .map((p) => ({ player: p, benchSeconds: Math.max(0, liveGameElapsed(game, now) - livePlayerSeconds(game, p.id, now)) }))
    .sort((a, b) => b.benchSeconds - a.benchSeconds);

  const interactive = game.status !== "ended";
  const quarterRemaining = quarterRemainingSeconds(game, now);
  const currentUnitLabel = UNIT_DEFS.find((u) => u.id === game.currentUnit)?.label || game.currentUnit;
  const possessionElapsed = Math.max(0, liveGameElapsed(game, now) - (game.currentSessionStart || 0));
  const unitTotals = {};
  UNIT_DEFS.forEach((u) => (unitTotals[u.id] = 0));
  (game.possessionLog || []).forEach((seg) => { unitTotals[seg.unit] = (unitTotals[seg.unit] || 0) + seg.duration; });

  return (
    <div className="px-4 pb-24">
      <div className="flex items-center justify-between mt-4 mb-1">
        <button className="text-xs td-display uppercase flex items-center gap-1" style={{ color: colors.chalkMuted }} onClick={() => setShowList(true)}>
          <ChevronLeft size={14} /> All games
        </button>
        <button onClick={() => setConfirmAction("delete")}>
          <Trash2 size={16} color={colors.brick} />
        </button>
      </div>
      <div className="td-display text-xl uppercase">{game.opponent}</div>
      <div className="text-sm mb-4" style={{ color: colors.chalkMuted }}>{game.date}</div>

      <div className="td-display text-xs uppercase mb-2" style={{ color: colors.chalkMuted, letterSpacing: "0.08em" }}>
        Active roster ({activePlayers.length}/{players.length})
      </div>
      <div className="flex flex-wrap gap-2 mb-4">
        {players.map((p) => {
          const active = game.activePlayerIds.includes(p.id);
          return (
            <button key={p.id} onClick={() => toggleActive(p.id)} className="td-display text-xs px-2.5 py-1.5 uppercase"
              style={{ background: active ? "rgba(217,164,65,0.15)" : "rgba(193,80,63,0.1)", color: active ? colors.gold : colors.brick, border: `1px solid ${active ? colors.gold : colors.brick}` }}>
              {p.number ? `#${p.number} ` : ""}{p.name}
            </button>
          );
        })}
        {players.length === 0 && <div className="text-sm" style={{ color: colors.chalkMuted }}>Add players to the roster first.</div>}
      </div>

      {game.status === "setup" && (
        <button onClick={autoFill} disabled={activePlayers.length === 0} className="td-display w-full py-2.5 uppercase text-sm mb-5"
          style={{ background: activePlayers.length ? colors.panelLight : colors.panel, color: activePlayers.length ? colors.chalk : colors.chalkMuted, border: `1px solid ${colors.gold}` }}>
          Auto-fill starting lineups
        </button>
      )}

      {game.status !== "setup" && (
        <>
          <div className="td-display text-xs uppercase mb-1" style={{ color: colors.chalkMuted, letterSpacing: "0.08em" }}>Side of the ball</div>
          <div className="grid grid-cols-4 gap-1.5 mb-1" role="radiogroup" aria-label="Side of the ball">
            {UNIT_DEFS.map((u) => (
              <button key={u.id} role="radio" aria-checked={game.currentUnit === u.id} onClick={() => switchUnit(u.id)} disabled={!interactive} className="td-display text-xs uppercase py-2.5"
                style={{ background: game.currentUnit === u.id ? colors.gold : "transparent", color: game.currentUnit === u.id ? colors.bg : colors.chalkMuted, border: `1px solid ${colors.gold}` }}>
                {u.label}
              </button>
            ))}
          </div>
          <div className="text-xs mb-3" style={{ color: colors.chalkMuted }}>
            On {currentUnitLabel} for <span className="td-mono" style={{ color: colors.gold }}>{formatDuration(possessionElapsed)}</span>
          </div>

          <div className="flex items-center justify-between mb-3 px-3 py-3" style={{ background: colors.panel, border: `1px solid ${colors.gold}` }}>
            <div>
              <div className="td-display text-xs uppercase" style={{ color: colors.chalkMuted, letterSpacing: "0.08em" }}>Quarter clock</div>
              <div className="td-display text-3xl td-mono" style={{ color: quarterRemaining <= 0 ? colors.brick : colors.gold }}>{formatDuration(quarterRemaining)}</div>
              <div className="td-mono text-xs mt-0.5" style={{ color: colors.chalkMuted }}>Game total {formatDuration(liveGameElapsed(game, now))}</div>
              {quarterRemaining <= 0 && !game.clock.running && game.status === "live" && (
                <div className="text-xs mt-1" style={{ color: colors.brick }}>Quarter's up — press play when the next one starts</div>
              )}
              <div className="flex items-center gap-1.5 mt-1.5">
                <span className="text-xs" style={{ color: colors.chalkMuted }}>Qtr</span>
                <button onClick={() => bumpQuarter(-1)} disabled={!interactive}><ChevronLeft size={14} color={colors.chalkMuted} /></button>
                <span className="td-display text-sm">{game.quarter}</span>
                <button onClick={() => bumpQuarter(1)} disabled={!interactive}><ChevronRight size={14} color={colors.chalkMuted} /></button>
                <span className="text-xs ml-1" style={{ color: colors.chalkMuted }}>len</span>
                <input type="number" min={1} disabled={!interactive} className="td-input w-12 px-1 py-1 text-xs text-center" value={game.quarterMinutes} onChange={(e) => setQuarterMinutes(parseInt(e.target.value || "1", 10))} />
                <span className="text-xs" style={{ color: colors.chalkMuted }}>min</span>
              </div>
            </div>
            <div className="flex flex-col items-end gap-2">
              {interactive && (
                <div className="flex items-center gap-2">
                  <button onClick={toggleClock} className="p-3" style={{ background: colors.gold, color: colors.bg, borderRadius: "50%" }} aria-label={game.clock.running ? "Pause clock" : "Start clock"}>
                    {game.clock.running ? <Pause size={20} /> : <Play size={20} />}
                  </button>
                  <button onClick={() => setConfirmAction("end")} className="p-3" style={{ background: colors.brick, color: colors.chalk, borderRadius: "50%" }} aria-label="End game">
                    <Square size={18} />
                  </button>
                </div>
              )}
              {game.status === "ended" && (
                <button onClick={() => setScoreEdit(true)} className="flex items-center gap-1.5" aria-label="Edit score">
                  <span className="td-display td-mono text-lg" style={{ color: colors.chalk }}>
                    {game.score?.us ?? "–"}<span style={{ color: colors.chalkMuted }}>–</span>{game.score?.them ?? "–"}
                  </span>
                  <Pencil size={12} color={colors.chalkMuted} />
                </button>
              )}
            </div>
          </div>

          {game.status === "ended" && (
            <button
              onClick={() => setReportExport({
                html: buildGameReportHTML(game, players),
                filename: `balls-deep-report-${(game.opponent || "game").toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${game.date}.html`,
              })}
              className="flex items-center justify-center gap-2 w-full td-display text-xs uppercase px-3 py-2.5 mb-5"
              style={{ background: colors.gold, color: colors.bg, letterSpacing: "0.05em" }}
            >
              <Download size={14} /> Export game report
            </button>
          )}
        </>
      )}

      {(game.status === "setup" ? UNIT_DEFS : UNIT_DEFS.filter((u) => u.id === game.currentUnit)).map((u) => (
        <LineupPanel
          key={u.id}
          title={u.label}
          unit={u.id}
          positionDefs={positionDefsByUnit[u.id]}
          lineup={game[lineupKeyForUnit(u.id)]}
          players={players}
          playersById={playersById}
          game={game}
          now={now}
          onOpenSlot={openSlot}
          interactive={interactive}
          isLiveUnit={game.currentUnit === u.id}
        />
      ))}

      {game.status === "setup" ? (
        <button onClick={startGame} disabled={activePlayers.length === 0} className="td-display w-full py-3 uppercase text-sm flex items-center justify-center gap-2 mt-2"
          style={{ background: activePlayers.length ? colors.gold : colors.panelLight, color: activePlayers.length ? colors.bg : colors.chalkMuted, letterSpacing: "0.05em" }}>
          <Play size={16} /> Start game
        </button>
      ) : (
        <>
          <div className="td-display text-xs uppercase mb-2 mt-2" style={{ color: colors.chalkMuted, letterSpacing: "0.08em" }}>
            Bench <span style={{ color: colors.chalkMuted, textTransform: "none", letterSpacing: 0 }}>· off the field while {currentUnitLabel} plays</span>
          </div>
          <div className="flex flex-col gap-1.5">
            {benchPlayers.length === 0 && <div className="text-sm" style={{ color: colors.chalkMuted }}>Everyone active is on the field.</div>}
            {benchPlayers.map(({ player: p, benchSeconds }) => (
              <div key={p.id} className="flex items-center justify-between px-3 py-2" style={{ background: colors.panel }}>
                <span className="text-sm">{p.number ? `#${p.number} ` : ""}{p.name}</span>
                <div className="flex items-center gap-3 td-mono text-xs" style={{ color: colors.chalkMuted }}>
                  <span>{formatDuration(livePlayerSeconds(game, p.id, now))} played</span>
                  <span style={{ color: colors.gold }}>{formatDuration(benchSeconds)} resting</span>
                </div>
              </div>
            ))}
          </div>

          {(game.possessionLog || []).length > 0 && (
            <div className="mt-5">
              <div className="td-display text-xs uppercase mb-2" style={{ color: colors.chalkMuted, letterSpacing: "0.08em" }}>
                Time on field by unit
              </div>
              <div className="flex flex-wrap gap-2 mb-2">
                {UNIT_DEFS.map((u) => (
                  <div key={u.id} className="px-2.5 py-1.5" style={{ background: colors.panel }}>
                    <span className="text-xs" style={{ color: colors.chalkMuted }}>{u.label}</span>{" "}
                    <span className="td-mono text-xs" style={{ color: colors.gold }}>{formatDuration(unitTotals[u.id] || 0)}</span>
                  </div>
                ))}
              </div>
              <div className="flex flex-col gap-1 td-scroll" style={{ maxHeight: 160, overflowY: "auto" }}>
                {game.possessionLog.slice().reverse().map((seg) => {
                  const unitLabel = UNIT_DEFS.find((u) => u.id === seg.unit)?.label || seg.unit;
                  return (
                    <div key={seg.id} className="flex items-center justify-between px-3 py-1.5 text-xs" style={{ background: colors.panel }}>
                      <span style={{ color: colors.chalkMuted }}>Q{seg.quarter} · {unitLabel}</span>
                      <span className="td-mono">{formatDuration(seg.duration)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {(game.subLog || []).length > 0 && (
            <div className="mt-5">
              <div className="td-display text-xs uppercase mb-2" style={{ color: colors.chalkMuted, letterSpacing: "0.08em" }}>
                Substitution log · {game.subLog.length}
              </div>
              <div className="flex flex-col gap-1 td-scroll" style={{ maxHeight: 220, overflowY: "auto" }}>
                {game.subLog.slice().reverse().map((entry) => {
                  const unitLabel = UNIT_DEFS.find((u) => u.id === entry.unit)?.label || entry.unit;
                  return (
                    <div key={entry.id} className="flex items-center justify-between px-3 py-1.5 text-xs" style={{ background: colors.panel }}>
                      <span style={{ color: colors.chalkMuted }}>Q{entry.quarter} {formatDuration(entry.gameElapsed)} · {unitLabel} {entry.position}</span>
                      <span>
                        {playerLabel(playersById, entry.outPlayerId, "(empty)")}
                        <span style={{ color: colors.gold }}> → </span>
                        {playerLabel(playersById, entry.inPlayerId, "Bench")}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}

      {subTarget && (
        <SubSuggestModal
          unit={subTarget.unit}
          positionName={subTarget.positionName}
          game={game}
          players={players}
          now={now}
          onPick={applySub}
          onClose={() => setSubTarget(null)}
        />
      )}

      {confirmAction === "delete" && (
        <ConfirmModal
          title="Delete game"
          body={`Delete "${game.opponent}"? This removes all its lineups and playtime stats and can't be undone.`}
          confirmLabel="Delete"
          onCancel={() => setConfirmAction(null)}
          onConfirm={() => { onDeleteGame(game.id); setConfirmAction(null); setShowList(true); }}
        />
      )}

      {confirmAction === "end" && (
        <ScoreModal
          title="End game"
          body="The clock will stop and stats will be final. Enter the final score for your records — you can leave it blank and add it later."
          confirmLabel="End game"
          initialUs={game.score?.us}
          initialThem={game.score?.them}
          onCancel={() => setConfirmAction(null)}
          onConfirm={(us, them) => { endGame(us, them); setConfirmAction(null); }}
        />
      )}

      {scoreEdit && (
        <ScoreModal
          title="Edit score"
          confirmLabel="Save"
          initialUs={game.score?.us}
          initialThem={game.score?.them}
          onCancel={() => setScoreEdit(false)}
          onConfirm={(us, them) => { saveScore(us, them); setScoreEdit(false); }}
        />
      )}

      {reportExport && (
        <ReportModal html={reportExport.html} filename={reportExport.filename} onClose={() => setReportExport(null)} />
      )}
    </div>
  );
}

/* ---------------------------- History tab ---------------------------- */

function HistoryTab({ players, games }) {
  const [reportExport, setReportExport] = useState(null); // { html, filename } | null

  if (games.length === 0) {
    return <div className="px-4"><EmptyState icon={HistoryIcon} title="No games yet" body="Games you run on Game Day will show up here with full playtime stats." /></div>;
  }

  const totals = {};
  players.forEach((p) => (totals[p.id] = 0));
  games.forEach((g) => {
    Object.entries(g.playerStats || {}).forEach(([pid, stat]) => {
      totals[pid] = (totals[pid] || 0) + stat.secondsPlayed;
    });
  });

  return (
    <div className="px-4 pb-24">
      <div className="td-display text-xl uppercase mt-4 mb-3">Season totals</div>
      <div className="flex flex-col gap-1.5 mb-6">
        {players.slice().sort((a, b) => (totals[b.id] || 0) - (totals[a.id] || 0)).map((p) => (
          <div key={p.id} className="flex items-center justify-between px-3 py-2" style={{ background: colors.panel }}>
            <span className="text-sm">{p.number ? `#${p.number} ` : ""}{p.name}</span>
            <span className="td-display td-mono text-sm" style={{ color: colors.gold }}>{formatDuration(totals[p.id] || 0)}</span>
          </div>
        ))}
      </div>

      <div className="td-display text-xl uppercase mb-3">Games</div>
      <div className="flex flex-col gap-2">
        {games.slice().sort((a, b) => (a.date < b.date ? 1 : -1)).map((g) => (
          <div key={g.id} className="px-3 py-3" style={{ background: colors.panel, border: `1px solid ${colors.line}` }}>
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="text-sm font-medium">{g.opponent}</div>
                <div className="text-xs" style={{ color: colors.chalkMuted }}>
                  {g.date} · {g.status === "live" ? "In progress" : g.status === "ended" ? "Final" : "Not started"} · {formatDuration(g.clock.accumulatedSeconds)} played
                  {g.status === "ended" && g.score && (g.score.us != null || g.score.them != null) ? ` · ${g.score.us ?? "–"}-${g.score.them ?? "–"}` : ""}
                </div>
              </div>
              {g.status === "ended" && (
                <button
                  onClick={() => setReportExport({
                    html: buildGameReportHTML(g, players),
                    filename: `balls-deep-report-${(g.opponent || "game").toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${g.date}.html`,
                  })}
                  className="flex items-center gap-1 td-display text-xs uppercase px-2 py-1 shrink-0"
                  style={{ border: `1px solid ${colors.gold}`, color: colors.gold }}
                >
                  <Download size={12} /> Report
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {reportExport && (
        <ReportModal html={reportExport.html} filename={reportExport.filename} onClose={() => setReportExport(null)} />
      )}
    </div>
  );
}

/* ---------------------------- App shell ---------------------------- */

/* Works inside a Claude artifact (window.storage) and as a standalone app
   (falls back to localStorage) with the exact same calling code. */
const storage = {
  async get(key) {
    if (typeof window !== "undefined" && window.storage) return window.storage.get(key, false);
    const v = window.localStorage.getItem(key);
    return v !== null ? { key, value: v } : null;
  },
  async set(key, value) {
    if (typeof window !== "undefined" && window.storage) return window.storage.set(key, value, false);
    window.localStorage.setItem(key, value);
    return { key, value };
  },
};

const TABS = [
  { id: "roster", label: "Roster", icon: Users },
  { id: "positions", label: "Positions", icon: SettingsIcon },
  { id: "gameday", label: "Game Day", icon: CalendarDays },
  { id: "history", label: "History", icon: HistoryIcon },
];

export default function App() {
  const [players, setPlayers] = useState([]);
  const [offensePositions, setOffensePositions] = useState(DEFAULT_OFFENSE_POSITIONS);
  const [defensePositions, setDefensePositions] = useState(DEFAULT_DEFENSE_POSITIONS);
  const [kickoffPositions, setKickoffPositions] = useState(DEFAULT_KICKOFF_POSITIONS);
  const [puntPositions, setPuntPositions] = useState(DEFAULT_PUNT_POSITIONS);
  const [games, setGames] = useState([]);
  const [tab, setTab] = useState("roster");
  const [currentGameId, setCurrentGameId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saveError, setSaveError] = useState(false);
  const stateRef = useRef({
    players: [],
    offensePositions: DEFAULT_OFFENSE_POSITIONS,
    defensePositions: DEFAULT_DEFENSE_POSITIONS,
    kickoffPositions: DEFAULT_KICKOFF_POSITIONS,
    puntPositions: DEFAULT_PUNT_POSITIONS,
    games: [],
  });

  useEffect(() => {
    (async () => {
      try {
        const res = await storage.get("app-data");
        if (res && res.value) {
          const parsed = JSON.parse(res.value);
          const next = {
            players: parsed.players || [],
            offensePositions: parsed.offensePositions && parsed.offensePositions.length ? parsed.offensePositions : DEFAULT_OFFENSE_POSITIONS,
            defensePositions: parsed.defensePositions && parsed.defensePositions.length ? parsed.defensePositions : DEFAULT_DEFENSE_POSITIONS,
            kickoffPositions: parsed.kickoffPositions && parsed.kickoffPositions.length ? parsed.kickoffPositions : DEFAULT_KICKOFF_POSITIONS,
            puntPositions: parsed.puntPositions && parsed.puntPositions.length ? parsed.puntPositions : DEFAULT_PUNT_POSITIONS,
            games: (parsed.games || []).map((g) => ({
              // Backfill fields for games saved before kickoff/punt, quarter-clock,
              // substitution-log, possession-tracking, or final-score support existed.
              quarterMinutes: 10,
              quarterStartElapsed: 0,
              currentUnit: "offense",
              kickoffLineup: emptyLineup(DEFAULT_KICKOFF_POSITIONS),
              puntLineup: emptyLineup(DEFAULT_PUNT_POSITIONS),
              subLog: [],
              possessionLog: [],
              currentSessionStart: 0,
              score: null,
              ...g,
            })),
          };
          stateRef.current = next;
          setPlayers(next.players);
          setOffensePositions(next.offensePositions);
          setDefensePositions(next.defensePositions);
          setKickoffPositions(next.kickoffPositions);
          setPuntPositions(next.puntPositions);
          setGames(next.games);
        }
      } catch (e) {
        // no saved data yet — defaults stand
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const persist = useCallback(async (snapshot) => {
    try {
      const result = await storage.set("app-data", JSON.stringify(snapshot));
      setSaveError(!result);
    } catch (e) {
      setSaveError(true);
    }
  }, []);

  const commit = (partial) => {
    const next = { ...stateRef.current, ...partial };
    stateRef.current = next;
    if (partial.players) setPlayers(next.players);
    if (partial.offensePositions) setOffensePositions(next.offensePositions);
    if (partial.defensePositions) setDefensePositions(next.defensePositions);
    if (partial.kickoffPositions) setKickoffPositions(next.kickoffPositions);
    if (partial.puntPositions) setPuntPositions(next.puntPositions);
    if (partial.games) setGames(next.games);
    persist(next);
  };

  const addPlayer = (p) => commit({ players: [...stateRef.current.players, p] });
  const updatePlayer = (p) => commit({ players: stateRef.current.players.map((x) => (x.id === p.id ? p : x)) });
  const deletePlayer = (id) => {
    const nextGames = stateRef.current.games.map((g) => {
      const stripLineup = (lineup) => {
        const out = {};
        Object.entries(lineup).forEach(([pos, ids]) => { out[pos] = ids.map((pid) => (pid === id ? null : pid)); });
        return out;
      };
      const playerStats = { ...g.playerStats };
      delete playerStats[id];
      return {
        ...g,
        activePlayerIds: g.activePlayerIds.filter((pid) => pid !== id),
        offenseLineup: stripLineup(g.offenseLineup),
        defenseLineup: stripLineup(g.defenseLineup),
        kickoffLineup: stripLineup(g.kickoffLineup),
        puntLineup: stripLineup(g.puntLineup),
        playerStats,
      };
    });
    commit({ players: stateRef.current.players.filter((x) => x.id !== id), games: nextGames });
  };

  const importPlayers = (importedPlayers, newPositionsNeeded) => {
    const nextByUnit = {
      offense: [...stateRef.current.offensePositions],
      defense: [...stateRef.current.defensePositions],
      kickoff: [...stateRef.current.kickoffPositions],
      punt: [...stateRef.current.puntPositions],
    };
    UNIT_DEFS.forEach((u) => {
      const needed = newPositionsNeeded[u.id];
      if (needed && needed.size) {
        needed.forEach((name) => {
          if (!nextByUnit[u.id].some((pd) => pd.name === name)) nextByUnit[u.id].push({ name, slots: 1 });
        });
      }
    });

    const byNumber = {};
    stateRef.current.players.forEach((p) => { if (p.number) byNumber[p.number] = p.id; });
    const nextPlayers = [...stateRef.current.players];
    importedPlayers.forEach((ip) => {
      const existingId = ip.number && byNumber[ip.number];
      if (existingId) {
        const idx = nextPlayers.findIndex((x) => x.id === existingId);
        nextPlayers[idx] = { ...nextPlayers[idx], name: ip.name, number: ip.number, positions: ip.positions };
      } else {
        nextPlayers.push(ip);
      }
    });

    commit({
      players: nextPlayers,
      offensePositions: nextByUnit.offense,
      defensePositions: nextByUnit.defense,
      kickoffPositions: nextByUnit.kickoff,
      puntPositions: nextByUnit.punt,
    });
  };

  const makeChangePositions = (unit, key) => (next) => {
    const removed = stateRef.current[key].filter((p) => !next.some((np) => np.name === p.name)).map((p) => p.name);
    let nextPlayers = stateRef.current.players;
    if (removed.length) {
      nextPlayers = nextPlayers.map((p) => ({ ...p, positions: (p.positions || []).filter((pp) => !(pp.unit === unit && removed.includes(pp.position))) }));
    }
    commit({ [key]: next, players: nextPlayers });
  };
  const changeOffensePositions = makeChangePositions("offense", "offensePositions");
  const changeDefensePositions = makeChangePositions("defense", "defensePositions");
  const changeKickoffPositions = makeChangePositions("kickoff", "kickoffPositions");
  const changePuntPositions = makeChangePositions("punt", "puntPositions");

  const createGame = (g) => commit({ games: [...stateRef.current.games, g] });
  const updateGame = (g) => commit({ games: stateRef.current.games.map((x) => (x.id === g.id ? g : x)) });
  const deleteGame = (id) => {
    commit({ games: stateRef.current.games.filter((x) => x.id !== id) });
    if (currentGameId === id) setCurrentGameId(null);
  };

  const positionsByUnit = { offense: offensePositions, defense: defensePositions, kickoff: kickoffPositions, punt: puntPositions };

  if (loading) {
    return (
      <div className="td-root flex items-center justify-center h-full" style={{ background: colors.bg, minHeight: 400 }}>
        <GlobalStyle />
        <div className="td-display text-sm uppercase" style={{ color: colors.chalkMuted }}>Loading roster…</div>
      </div>
    );
  }

  return (
    <div className="td-root flex flex-col" style={{ background: colors.bg, minHeight: 600 }}>
      <GlobalStyle />
      <div className="px-4 pt-4 pb-3 sticky top-0 z-10" style={{ background: colors.bg, borderBottom: `2px solid ${colors.gold}` }}>
        <div className="td-display text-2xl uppercase" style={{ color: colors.chalk, letterSpacing: "0.04em" }}>Balls Deep</div>
        <div className="text-xs" style={{ color: colors.chalkMuted }}>Roster &amp; live playtime manager</div>
        {saveError && <div className="text-xs mt-1 flex items-center gap-1" style={{ color: colors.brick }}><AlertCircle size={12} /> Couldn't save changes — try again.</div>}
      </div>

      <div className="flex-1">
        {tab === "roster" && (
          <RosterTab players={players} positionsByUnit={positionsByUnit} onAdd={addPlayer} onUpdate={updatePlayer} onDelete={deletePlayer} onImport={importPlayers} />
        )}
        {tab === "positions" && (
          <PositionsTab
            offensePositions={offensePositions}
            defensePositions={defensePositions}
            kickoffPositions={kickoffPositions}
            puntPositions={puntPositions}
            onChangeOffense={changeOffensePositions}
            onChangeDefense={changeDefensePositions}
            onChangeKickoff={changeKickoffPositions}
            onChangePunt={changePuntPositions}
          />
        )}
        {tab === "gameday" && (
          <GameDayTab
            players={players}
            offensePositions={offensePositions}
            defensePositions={defensePositions}
            kickoffPositions={kickoffPositions}
            puntPositions={puntPositions}
            games={games}
            currentGameId={currentGameId}
            setCurrentGameId={setCurrentGameId}
            onCreateGame={createGame}
            onUpdateGame={updateGame}
            onDeleteGame={deleteGame}
          />
        )}
        {tab === "history" && <HistoryTab players={players} games={games} />}
      </div>

      <div className="fixed bottom-0 left-0 right-0 flex justify-around py-2" style={{ background: colors.panel, borderTop: `1px solid ${colors.line}` }}>
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button key={t.id} onClick={() => setTab(t.id)} className="flex flex-col items-center gap-0.5 px-2 py-1">
              <Icon size={18} color={active ? colors.gold : colors.chalkMuted} />
              <span className="td-display text-[10px] uppercase" style={{ color: active ? colors.gold : colors.chalkMuted, letterSpacing: "0.05em" }}>{t.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
