// A season from before the league was on ESPN, from its week-by-week Google Sheet, saved as
// history/season-<year>.json in the same shape as ESPN's season files (just the parts build.mjs
// reads), so the History tab, records, all-time table and head-to-head include it.
//
//   node scripts/import-season-sheet.mjs 2023 <sheet id>
//
// The sheet has one row per team per week: Team, General Manager (first name), Week, Matchup
// (the other team), W/L, Total Points Scored, ... Weeks 1 to the last regular-season week, then a
// "PLAYOFFS" divider, then the playoff weeks (a 4-team bracket and a consolation bracket).
// Each General Manager is matched to their ESPN member by first name (league.config.json ->
// owners -> short), using the members in data/season-*.json, so it's the same person as in later
// seasons. Run it once; history files are kept in git (data/ isn't).
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';

const [year, sheetId] = process.argv.slice(2);
if (!/^\d{4}$/.test(year || '') || !sheetId) { console.error('Usage: node scripts/import-season-sheet.mjs <year> <sheet id>'); process.exit(1); }
const root = new URL('../', import.meta.url);
const read = (f) => JSON.parse(readFileSync(new URL(f, root), 'utf8'));

// ---------- The sheet ----------
const res = await fetch(`https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv`);
if (!res.ok) throw new Error(`Couldn't download the sheet (HTTP ${res.status}). Is it shared "anyone with the link"?`);
const rows = parseCsv(await res.text());
const head = rows.shift().map((h) => h.trim());
const col = (name) => { const i = head.indexOf(name); if (i < 0) throw new Error(`No "${name}" column`); return i; };
const C = { team: col('Team'), gm: col('General Manager'), week: col('Week'), opp: col('Matchup'), wl: col('W/L'), pts: col('Total Points Scored') };
const lines = rows.filter((r) => /^\d+$/.test(r[C.week]?.trim())).map((r) => ({
  team: r[C.team].trim(), gm: r[C.gm].trim(), week: Number(r[C.week]), opp: r[C.opp].trim(), won: r[C.wl].trim() === 'W', pts: Number(r[C.pts]),
}));
// The regular season ends at the "PLAYOFFS" divider
const divider = rows.findIndex((r) => r[C.week]?.trim().toUpperCase() === 'PLAYOFFS');
const regWeeks = divider < 0 ? Math.max(...lines.map((l) => l.week)) : Math.max(...rows.slice(0, divider).filter((r) => /^\d+$/.test(r[C.week]?.trim())).map((r) => Number(r[C.week])));

// ---------- Members: the same ESPN member as in later seasons ----------
const config = read('league.config.json');
const shortOf = (m) => config.owners[`${m.firstName} ${m.lastName}`.trim()]?.short ?? m.firstName;
const members = new Map();
for (const f of readdirSync(new URL('data/', root)).filter((x) => /^season-\d{4}\.json$/.test(x))) {
  for (const m of read(`data/${f}`).members || []) members.set(shortOf(m), m);
}
const teamsByName = new Map();
for (const l of lines) {
  if (teamsByName.has(l.team)) continue;
  const m = members.get(l.gm);
  if (!m) throw new Error(`No ESPN member for General Manager "${l.gm}" (league.config.json -> owners -> short)`);
  teamsByName.set(l.team, { id: teamsByName.size + 1, name: l.team, primaryOwner: m.id, member: m });
}

// ---------- Schedule: one matchup per pair of rows ----------
const schedule = [];
for (const week of [...new Set(lines.map((l) => l.week))].sort((a, b) => a - b)) {
  const done = new Set();
  for (const l of lines.filter((x) => x.week === week)) {
    if (done.has(l.team)) continue;
    const o = lines.find((x) => x.week === week && x.team === l.opp && x.opp === l.team);
    if (!o) throw new Error(`Week ${week}: no row for ${l.opp} playing ${l.team}`);
    done.add(l.team); done.add(o.team);
    const home = teamsByName.get(l.team), away = teamsByName.get(o.team);
    schedule.push({
      matchupPeriodId: week,
      home: { teamId: home.id, totalPoints: l.pts },
      away: { teamId: away.id, totalPoints: o.pts },
      winner: l.won ? 'HOME' : o.won ? 'AWAY' : 'TIE',
    });
  }
}

// ---------- Regular-season records, seeds and final places ----------
const teams = [...teamsByName.values()].map((t) => {
  const reg = lines.filter((l) => l.team === t.name && l.week <= regWeeks);
  return { ...t, wins: reg.filter((l) => l.won).length, losses: reg.filter((l) => !l.won).length, pointsFor: Math.round(reg.reduce((a, l) => a + l.pts, 0) * 100) / 100 };
});
teams.sort((a, b) => b.wins - a.wins || b.pointsFor - a.pointsFor).forEach((t, i) => { t.playoffSeed = i + 1; });
// Final places from the playoff weeks: each round, winners of a bracket go on to the games for
// its top places, losers to the games for its bottom places
const playoffWeeks = [...new Set(schedule.filter((m) => m.matchupPeriodId > regWeeks).map((m) => m.matchupPeriodId))].sort((a, b) => a - b);
const place = new Map();
const settle = (group, start, wi) => {
  if (group.length === 1) { place.set(group[0], start); return; }
  const games = schedule.filter((m) => m.matchupPeriodId === playoffWeeks[wi] && group.includes(m.home.teamId) && group.includes(m.away.teamId));
  if (!games.length || wi >= playoffWeeks.length) { group.forEach((id, i) => place.set(id, start + i)); return; } // no more games: by seed
  const winners = games.map((g) => (g.winner === 'HOME' ? g.home.teamId : g.away.teamId));
  const losers = games.map((g) => (g.winner === 'HOME' ? g.away.teamId : g.home.teamId));
  settle(winners, start, wi + 1);
  settle(losers, start + winners.length, wi + 1);
};
const bySeed = teams.map((t) => t.id);
const half = bySeed.length / 2;
settle(bySeed.slice(0, half), 1, 0);
settle(bySeed.slice(half), half + 1, 0);

const out = {
  seasonId: Number(year),
  source: `Google Sheet ${sheetId} (imported by scripts/import-season-sheet.mjs)`,
  settings: { scheduleSettings: { matchupPeriodCount: regWeeks, playoffTeamCount: half } },
  status: {},
  members: [...new Map(teams.map((t) => [t.member.id, { id: t.member.id, firstName: t.member.firstName, lastName: t.member.lastName, displayName: t.member.displayName }])).values()],
  teams: teams.map((t) => ({ id: t.id, name: t.name, primaryOwner: t.primaryOwner, playoffSeed: t.playoffSeed, rankCalculatedFinal: place.get(t.id), record: { overall: { wins: t.wins, losses: t.losses, ties: 0, pointsFor: t.pointsFor } } })),
  schedule,
};
mkdirSync(new URL('history/', root), { recursive: true });
writeFileSync(new URL(`history/season-${year}.json`, root), `${JSON.stringify(out, null, 2)}\n`);
console.log(`Saved history/season-${year}.json: ${teams.length} teams, ${regWeeks} regular-season weeks, ${schedule.length} games.`);
for (const t of [...out.teams].sort((a, b) => a.rankCalculatedFinal - b.rankCalculatedFinal)) {
  console.log(`  ${t.rankCalculatedFinal}. ${t.name} (${teamsByName.get(t.name).member.firstName}) ${t.record.overall.wins}-${t.record.overall.losses}, ${t.record.overall.pointsFor} pts, seed ${t.playoffSeed}`);
}

function parseCsv(text) {
  const out = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); out.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); out.push(row); }
  return out;
}
