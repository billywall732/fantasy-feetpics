// Turns data/*.json into site/index.html (data built in) plus site/fonts/.
// Usage: node build.mjs   (run fetch.mjs first)
//        PUBLIC=1 node build.mjs   the public copy ("Fantasy Football") in site-public/: pun team names,
//        first names only, no untracked ice rules, no tracking (league.config.json -> public)
import { readFileSync, writeFileSync, mkdirSync, existsSync, cpSync, readdirSync } from 'node:fs';
import { env } from './env.mjs';

const read = (f) => JSON.parse(readFileSync(new URL(f, import.meta.url), 'utf8'));
const SEASON = Number(env.SEASON);
const PUBLIC = process.env.PUBLIC === '1';
const OUT = PUBLIC ? 'site-public/' : 'site/';

const cur = read(`data/season-${SEASON}.json`);
const box = read(`data/boxscores-${SEASON}.json`);
const txns = [...new Map(read(`data/transactions-${SEASON}.json`).map((x) => [x.id, x])).values()]; // one per transaction ID
const playerIndex = new Map(read('data/players.json').map((p) => [p.id, p]));
const playerStats = new Map(read('data/player-stats.json').map((p) => [p.id, p]));

const POS = { 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'D/ST' };
const SLOT = { 0: 'QB', 2: 'RB', 4: 'WR', 6: 'TE', 16: 'D/ST', 17: 'K', 20: 'Bench', 21: 'IR', 23: 'FLEX' };
const SLOT_ORDER = [0, 2, 4, 6, 23, 16, 17, 20, 21];
const PRO = {
  0: 'FA', 1: 'ATL', 2: 'BUF', 3: 'CHI', 4: 'CIN', 5: 'CLE', 6: 'DAL', 7: 'DEN', 8: 'DET', 9: 'GB', 10: 'TEN',
  11: 'IND', 12: 'KC', 13: 'LV', 14: 'LAR', 15: 'MIA', 16: 'MIN', 17: 'NE', 18: 'NO', 19: 'NYG', 20: 'NYJ',
  21: 'PHI', 22: 'ARI', 23: 'PIT', 24: 'LAC', 25: 'SF', 26: 'SEA', 27: 'TB', 28: 'WSH', 29: 'CAR', 30: 'JAX',
  33: 'BAL', 34: 'HOU',
};
const r1 = (n) => Math.round(n * 10) / 10;
const r2 = (n) => Math.round(n * 100) / 100;
const isStarter = (slot) => slot !== 20 && slot !== 21;

const playerName = (id) => playerStats.get(id)?.name ?? playerIndex.get(id)?.name ?? `Player ${id}`;
const playerPos = (id) => POS[playerStats.get(id)?.pos ?? playerIndex.get(id)?.pos] ?? '?';

// ---------- Seasons ----------
// ESPN's past seasons (data/, fetched each run), plus seasons from before the league was on ESPN,
// kept in git in history/ (made by scripts/import-season-sheet.mjs)
const HISTORY = existsSync(new URL('history/', import.meta.url))
  ? readdirSync(new URL('history/', import.meta.url)).map((f) => f.match(/^season-(\d{4})\.json$/)?.[1]).filter(Boolean).map(Number)
  : [];
const pastSeasons = [...new Set([...(cur.status.previousSeasons || []), ...HISTORY])].filter((y) => y !== SEASON);
const seasonData = (y) => (y === SEASON ? cur
  : existsSync(new URL(`data/season-${y}.json`, import.meta.url)) ? read(`data/season-${y}.json`) : read(`history/season-${y}.json`));

// ---------- Owners (stable across seasons; team names change every year) ----------
const owners = {};
for (const season of [SEASON, ...pastSeasons]) {
  const s = seasonData(season);
  for (const m of s.members || []) {
    owners[m.id] ??= { id: m.id, name: `${m.firstName} ${m.lastName}`.trim(), handle: m.displayName };
  }
}
// The names the league actually uses (ESPN profile names can be jokes). Keyed by ESPN profile name.
const config = read('league.config.json');
for (const o of Object.values(owners)) {
  const c = config.owners[o.name];
  if (c) Object.assign(o, { espnName: o.name, name: c.name, short: c.short, aliases: c.aliases || [] });
}
// Every name an owner goes by, for matching the ice sheet. Kept here, off the page, so the public
// copy can still match "Billy Wall" in the sheet while showing only "Billy".
const ownerNames = Object.fromEntries(Object.values(owners).map((o) => [o.id, [o.name, o.espnName, o.short, o.handle, ...(o.aliases || [])].filter(Boolean)]));
// Names the public copy must never show (first names on their own are fine).
const privateNames = new Set(Object.values(owners).flatMap((o) => [o.handle, ...[o.name, o.espnName, ...(o.aliases || [])].filter((n) => n?.includes(' '))]).filter(Boolean));
const realTeamNames = new Set();
const pubTeam = {}; // ownerId -> { name, abbrev }, public copy only
if (PUBLIC) {
  // The public copy: made-up team names, and each person by first name only
  for (const o of Object.values(owners)) {
    const key = o.espnName ?? o.name, p = config.public.teams[key];
    if (!p) throw new Error(`No public team name for ${key} in league.config.json -> public.teams.`);
    pubTeam[o.id] = p;
    owners[o.id] = { id: o.id, name: o.short ?? o.name.split(' ')[0], short: o.short ?? o.name.split(' ')[0] };
  }
}
const teamName = (t) => { realTeamNames.add(t.name.trim()); return PUBLIC ? pubTeam[t.primaryOwner].name : t.name.trim(); };
const leagueName = PUBLIC ? config.public.name : cur.settings.name.trim();
// Award titles the public copy renames (config public.awards); brand() renames them in the page's code too.
const awardName = (t) => (PUBLIC && config.public.awards?.[t]) || t;

// ---------- Current season ----------
const regWeeks = cur.settings.scheduleSettings.matchupPeriodCount;
const playoffTeams = cur.settings.scheduleSettings.playoffTeamCount;
const currentWeek = cur.status.currentMatchupPeriod;
const doneMatchups = cur.schedule.filter((m) => m.winner !== 'UNDECIDED' && m.matchupPeriodId <= regWeeks);
const doneWeeks = [...new Set(doneMatchups.map((m) => m.matchupPeriodId))].sort((a, b) => a - b);

const teams = cur.teams.map((t) => ({
  id: t.id,
  name: teamName(t),
  abbrev: PUBLIC ? pubTeam[t.primaryOwner].abbrev : t.abbrev,
  ownerId: t.primaryOwner,
  owner: owners[t.primaryOwner]?.name ?? '',
  seed: t.playoffSeed,
  w: t.record.overall.wins,
  l: t.record.overall.losses,
  t: t.record.overall.ties,
  pf: r2(t.record.overall.pointsFor),
  pa: r2(t.record.overall.pointsAgainst),
  weeks: {}, // week -> { score, opp, oppScore, result }
}));
const team = Object.fromEntries(teams.map((t) => [t.id, t]));

for (const m of doneMatchups) {
  const w = m.matchupPeriodId;
  const h = m.home, a = m.away;
  const res = (side) => (m.winner === 'TIE' ? 'T' : m.winner === side ? 'W' : 'L');
  team[h.teamId].weeks[w] = { score: r2(h.totalPoints), opp: a.teamId, oppScore: r2(a.totalPoints), result: res('HOME') };
  team[a.teamId].weeks[w] = { score: r2(a.totalPoints), opp: h.teamId, oppScore: r2(h.totalPoints), result: res('AWAY') };
}

// Optimal lineup for this league's slots: QB, 2 RB, 2 WR, TE, 2 FLEX (RB/WR/TE), D/ST, K.
function optimal(entries) {
  return bestLineup(entries.map((e) => ({ slot: e.lineupSlotId, pos: POS[e.playerPoolEntry.player.defaultPositionId], pts: e.playerPoolEntry.appliedStatTotal || 0 })));
}
// The same, from plain { slot, pos, pts } players (also used for past seasons' box scores in history/).
function bestLineup(players) {
  const pool = players
    .filter((p) => p.slot !== 21)
    .map((p) => ({ pos: p.pos, pts: p.pts }))
    .sort((a, b) => b.pts - a.pts);
  let total = 0;
  const take = (pred, n) => {
    for (let i = 0; i < pool.length && n > 0; i++) {
      if (!pool[i].used && pred(pool[i].pos)) { pool[i].used = true; total += pool[i].pts; n--; }
    }
  };
  take((p) => p === 'QB', 1);
  take((p) => p === 'RB', 2);
  take((p) => p === 'WR', 2);
  take((p) => p === 'TE', 1);
  take((p) => p === 'K', 1);
  take((p) => p === 'D/ST', 1);
  take((p) => p === 'RB' || p === 'WR' || p === 'TE', 2);
  return total;
}

// ---------- Live games ----------
// A player's game is "pre" before kickoff, "live" for about 3.5 hours after, then "final". No game that week is a bye.
const kickoffs = existsSync(new URL('data/nfl-kickoffs.json', import.meta.url)) ? read('data/nfl-kickoffs.json') : {};
const weekSpans = existsSync(new URL('data/nfl-weeks.json', import.meta.url)) ? read('data/nfl-weeks.json') : {};
const NOW = Date.now();
const GAME_LENGTH = 3.5 * 3600e3;
function gameState(sp, proTeamId) {
  const k = kickoffs[sp]?.[proTeamId];
  if (!k) return { status: 'bye', left: 0 };
  if (NOW < k) return { status: 'pre', left: 1, kickoff: k };
  if (NOW >= k + GAME_LENGTH) return { status: 'final', left: 0, kickoff: k };
  return { status: 'live', left: Math.max(0.05, 1 - (NOW - k) / (3.1 * 3600e3)), kickoff: k };
}
// Normal CDF, for win chances from projected margin and remaining uncertainty.
function normCdf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return 0.5 * (1 + Math.sign(x) * erf);
}
// A team's spread of possible outcomes shrinks as its projected points get played: about ±25 pts for a full 140-pt week.
const spreadFor = (remaining) => 2.1 * Math.sqrt(Math.max(0, remaining));
// Live projected final: actual points for finished players, actual plus the unplayed share of the
// projection for players mid-game, and the full projection only for players who haven't kicked off.
// (ESPN's team-level projected total stays at its pre-game number, so it isn't used once games start.)
function liveSide(side, sp) {
  const starters = side.rosterForCurrentScoringPeriod.entries.filter((e) => isStarter(e.lineupSlotId));
  let score = 0, remaining = 0, toPlay = 0, playing = 0;
  for (const e of starters) {
    const g = gameState(sp, e.playerPoolEntry.player.proTeamId);
    const p = e.playerPoolEntry.appliedStatTotal || 0;
    const proj = e.playerPoolEntry.player.stats?.find((s) => s.statSourceId === 1 && s.scoringPeriodId === sp)?.appliedTotal || 0;
    score += p;
    if (g.status === 'pre') { remaining += proj; toPlay++; }
    if (g.status === 'live') { remaining += proj * g.left; playing++; }
  }
  return { score: r2(score), proj: r1(score + remaining), remaining, toPlay, playing };
}
const winChance = (a, b) => {
  const sd = Math.hypot(spreadFor(a.remaining), spreadFor(b.remaining));
  if (sd < 0.5) return a.score > b.score ? 1 : a.score < b.score ? 0 : 0.5;
  return normCdf((a.proj - b.proj) / sd);
};

const lineupOf = (side, sp) =>
  side.rosterForCurrentScoringPeriod.entries
    .map((e) => {
      const p = e.playerPoolEntry.player;
      const proj = p.stats?.find((s) => s.statSourceId === 1)?.appliedTotal;
      const g = gameState(sp, p.proTeamId);
      return {
        slot: e.lineupSlotId,
        name: p.fullName,
        pos: POS[p.defaultPositionId] ?? '?',
        pro: PRO[p.proTeamId] ?? '',
        pts: r2(e.playerPoolEntry.appliedStatTotal || 0),
        proj: proj == null ? null : r1(proj),
        status: g.status,
        kickoff: g.kickoff ?? null,
      };
    })
    .sort((a, b) => SLOT_ORDER.indexOf(a.slot) - SLOT_ORDER.indexOf(b.slot));

const matchups = {}; // week -> [{ home, away, homeScore, awayScore, homeProj, awayProj, winner, homeLineup, awayLineup }]
const playerWeeks = []; // starter performances, for awards
const pts = (e) => e.playerPoolEntry.appliedStatTotal || 0;
const projOf = (e) => e.playerPoolEntry.player.stats?.find((s) => s.statSourceId === 1)?.appliedTotal || 0;
const who = (e) => ({ name: e.playerPoolEntry.player.fullName, pos: POS[e.playerPoolEntry.player.defaultPositionId] ?? '?', pts: r2(pts(e)) });
for (const [wk, games] of Object.entries(box)) {
  const w = Number(wk);
  if (w > regWeeks) continue; // playoff weeks are handled by the ice tracker only
  matchups[w] = games.map((m) => {
    for (const side of [m.home, m.away]) {
      const tw = team[side.teamId].weeks[w];
      const entries = side.rosterForCurrentScoringPeriod.entries;
      if (tw) {
        const starters = entries.filter((e) => isStarter(e.lineupSlotId)).sort((a, b) => pts(b) - pts(a));
        const bench = entries.filter((e) => e.lineupSlotId === 20).sort((a, b) => pts(b) - pts(a));
        tw.optimal = r2(optimal(entries));
        tw.bench = r2(bench.reduce((s, e) => s + pts(e), 0));
        tw.proj = r2(starters.reduce((s, e) => s + projOf(e), 0));
        tw.top3 = starters.slice(0, 3).map((e) => ({ ...who(e), pct: r1((pts(e) / tw.score) * 100) }));
        tw.worst = who(starters.at(-1));
        tw.bestBench = bench.length ? who(bench[0]) : null;
        for (const e of entries.filter((e) => isStarter(e.lineupSlotId))) {
          playerWeeks.push({ week: w, teamId: side.teamId, name: e.playerPoolEntry.player.fullName, pos: POS[e.playerPoolEntry.player.defaultPositionId], pro: PRO[e.playerPoolEntry.player.proTeamId] ?? '', pts: r2(e.playerPoolEntry.appliedStatTotal || 0) });
        }
      }
    }
    // The week in progress: live scores, projected finals and win chances once its first game has kicked off.
    const inProgress = !doneWeeks.includes(w) && NOW >= (weekSpans[w]?.first ?? Infinity);
    let live = null;
    if (inProgress) {
      const h = liveSide(m.home, w), a = liveSide(m.away, w);
      live = { home: h, away: a, homeWin: Math.round(winChance(h, a) * 1000) / 10 };
    }
    return {
      home: m.home.teamId,
      away: m.away.teamId,
      homeScore: r2(m.home.totalPoints),
      awayScore: r2(m.away.totalPoints),
      homeProj: m.home.totalProjectedPoints == null ? null : r1(m.home.totalProjectedPoints),
      awayProj: m.away.totalProjectedPoints == null ? null : r1(m.away.totalProjectedPoints),
      winner: m.winner,
      live,
      homeLineup: lineupOf(m.home, w),
      awayLineup: lineupOf(m.away, w),
    };
  });
}

// Upcoming schedule for weeks without box scores yet.
const upcoming = {};
for (const m of cur.schedule.filter((m) => m.matchupPeriodId > currentWeek && m.matchupPeriodId <= regWeeks)) {
  (upcoming[m.matchupPeriodId] ??= []).push({ home: m.home.teamId, away: m.away.teamId });
}

// All-play record, luck, and power rankings as of a given week.
function seasonStats(throughWeek) {
  const weeks = doneWeeks.filter((w) => w <= throughWeek);
  const out = {};
  for (const t of teams) {
    const scores = weeks.map((w) => t.weeks[w].score);
    let apW = 0, apL = 0, apT = 0;
    for (const w of weeks) {
      for (const o of teams) {
        if (o.id === t.id) continue;
        const d = t.weeks[w].score - o.weeks[w].score;
        if (d > 0) apW++; else if (d < 0) apL++; else apT++;
      }
    }
    const wins = weeks.filter((w) => t.weeks[w].result === 'W').length + weeks.filter((w) => t.weeks[w].result === 'T').length / 2;
    const avg = scores.reduce((a, b) => a + b, 0) / (scores.length || 1);
    const high = Math.max(...scores), low = Math.min(...scores);
    const winPct = wins / (weeks.length || 1);
    // Oberon Mt. Power formula: ((avg * 6) + ((high + low) * 2) + ((win% * 200) * 2)) / 10
    const power = (avg * 6 + (high + low) * 2 + winPct * 200 * 2) / 10;
    const expected = (apW + apT / 2) / (teams.length - 1);
    out[t.id] = { apW, apL, apT, expected, luck: wins - expected, avg, high, low, power };
  }
  const ranked = Object.entries(out).sort((a, b) => b[1].power - a[1].power);
  ranked.forEach(([id], i) => (out[id].powerRank = i + 1));
  return out;
}
const lastWeek = doneWeeks.at(-1);
const now = seasonStats(lastWeek);
const prev = doneWeeks.length > 1 ? seasonStats(doneWeeks.at(-2)) : null;

for (const t of teams) {
  const s = now[t.id];
  const results = doneWeeks.map((w) => t.weeks[w].result);
  let streak = 0;
  for (let i = results.length - 1; i >= 0 && results[i] === results.at(-1); i--) streak++;
  const sd = Math.sqrt(doneWeeks.reduce((a, w) => a + (t.weeks[w].score - s.avg) ** 2, 0) / doneWeeks.length);
  const optimalTotal = doneWeeks.reduce((a, w) => a + (t.weeks[w].optimal ?? t.weeks[w].score), 0);
  Object.assign(t, {
    streak: `${results.at(-1)}${streak}`,
    allPlay: `${s.apW}-${s.apL}${s.apT ? '-' + s.apT : ''}`,
    allPlayPct: r2(s.apW / (s.apW + s.apL + s.apT)),
    expectedWins: r1(s.expected),
    luck: r1(s.luck),
    avg: r1(s.avg),
    high: r2(s.high),
    low: r2(s.low),
    sd: r1(sd),
    power: r1(s.power),
    powerRank: s.powerRank,
    powerMove: prev ? prev[t.id].powerRank - s.powerRank : 0,
    last3: r1(doneWeeks.slice(-3).reduce((a, w) => a + t.weeks[w].score, 0) / Math.min(3, doneWeeks.length)),
    efficiency: r1((t.pf / optimalTotal) * 100),
    benchLeft: r1(optimalTotal - t.pf),
    optimalLosses: doneWeeks.filter((w) => t.weeks[w].result === 'L' && t.weeks[w].optimal > t.weeks[w].oppScore).length,
  });
}

// Rosters with season totals.
const rosters = {};
for (const t of cur.teams) {
  rosters[t.id] = t.roster.entries
    .map((e) => {
      const p = e.playerPoolEntry.player;
      const st = playerStats.get(e.playerId);
      return {
        name: p.fullName,
        pos: POS[p.defaultPositionId] ?? '?',
        pro: PRO[p.proTeamId] ?? '',
        slot: e.lineupSlotId,
        injury: p.injuryStatus && !['ACTIVE', 'NORMAL'].includes(p.injuryStatus) ? p.injuryStatus : null,
        how: e.acquisitionType,
        seasonPts: r1(st?.seasonPts ?? 0),
        posRank: st?.posRank ?? null,
      };
    })
    .sort((a, b) => SLOT_ORDER.indexOf(a.slot) - SLOT_ORDER.indexOf(b.slot) || b.seasonPts - a.seasonPts);
}

// Draft with value vs. where each position was taken.
const posPickCount = {};
const draft = cur.draftDetail.picks.map((p) => {
  const pos = playerPos(p.playerId);
  posPickCount[pos] = (posPickCount[pos] || 0) + 1;
  const st = playerStats.get(p.playerId);
  return {
    pick: p.overallPickNumber,
    round: p.roundId,
    roundPick: p.roundPickNumber,
    teamId: p.teamId,
    name: playerName(p.playerId),
    pos,
    posDrafted: posPickCount[pos],
    seasonPts: r1(st?.seasonPts ?? 0),
    posRank: st?.posRank || null,
    keeper: p.keeper,
  };
});
for (const d of draft) d.value = d.posRank ? d.posDrafted - d.posRank : null;

// Transactions (executed adds/drops).
const moves = txns
  .filter((x) => (x.type === 'WAIVER' || x.type === 'FREEAGENT') && x.status === 'EXECUTED')
  .map((x) => ({
    date: x.processDate ?? x.proposedDate,
    week: x.scoringPeriodId,
    teamId: x.teamId,
    type: x.type,
    adds: x.items.filter((i) => i.type === 'ADD').map((i) => ({ id: i.playerId, name: playerName(i.playerId), pos: playerPos(i.playerId) })),
    drops: x.items.filter((i) => i.type === 'DROP').map((i) => ({ id: i.playerId, name: playerName(i.playerId), pos: playerPos(i.playerId) })),
  }))
  .sort((a, b) => b.date - a.date);
for (const t of teams) t.moves = moves.filter((m) => m.teamId === t.id).length;

// ---------- Waiver wire & trades ----------
// Points a player scored in a team's starting lineup, by week (final weeks only).
const startedPts = new Map(); // `${teamId}:${playerId}` -> [{ week, pts }]
for (const w of doneWeeks) {
  for (const m of box[w] || []) {
    for (const side of [m.home, m.away].filter(Boolean)) {
      for (const e of side.rosterForCurrentScoringPeriod.entries) {
        if (!isStarter(e.lineupSlotId)) continue;
        const k = `${side.teamId}:${e.playerId}`;
        if (!startedPts.has(k)) startedPts.set(k, []);
        startedPts.get(k).push({ week: w, pts: e.playerPoolEntry.appliedStatTotal || 0 });
      }
    }
  }
}
const ptsFor = (teamId, playerId, fromWeek) =>
  r1((startedPts.get(`${teamId}:${playerId}`) || []).filter((x) => x.week >= fromWeek).reduce((s, x) => s + x.pts, 0));
const startsFor = (teamId, playerId, fromWeek) =>
  (startedPts.get(`${teamId}:${playerId}`) || []).filter((x) => x.week >= fromWeek).length;

// Every pickup, valued by what it scored as a starter for the team that added it.
const seenAdd = new Set();
const pickups = [...moves].reverse().flatMap((m) =>
  m.adds.filter((a) => {
    const k = `${m.teamId}:${a.id}`;
    if (seenAdd.has(k)) return false;
    seenAdd.add(k);
    return true;
  }).map((a) => ({ ...a, teamId: m.teamId, week: m.week, type: m.type, date: m.date, pts: ptsFor(m.teamId, a.id, m.week), starts: startsFor(m.teamId, a.id, m.week) }))
);
// Every drop, valued by what the player scored as a starter for other teams afterwards.
const dropsList = moves.flatMap((m) =>
  m.drops.map((d) => {
    const others = teams.filter((t) => t.id !== m.teamId).map((t) => ({ teamId: t.id, pts: ptsFor(t.id, d.id, m.week + 1) })).filter((x) => x.pts > 0);
    const best = others.sort((a, b) => b.pts - a.pts)[0];
    return { ...d, teamId: m.teamId, week: m.week, date: m.date, laterPts: best?.pts ?? 0, laterTeamId: best?.teamId ?? null };
  })
);

// Trades, from the league activity feed (message type 244 = player traded from one team to another).
const activity = existsSync(new URL(`data/activity-${SEASON}.json`, import.meta.url)) ? read(`data/activity-${SEASON}.json`) : [];
const nflWeekEnds = Object.entries(read('data/nfl-weeks.json')).map(([sp, w]) => [Number(sp), w.last]).sort((a, b) => a[0] - b[0]);
const weekOf = (ms) => nflWeekEnds.find(([, last]) => ms <= last + 6 * 3600e3)?.[0] ?? cur.status.latestScoringPeriod;
const tradeList = activity
  .filter((t) => t.messages.some((m) => m.type === 244))
  .map((t) => {
    const week = weekOf(t.date);
    const msgs = t.messages.filter((m) => m.type === 244);
    const teamIds = [...new Set(msgs.flatMap((m) => [m.from, m.to]))];
    return {
      date: t.date,
      week,
      sides: teamIds.map((id) => ({
        teamId: id,
        received: msgs.filter((m) => m.to === id).map((m) => ({
          id: m.playerId, name: playerName(m.playerId), pos: playerPos(m.playerId), from: m.from,
          pts: ptsFor(id, m.playerId, week), starts: startsFor(id, m.playerId, week),
        })),
      })),
    };
  })
  .sort((a, b) => b.date - a.date);
for (const tr of tradeList) for (const s of tr.sides) s.total = r1(s.received.reduce((a, p) => a + p.pts, 0));

// Trade offers sent (ESPN repeats proposals across weeks, so count each once).
const offers = new Map();
for (const x of txns.filter((x) => x.type === 'TRADE_PROPOSAL')) offers.set(x.id, x.teamId);

const wireTeams = teams.map((t) => {
  const mine = moves.filter((m) => m.teamId === t.id);
  const myPickups = pickups.filter((p) => p.teamId === t.id).sort((a, b) => b.pts - a.pts);
  return {
    teamId: t.id,
    waivers: mine.filter((m) => m.type === 'WAIVER').reduce((s, m) => s + m.adds.length, 0),
    freeAgents: mine.filter((m) => m.type === 'FREEAGENT').reduce((s, m) => s + m.adds.length, 0),
    drops: mine.reduce((s, m) => s + m.drops.length, 0),
    trades: tradeList.filter((tr) => tr.sides.some((s) => s.teamId === t.id)).length,
    offers: [...offers.values()].filter((id) => id === t.id).length,
    pickupPts: r1(myPickups.reduce((s, p) => s + p.pts, 0)),
    best: myPickups[0] && myPickups[0].pts > 0 ? { name: myPickups[0].name, pos: myPickups[0].pos, pts: myPickups[0].pts } : null,
  };
}).sort((a, b) => b.pickupPts - a.pickupPts);

const wire = {
  teams: wireTeams,
  pickups: [...pickups].sort((a, b) => b.pts - a.pts).slice(0, 10),
  regrets: dropsList.filter((d) => d.laterPts > 0).sort((a, b) => b.laterPts - a.laterPts).slice(0, 8),
  trades: tradeList,
  feed: moves.map((m) => ({ ...m, adds: m.adds.map(({ name, pos }) => ({ name, pos })), drops: m.drops.map(({ name, pos }) => ({ name, pos })) })),
};
const trades = tradeList.length;

// Season awards.
const games = doneMatchups.map((m) => ({
  week: m.matchupPeriodId,
  winner: m.winner === 'HOME' ? m.home.teamId : m.away.teamId,
  loser: m.winner === 'HOME' ? m.away.teamId : m.home.teamId,
  ws: Math.max(m.home.totalPoints, m.away.totalPoints),
  ls: Math.min(m.home.totalPoints, m.away.totalPoints),
}));
const teamWeeks = teams.flatMap((t) => doneWeeks.map((w) => ({ teamId: t.id, week: w, ...t.weeks[w] })));
const by = (arr, f) => [...arr].sort((a, b) => f(b) - f(a))[0];
const fmt = (n) => n.toFixed(2);
const hi = by(teamWeeks, (x) => x.score);
const lo = by(teamWeeks, (x) => -x.score);
const blow = by(games, (g) => g.ws - g.ls);
const close = by(games, (g) => -(g.ws - g.ls));
const sadLoss = by(games, (g) => g.ls);
const ugly = by(games, (g) => -g.ws);
// "Tetairoa McMillan (WR, CAR) scored 45.20 in week 4; the team won 154.12–106.32"
const playerNote = (p) => {
  const g = team[p.teamId].weeks[p.week];
  const result = g ? `; the team ${g.result === 'W' ? 'won' : g.result === 'L' ? 'lost' : 'tied'} ${fmt(g.score)}–${fmt(g.oppScore)} vs ${team[g.opp].name}` : '';
  return `${p.name} (${p.pos}${p.pro ? ', ' + p.pro : ''}) scored ${fmt(p.pts)} in week ${p.week}${result}`;
};
const bestPlayer = by(playerWeeks, (p) => p.pts);
const worstStarter = by(playerWeeks.filter((p) => p.pos !== 'D/ST' && p.pos !== 'K'), (p) => -p.pts);
const coach = by(teams, (t) => t.efficiency);
const benchy = by(teams, (t) => t.benchLeft);
const lucky = by(teams, (t) => t.luck);
const unlucky = by(teams, (t) => -t.luck);
const tinkerer = by(teams, (t) => t.moves);
const awards = [
  { title: 'Top score of the season', value: fmt(hi.score), teamId: hi.teamId, note: `Week ${hi.week} vs ${team[hi.opp].name}` },
  { title: 'Lowest score', value: fmt(lo.score), teamId: lo.teamId, note: `Week ${lo.week} vs ${team[lo.opp].name}` },
  { title: 'Biggest blowout', value: `+${fmt(blow.ws - blow.ls)}`, teamId: blow.winner, note: `Week ${blow.week}: ${fmt(blow.ws)} to ${fmt(blow.ls)} over ${team[blow.loser].name}` },
  { title: 'Closest game', value: fmt(close.ws - close.ls), teamId: close.winner, note: `Week ${close.week}: edged ${team[close.loser].name}, ${fmt(close.ws)} to ${fmt(close.ls)}` },
  { title: 'Most points in a loss', value: fmt(sadLoss.ls), teamId: sadLoss.loser, note: `Week ${sadLoss.week}, lost to ${team[sadLoss.winner].name}` },
  { title: 'Ugliest win', value: fmt(ugly.ws), teamId: ugly.winner, note: `Week ${ugly.week}: won with just ${fmt(ugly.ws)}, beating ${team[ugly.loser].name} (${fmt(ugly.ls)})` },
  { title: 'Best player week', value: fmt(bestPlayer.pts), teamId: bestPlayer.teamId, note: playerNote(bestPlayer) },
  { title: 'Worst starter week', value: fmt(worstStarter.pts), teamId: worstStarter.teamId, note: playerNote(worstStarter) },
  { title: 'Coach of the year', value: `${coach.efficiency}%`, teamId: coach.id, note: 'Highest share of the best possible lineup actually started' },
  { title: awardName('Bench Cuck'), value: fmt(benchy.benchLeft), teamId: benchy.id, note: `Points short of the optimal lineup; ${benchy.optimalLosses} losses would have been wins` },
  { title: 'Luckiest record', value: signed(lucky.luck), teamId: lucky.id, note: `${lucky.w}-${lucky.l} actual vs ${lucky.expectedWins} expected wins` },
  { title: 'Unluckiest record', value: signed(unlucky.luck), teamId: unlucky.id, note: `${unlucky.w}-${unlucky.l} actual vs ${unlucky.expectedWins} expected wins` },
  { title: 'Waiver wire addict', value: String(tinkerer.moves), teamId: tinkerer.id, note: 'Waiver claims and free-agent pickups' },
];
function signed(n) { return (n > 0 ? '+' : '') + n.toFixed(1); }

// Season average as of each week, and weekly highs and lows (the sheet's "Highs and Lows" tab).
for (const t of teams) {
  let sum = 0;
  doneWeeks.forEach((w, i) => { sum += t.weeks[w].score; t.weeks[w].avgToDate = r2(sum / (i + 1)); });
}
const highsLows = doneWeeks.map((w) => {
  const sorted = [...teams].sort((a, b) => b.weeks[w].score - a.weeks[w].score);
  const hi = sorted[0], lo = sorted.at(-1);
  return { week: w, high: { teamId: hi.id, score: hi.weeks[w].score }, low: { teamId: lo.id, score: lo.weeks[w].score }, diff: r2(hi.weeks[w].score - lo.weeks[w].score) };
});

// ---------- Ice ----------
// One ice per instance: the week's lowest team score, and every starter with 0 or fewer points.
// Doubled in the playoffs. Due by Thursday night kickoff (8:15 PM ET); a missed deadline doubles it (stated rule, not tracked).
const nflWeeks = read('data/nfl-weeks.json');
const periodOf = {};
for (const [mp, sps] of Object.entries(cur.settings.scheduleSettings.matchupPeriods)) for (const sp of sps) periodOf[sp] = Number(mp);
const ET = 'America/New_York';
const etParts = (ms) => Object.fromEntries(
  new Intl.DateTimeFormat('en-US', { timeZone: ET, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short', hour: 'numeric', hourCycle: 'h23' })
    .formatToParts(new Date(ms)).map((p) => [p.type, p.value])
);
function etToUtc(y, mo, d, h, min = 0) {
  for (const off of [4, 5]) {
    const t = Date.UTC(y, mo - 1, d, h + off, min);
    const p = etParts(t);
    if (Number(p.hour) === h && Number(p.day) === new Date(Date.UTC(y, mo - 1, d)).getUTCDate()) return t;
  }
  return Date.UTC(y, mo - 1, d, h + 5, min);
}
// Ices are due by Thursday night kickoff, 8:15 PM ET, on the Thursday after the week's last game.
// A fixed time: it stays 8:15 even when the next week starts earlier (Thanksgiving, opening night).
function deadlineFor(sp) {
  const last = nflWeeks[sp]?.last;
  if (!last) return null;
  const p = etParts(last);
  const days = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  let ahead = (4 - days[p.weekday] + 7) % 7 || 7; // the next Thursday after the last game
  const d = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day) + ahead));
  return etToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), 20, 15);
}
const multiplier = config.ice?.playoffMultiplier ?? 2;
const latestSp = cur.status.latestScoringPeriod;
const iceWeeks = [];
for (const [spKey, games] of Object.entries(box)) {
  const sp = Number(spKey);
  const lastGame = nflWeeks[sp]?.last ?? 0;
  // Final once ESPN has moved on to the next week, or six hours after the week's last kickoff.
  const final = sp < latestSp || Date.now() > lastGame + 6 * 3600e3;
  const playoff = periodOf[sp] > regWeeks;
  const mult = playoff ? multiplier : 1;
  const sides = games.flatMap((m) => [m.home, m.away].filter(Boolean));
  const scored = sides.map((s) => {
    const starters = s.rosterForCurrentScoringPeriod.entries.filter((e) => isStarter(e.lineupSlotId));
    return { teamId: s.teamId, score: r2(starters.reduce((a, e) => a + pts(e), 0)), duds: starters.filter((e) => pts(e) <= 0).map(who) };
  });
  const entries = [];
  // The week's top score (ties all count), for the "highest score of the week" email. Not an ice.
  const top = final && scored.length ? scored.filter((s) => s.score === Math.max(...scored.map((x) => x.score))).map((s) => ({ teamId: s.teamId, score: s.score })) : [];
  if (final) {
    const low = Math.min(...scored.map((s) => s.score));
    for (const s of scored) {
      if (s.score === low) entries.push({ teamId: s.teamId, kind: 'lowest', score: s.score, reason: 'Lowest score of the week', detail: f2(s.score), ices: mult });
      for (const d of s.duds) entries.push({ teamId: s.teamId, kind: 'dud', player: d.name, pos: d.pos, pts: d.pts, reason: `${d.name} scored ${f2(d.pts)}`, detail: d.pos, ices: mult });
    }
  }
  const byTeam = {};
  for (const e of entries) (byTeam[e.teamId] ??= { teamId: e.teamId, ownerId: team[e.teamId].ownerId, ices: 0, reasons: [] }).ices += e.ices;
  for (const e of entries) byTeam[e.teamId].reasons.push(e);

  // The week in progress (from Thursday's kickoff): ices already locked in, and who's at risk.
  let live = null;
  if (!final && NOW >= (nflWeeks[sp]?.first ?? Infinity)) {
    const locked = [], scoreless = [];
    for (const s of sides) {
      for (const e of s.rosterForCurrentScoringPeriod.entries.filter((e) => isStarter(e.lineupSlotId))) {
        const g = gameState(sp, e.playerPoolEntry.player.proTeamId);
        if (pts(e) > 0) continue;
        const row = { teamId: s.teamId, ...who(e), pro: PRO[e.playerPoolEntry.player.proTeamId] ?? '', kickoff: g.kickoff ?? null };
        if (g.status === 'final') locked.push(row);
        else if (g.status === 'live') scoreless.push(row);
      }
    }
    // Chance of finishing with the week's lowest score: simulate each team around its projected final.
    const proj = sides.map((s) => ({ teamId: s.teamId, ...liveSide(s, sp) }));
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const gauss = () => Math.sqrt(-2 * Math.log(rand() || 1e-9)) * Math.cos(2 * Math.PI * rand());
    const lowCount = Object.fromEntries(proj.map((p) => [p.teamId, 0]));
    const RUNS = 5000;
    for (let i = 0; i < RUNS; i++) {
      let lowId = null, low = Infinity;
      for (const p of proj) {
        const v = p.proj + gauss() * spreadFor(p.remaining);
        if (v < low) { low = v; lowId = p.teamId; }
      }
      lowCount[lowId]++;
    }
    const lowest = proj
      .map((p) => ({ teamId: p.teamId, score: p.score, proj: p.proj, toPlay: p.toPlay, playing: p.playing, chance: Math.round((lowCount[p.teamId] / RUNS) * 100) }))
      .sort((a, b) => b.chance - a.chance);
    live = { asOf: NOW, locked, scoreless, lowest };
  }

  iceWeeks.push({
    week: sp,
    matchupPeriod: periodOf[sp],
    playoff,
    final,
    deadline: deadlineFor(sp),
    owed: Object.values(byTeam).sort((a, b) => b.ices - a.ices),
    top,
    live,
  });
}
for (const t of teams) for (const w of doneWeeks) t.weeks[w].ices = iceWeeks.find((x) => x.week === w)?.owed.find((o) => o.teamId === t.id)?.ices ?? 0;

// Locked-in ices that aren't due yet, for notify.mjs to email (never published: owner names stay in data/).
// Duds lock when the player's game ends; the lowest score locks when the week is final. The week's
// highest score is emailed in the same window (from the week going final until the next kickoff).
{
  const deadlineText = (ms) => new Date(ms).toLocaleString('en-US', { timeZone: ET, weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' ET';
  const events = new Map();
  for (const wk of iceWeeks) {
    if (!wk.deadline || wk.deadline <= NOW) continue;
    const base = (teamId) => ({
      season: SEASON, week: wk.week, teamId, owner: owners[team[teamId].ownerId]?.name ?? '', team: team[teamId].name,
      deadline: wk.deadline, deadlineText: deadlineText(wk.deadline), ices: wk.playoff ? multiplier : 1, playoff: wk.playoff,
    });
    const dud = (teamId, r) => {
      const id = `${SEASON}-w${wk.week}-dud-${teamId}-${r.player}`;
      if (!events.has(id)) events.set(id, { id, kind: 'dud', player: r.player, pos: r.pos, pro: r.pro ?? '', pts: r.pts, ...base(teamId) });
    };
    for (const o of wk.owed) {
      for (const r of o.reasons) {
        if (r.kind === 'lowest') events.set(`${SEASON}-w${wk.week}-lowest-${o.teamId}`, { id: `${SEASON}-w${wk.week}-lowest-${o.teamId}`, kind: 'lowest', score: r.score, ...base(o.teamId) });
        else if (r.kind === 'dud') dud(o.teamId, r);
      }
    }
    for (const t of wk.top || []) {
      const id = `${SEASON}-w${wk.week}-highest-${t.teamId}`;
      events.set(id, { id, kind: 'highest', score: t.score, ...base(t.teamId) });
    }
    // Emails can't be taken back, so mid-week duds wait until well after the game (overtime, delays).
    for (const r of wk.live?.locked || []) {
      if (r.kickoff && NOW >= r.kickoff + 4.5 * 3600e3) dud(r.teamId, { player: r.name, pos: r.pos, pro: r.pro, pts: r.pts });
    }
  }
  // Only the private build feeds notify.mjs; the public copy never sends email.
  if (!PUBLIC) writeFileSync(new URL('data/ice-events.json', import.meta.url), JSON.stringify([...events.values()], null, 2));
}
function f2(n) { return Number(n).toFixed(2); }

// Ice log (completed ices with times) from the Google Sheet.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim()));
}
const nameToOwner = new Map();
for (const [id, names] of Object.entries(ownerNames)) for (const n of names) if (!nameToOwner.has(n.toLowerCase())) nameToOwner.set(n.toLowerCase(), id);
const iceLog = [], iceLogAll = [];
const unmatched = new Set();
if (existsSync(new URL('data/ice-log.csv', import.meta.url))) {
  const [header, ...rows] = parseCsv(readFileSync(new URL('data/ice-log.csv', import.meta.url), 'utf8'));
  const col = (re) => header.findIndex((h) => re.test(h));
  const c = { who: col(/manager|name/i), week: col(/week/i), why: col(/why|reason/i), date: col(/date/i), time: col(/time completed/i), secs: col(/time of ice|seconds|duration/i), season: col(/season|year/i), note: col(/note/i) };
  // Which season an ice belongs to: a Season (or Year) column if the sheet has one (filled in on the
  // first row of each season, so a blank carries down the one above), otherwise the date (January and
  // February ices belong to the season before), otherwise this season.
  let carried = null;
  const seasonOf = (r) => {
    const s = Number(String(r[c.season] ?? '').trim());
    if (s > 2000) return (carried = s);
    if (carried) return carried;
    const d = String(r[c.date] ?? '').match(/^(\d{1,2})\/\d{1,2}\/(\d{4})/);
    return d ? Number(d[2]) - (Number(d[1]) < 3 ? 1 : 0) : SEASON;
  };
  for (const r of rows) {
    const name = (r[c.who] || '').trim();
    if (!name) continue;
    const ownerId = nameToOwner.get(name.toLowerCase());
    if (!ownerId) { unmatched.add(name); continue; }
    const secs = parseFloat(String(r[c.secs] || '').replace(/[^\d.]/g, ''));
    iceLogAll.push({ ownerId, season: seasonOf(r), week: Number(r[c.week]) || null, why: (r[c.why] || '').trim(), date: (r[c.date] || '').trim(), time: (r[c.time] || '').trim(), secs: Number.isFinite(secs) ? secs : null,
      // The sheet's Notes (extensions, missed ices) can be personal, so only the league's own site shows them.
      note: PUBLIC ? '' : String(r[c.note] ?? '').trim().replace(/^\*+|\*+$/g, '').trim() });
  }
}
if (unmatched.size) console.warn(`Ice log names not matched to an owner (add them as aliases in league.config.json): ${[...unmatched].join(', ')}`);
// The Ice tab and the season awards use this season's ices; the All-time awards use the whole log.
iceLog.push(...iceLogAll.filter((x) => x.season === SEASON));

const iceTable = teams.map((t) => {
  const earned = iceWeeks.flatMap((w) => w.owed.filter((o) => o.teamId === t.id));
  const reasons = earned.flatMap((o) => o.reasons);
  const times = iceLog.filter((x) => x.ownerId === t.ownerId && x.secs != null).map((x) => x.secs);
  return {
    ownerId: t.ownerId,
    teamId: t.id,
    earned: reasons.reduce((s, r) => s + r.ices, 0),
    lowest: reasons.filter((r) => r.reason.startsWith('Lowest')).reduce((s, r) => s + r.ices, 0),
    duds: reasons.filter((r) => !r.reason.startsWith('Lowest')).reduce((s, r) => s + r.ices, 0),
    logged: times.length,
    avg: times.length ? r2(times.reduce((a, b) => a + b, 0) / times.length) : null,
    best: times.length ? Math.min(...times) : null,
    worst: times.length ? Math.max(...times) : null,
  };
}).sort((a, b) => b.earned - a.earned || (a.avg ?? 99) - (b.avg ?? 99));

// Ice awards: most ices earned, and the fastest and slowest single ice in the log.
const teamOfOwner = (ownerId) => teams.find((t) => t.ownerId === ownerId);
const timedIces = iceLog.filter((x) => x.secs != null && teamOfOwner(x.ownerId));
const iceNote = (x) => `${x.why}${x.week ? `, week ${x.week}` : ''}${x.date ? ` · ${x.date}` : ''}`;
if (timedIces.length) {
  const fastest = by(timedIces, (x) => -x.secs), slowest = by(timedIces, (x) => x.secs);
  awards.push(
    { title: 'Fastest ice', value: `${fastest.secs.toFixed(2)} s`, teamId: teamOfOwner(fastest.ownerId).id, note: iceNote(fastest) },
    { title: 'Slowest ice', value: `${slowest.secs.toFixed(2)} s`, teamId: teamOfOwner(slowest.ownerId).id, note: iceNote(slowest) },
  );
}
// Most completed trades (ties broken by trade offers sent).
const dealer = [...wire.teams].sort((a, b) => b.trades - a.trades || b.offers - a.offers)[0];
if (dealer?.trades) {
  const tied = wire.teams.filter((r) => r.trades === dealer.trades && r.teamId !== dealer.teamId);
  awards.push({
    title: 'Used Car Salesman', value: String(dealer.trades), teamId: dealer.teamId,
    note: `Most trades completed${dealer.offers ? `, from ${dealer.offers} offers sent` : ''}${tied.length ? `; tied with ${tied.map((r) => owners[team[r.teamId].ownerId].name).join(', ')}` : ''}`,
  });
}

// Strength of schedule: the combined record of every opponent a team has played (once per game),
// from ESPN's standings, through the last finished week. Ties count as half a win. Ties between
// teams are broken by those opponents' points per game; a tie on both shares the award.
if (doneWeeks.length) {
  const thru = doneWeeks[doneWeeks.length - 1];
  const sos = teams.map((t) => {
    const games = doneWeeks.filter((w) => t.weeks[w]).map((w) => team[t.weeks[w].opp]);
    const W = games.reduce((s, o) => s + o.w, 0), L = games.reduce((s, o) => s + o.l, 0), T = games.reduce((s, o) => s + o.t, 0);
    const ppg = games.reduce((s, o) => s + o.pf / Math.max(1, o.w + o.l + o.t), 0) / Math.max(1, games.length);
    return { id: t.id, W, L, T, pct: W + L + T ? (W + T / 2) / (W + L + T) : 0, ppg: r2(ppg), games: games.length };
  });
  const rec = (s) => `${s.W}-${s.L}${s.T ? `-${s.T}` : ''}`;
  const pct = (p) => p.toFixed(3).replace(/^0/, '');
  const same = (a, b) => Math.abs(a.pct - b.pct) < 1e-9;
  for (const [title, dir] of [['Easiest schedule', 1], ['Hardest schedule', -1]]) {
    const sorted = [...sos].sort((a, b) => dir * (a.pct - b.pct) || dir * (a.ppg - b.ppg));
    const top = sorted[0];
    const tiedPct = sorted.slice(1).filter((s) => same(s, top));
    const shared = tiedPct.filter((s) => s.ppg === top.ppg);
    const tieNote = shared.length ? `; shared with ${shared.map((s) => team[s.id].name).join(', ')} (same record and points)`
      : tiedPct.length ? `; tied on win % with ${tiedPct.map((s) => team[s.id].name).join(', ')}, ahead on opponents' points per game (${top.ppg} vs ${tiedPct.map((s) => s.ppg).join(', ')})` : '';
    awards.push({ title, value: pct(top.pct), teamId: top.id, note: `Opponents ${rec(top)} through week ${thru}, ${top.ppg} points a game${tieNote}` });
  }
}

const mostIces = iceTable[0];
if (mostIces?.earned) {
  const tied = iceTable.filter((r) => r.earned === mostIces.earned);
  awards.push({
    title: 'Most ices', value: String(mostIces.earned), teamId: mostIces.teamId,
    note: tied.length > 1 ? `Tied with ${tied.slice(1).map((r) => owners[r.ownerId].name).join(', ')}; ranked by faster average time` : `${mostIces.lowest} for the lowest score, ${mostIces.duds} for 0-point starters`,
  });
}

// ---------- History ----------
const seasons = [];
const allGames = []; // regular season, every season including the current one
for (const year of [...pastSeasons, SEASON].sort()) {
  const s = seasonData(year);
  const reg = s.settings.scheduleSettings.matchupPeriodCount;
  const done = s.schedule.filter((m) => m.winner !== 'UNDECIDED' && m.away);
  const tName = Object.fromEntries(s.teams.map((t) => [t.id, teamName(t)]));
  const tOwner = Object.fromEntries(s.teams.map((t) => [t.id, t.primaryOwner]));
  for (const m of done.filter((m) => m.matchupPeriodId <= reg)) {
    allGames.push({
      year, week: m.matchupPeriodId,
      home: { owner: tOwner[m.home.teamId], team: tName[m.home.teamId], score: m.home.totalPoints },
      away: { owner: tOwner[m.away.teamId], team: tName[m.away.teamId], score: m.away.totalPoints },
      winner: m.winner,
    });
  }
  const complete = year !== SEASON;
  const lastPeriod = Math.max(...s.schedule.map((m) => m.matchupPeriodId));
  const champ = complete ? s.teams.find((t) => t.rankCalculatedFinal === 1) : null;
  const runner = complete ? s.teams.find((t) => t.rankCalculatedFinal === 2) : null;
  const final = complete
    ? s.schedule.find((m) => m.matchupPeriodId === lastPeriod && [m.home.teamId, m.away?.teamId].includes(champ.id) && [m.home.teamId, m.away?.teamId].includes(runner.id))
    : null;
  seasons.push({
    year,
    complete,
    teams: s.teams
      .map((t) => ({
        name: teamName(t),
        ownerId: t.primaryOwner,
        owner: owners[t.primaryOwner]?.name,
        w: t.record.overall.wins,
        l: t.record.overall.losses,
        pf: r2(t.record.overall.pointsFor),
        seed: t.playoffSeed,
        final: complete ? t.rankCalculatedFinal : null,
      }))
      .sort((a, b) => (complete ? a.final - b.final : a.seed - b.seed)),
    champion: champ && { name: teamName(champ), owner: owners[champ.primaryOwner]?.name },
    runnerUp: runner && { name: teamName(runner), owner: owners[runner.primaryOwner]?.name },
    finalScore: final && {
      champ: r2(final.home.teamId === champ.id ? final.home.totalPoints : final.away.totalPoints),
      runner: r2(final.home.teamId === champ.id ? final.away.totalPoints : final.home.totalPoints),
    },
  });
}

const allTime = {};
for (const s of seasons) {
  for (const t of s.teams) {
    const a = (allTime[t.ownerId] ??= { ownerId: t.ownerId, owner: t.owner, seasons: 0, w: 0, l: 0, pf: 0, games: 0, titles: 0, playoffs: 0, finishes: [], names: [] });
    a.seasons++;
    a.names.push({ year: s.year, name: t.name });
    if (s.complete) {
      a.finishes.push({ year: s.year, final: t.final });
      if (t.final === 1) a.titles++;
      if (t.seed <= playoffTeams) a.playoffs++;
    }
  }
}
for (const g of allGames) {
  for (const [side, flag] of [[g.home, 'HOME'], [g.away, 'AWAY']]) {
    const a = allTime[side.owner];
    a.games++;
    a.pf += side.score;
    if (g.winner === flag) a.w++; else if (g.winner !== 'TIE') a.l++;
  }
}
const allTimeList = Object.values(allTime)
  .map((a) => ({ ...a, pf: r1(a.pf), ppg: r1(a.pf / a.games), winPct: r2(a.w / (a.w + a.l)) }))
  .sort((a, b) => b.titles - a.titles || b.winPct - a.winPct);

// Head-to-head by owner, regular season.
const h2h = {};
for (const g of allGames) {
  const hw = g.winner === 'HOME', aw = g.winner === 'AWAY';
  const rec = (x, y) => ((h2h[x] ??= {})[y] ??= { w: 0, l: 0, pf: 0, pa: 0 });
  const hr = rec(g.home.owner, g.away.owner), ar = rec(g.away.owner, g.home.owner);
  if (hw) { hr.w++; ar.l++; } else if (aw) { hr.l++; ar.w++; }
  hr.pf += g.home.score; hr.pa += g.away.score;
  ar.pf += g.away.score; ar.pa += g.home.score;
}

const sides = allGames.flatMap((g) => [
  { ...g.home, opp: g.away, year: g.year, week: g.week, won: g.winner === 'HOME' },
  { ...g.away, opp: g.home, year: g.year, week: g.week, won: g.winner === 'AWAY' },
]);
const rec = (x, extra = '') => ({ value: fmt(x.score), owner: owners[x.owner]?.name, team: x.team, note: `${x.year} week ${x.week} vs ${x.opp.team}${extra}` });
const allHi = by(sides, (x) => x.score);
const allLo = by(sides, (x) => -x.score);
const allBlow = by(sides.filter((x) => x.won), (x) => x.score - x.opp.score);
const allClose = by(sides.filter((x) => x.won), (x) => -(x.score - x.opp.score));
const records = [
  { title: 'Highest score ever', ...rec(allHi) },
  { title: 'Lowest score ever', ...rec(allLo) },
  { title: 'Biggest blowout ever', ...rec(allBlow), value: `+${fmt(allBlow.score - allBlow.opp.score)}`, note: `${allBlow.year} week ${allBlow.week}: ${fmt(allBlow.score)} to ${fmt(allBlow.opp.score)} over ${allBlow.opp.team}` },
  { title: 'Closest game ever', ...rec(allClose), value: fmt(allClose.score - allClose.opp.score), note: `${allClose.year} week ${allClose.week}: ${fmt(allClose.score)} to ${fmt(allClose.opp.score)} over ${allClose.opp.team}` },
];

// Each manager's highest and lowest weekly score, per season and all-time (regular season).
const years = [...new Set(allGames.map((g) => g.year))].sort();

// ---------- Box scores, every season that has them ----------
// Past ESPN seasons from history/boxscores-<year>.json (scripts/import-past-boxscores.mjs), plus this
// season's. Per NFL week, each team as { owner, team, score, optimal, players, opp }.
const boxSeasons = (() => {
  const list = [];
  const side = (teamId, players, nameOf, ownerOf) => ({
    teamId, owner: ownerOf(teamId), team: nameOf(teamId), players,
    score: r2(players.filter((p) => isStarter(p.slot)).reduce((a, p) => a + p.pts, 0)),
    optimal: r2(bestLineup(players)),
  });
  const pair = (a, b) => { if (a && b) { a.opp = { team: b.team, score: b.score }; b.opp = { team: a.team, score: a.score }; } return [a, b].filter(Boolean); };
  for (const year of pastSeasons.filter((y) => existsSync(new URL(`history/boxscores-${y}.json`, import.meta.url))).sort()) {
    const h = read(`history/boxscores-${year}.json`), s = seasonData(year);
    const nameOf = (id) => teamName(s.teams.find((t) => t.id === id)), ownerOf = (id) => s.teams.find((t) => t.id === id)?.primaryOwner;
    const weeks = Object.entries(h.weeks).filter(([, games]) => games.length).map(([sp, games]) => ({
      sp: Number(sp), matchupPeriod: games[0].matchupPeriod, playoff: games[0].matchupPeriod > h.regWeeks, final: true,
      sides: games.flatMap((g) => pair(...g.sides.map((x) => side(x.teamId, x.players.map(([slot, name, pos, pro, pts]) => ({ slot, name, pos, pro, pts })), nameOf, ownerOf)))),
    }));
    list.push({ year, weeks });
  }
  // This season: finished regular-season weeks (its ices come from the Ice tab's own count).
  const cweeks = Object.entries(box).filter(([sp]) => doneWeeks.includes(Number(sp)) && Number(sp) <= regWeeks).map(([sp, games]) => ({
    sp: Number(sp), matchupPeriod: Number(sp), playoff: false, final: true,
    sides: games.flatMap((m) => pair(...[m.home, m.away].filter((x) => x?.rosterForCurrentScoringPeriod).map((x) => side(x.teamId,
      x.rosterForCurrentScoringPeriod.entries.map((e) => ({ slot: e.lineupSlotId, name: e.playerPoolEntry.player.fullName, pos: POS[e.playerPoolEntry.player.defaultPositionId] ?? '?', pro: PRO[e.playerPoolEntry.player.proTeamId] ?? '', pts: r2(pts(e)) })),
      (id) => team[id].name, (id) => team[id].ownerId)))),
  }));
  list.push({ year: SEASON, weeks: cweeks });
  return list;
})();

// ---------- All-time awards ----------
// The same awards as the season's, over every season (regular season). Scores, margins, luck and
// schedule go back to the first season (2023, from the league's sheet). Player weeks and lineups need
// box scores (ESPN seasons); ices earned come from box scores, or for 2023 from the sheet; roster moves come from ESPN's per-season counts; ice times
// from every season in the league's ice log.
const awardsAllTime = (() => {
  const out = [];
  const span = (ys) => (ys.length > 1 ? `${ys[0]}–${ys.at(-1)}` : String(ys[0]));
  const latestTeam = (ownerId) => allTime[ownerId]?.names.at(-1).name ?? '';
  const who = (ownerId, teamName) => ({ team: teamName ?? latestTeam(ownerId), owner: owners[ownerId]?.name ?? '' });
  const vs = (x) => `${x.year} week ${x.week}`;
  const add = (x, a) => x && out.push(a(x));
  const lost = sides.filter((x) => x.opp.score > x.score), won = sides.filter((x) => x.won);

  add(allHi, (x) => ({ title: 'Top score of the season', value: fmt(x.score), ...who(x.owner, x.team), note: `${vs(x)} vs ${x.opp.team}` }));
  add(allLo, (x) => ({ title: 'Lowest score', value: fmt(x.score), ...who(x.owner, x.team), note: `${vs(x)} vs ${x.opp.team}` }));
  add(allBlow, (x) => ({ title: 'Biggest blowout', value: `+${fmt(x.score - x.opp.score)}`, ...who(x.owner, x.team), note: `${vs(x)}: ${fmt(x.score)} to ${fmt(x.opp.score)} over ${x.opp.team}` }));
  add(allClose, (x) => ({ title: 'Closest game', value: fmt(x.score - x.opp.score), ...who(x.owner, x.team), note: `${vs(x)}: edged ${x.opp.team}, ${fmt(x.score)} to ${fmt(x.opp.score)}` }));
  add(by(lost, (x) => x.score), (x) => ({ title: 'Most points in a loss', value: fmt(x.score), ...who(x.owner, x.team), note: `${vs(x)}, lost to ${x.opp.team}` }));
  add(by(won, (x) => -x.score), (x) => ({ title: 'Ugliest win', value: fmt(x.score), ...who(x.owner, x.team), note: `${vs(x)}: won with just ${fmt(x.score)}, beating ${x.opp.team} (${fmt(x.opp.score)})` }));

  // Player weeks and lineups: every season with ESPN box scores (past ones from history/, made by
  // scripts/import-past-boxscores.mjs, plus this season's finished weeks). Regular season only.
  const boxYears = boxSeasons.map((b) => b.year);
  const regSides = boxSeasons.flatMap((b) => b.weeks.filter((w) => !w.playoff && w.final).flatMap((w) => w.sides.map((s) => ({ ...s, year: b.year, week: w.matchupPeriod }))));
  const starts = regSides.flatMap((s) => s.players.filter((p) => isStarter(p.slot)).map((p) => ({ ...p, side: s })));
  const playerWeekNote = (p) => {
    const s = p.side, res = s.opp ? `; the team ${s.score > s.opp.score ? 'won' : s.score < s.opp.score ? 'lost' : 'tied'} ${fmt(s.score)}–${fmt(s.opp.score)} vs ${s.opp.team}` : '';
    return `${p.name} (${p.pos}${p.pro ? ', ' + p.pro : ''}) scored ${fmt(p.pts)} in ${s.year} week ${s.week}${res}`;
  };
  add(by(starts, (p) => p.pts), (p) => ({ title: 'Best player week', value: fmt(p.pts), ...who(p.side.owner, p.side.team), note: playerWeekNote(p) }));
  add(by(starts.filter((p) => p.pos !== 'D/ST' && p.pos !== 'K'), (p) => -p.pts), (p) => ({ title: 'Worst starter week', value: fmt(p.pts), ...who(p.side.owner, p.side.team), note: playerWeekNote(p) }));
  const lineups = {};
  for (const s of regSides) {
    const l = (lineups[s.owner] ??= { owner: s.owner, pf: 0, best: 0, games: 0, optimalLosses: 0, years: new Set() });
    l.pf += s.score; l.best += s.optimal; l.games++; l.years.add(s.year);
    if (s.opp && s.score < s.opp.score && s.optimal > s.opp.score) l.optimalLosses++;
  }
  // Like the schedule, the lineup share needs a real sample: managers with at least half the most games.
  const maxLineupGames = Math.max(0, ...Object.values(lineups).map((l) => l.games));
  const coachAll = by(Object.values(lineups).filter((l) => l.games >= maxLineupGames / 2), (l) => l.pf / l.best);
  add(coachAll, (l) => ({ title: 'Coach of the year', value: `${r1((l.pf / l.best) * 100)}%`, ...who(l.owner), note: `Highest share of the best possible lineup actually started, ${span([...l.years].sort())}` }));
  add(by(Object.values(lineups), (l) => l.best - l.pf), (l) => ({ title: awardName('Bench Cuck'), value: fmt(l.best - l.pf), ...who(l.owner), note: `Points short of the optimal lineup, ${span([...l.years].sort())}; ${l.optimalLosses} losses would have been wins` }));

  // Luck: actual wins against expected wins (the share of the league each weekly score beat), summed over every season.
  const luck = {};
  for (const y of years) for (const w of [...new Set(sides.filter((x) => x.year === y).map((x) => x.week))]) {
    const wk = sides.filter((x) => x.year === y && x.week === w);
    for (const x of wk) {
      const others = wk.filter((o) => o.owner !== x.owner);
      const beat = others.reduce((s, o) => s + (x.score > o.score ? 1 : x.score === o.score ? 0.5 : 0), 0);
      const l = (luck[x.owner] ??= { owner: x.owner, w: 0, l: 0, t: 0, expected: 0, years: new Set() });
      l.expected += beat / Math.max(1, others.length);
      if (x.won) l.w++; else if (x.opp.score > x.score) l.l++; else l.t++;
      l.years.add(y);
    }
  }
  const luckList = Object.values(luck).map((l) => ({ ...l, luck: l.w + l.t / 2 - l.expected }));
  const luckNote = (l) => `${l.w}-${l.l}${l.t ? `-${l.t}` : ''} actual vs ${r1(l.expected)} expected wins, ${span([...l.years].sort())}`;
  add(by(luckList, (l) => l.luck), (l) => ({ title: 'Luckiest record', value: signed(l.luck), ...who(l.owner), note: luckNote(l) }));
  add(by(luckList, (l) => -l.luck), (l) => ({ title: 'Unluckiest record', value: signed(l.luck), ...who(l.owner), note: luckNote(l) }));

  // Schedule: every opponent's record for that season (once per game played), over every season.
  // Ties count as half a win; ties between managers are broken by those opponents' points per game.
  const seasonRec = {}; // `${year}:${ownerId}` -> { W, L, T, ppg }
  for (const y of years) for (const t of seasonData(y).teams) {
    const r = t.record.overall, g = Math.max(1, r.wins + r.losses + r.ties);
    seasonRec[`${y}:${t.primaryOwner}`] = { W: r.wins, L: r.losses, T: r.ties, ppg: r.pointsFor / g };
  }
  const sosMap = {};
  for (const x of sides) {
    const o = seasonRec[`${x.year}:${x.opp.owner}`];
    if (!o) continue;
    const s = (sosMap[x.owner] ??= { owner: x.owner, W: 0, L: 0, T: 0, ppgSum: 0, games: 0 });
    s.W += o.W; s.L += o.L; s.T += o.T; s.ppgSum += o.ppg; s.games++;
  }
  // Win % over a handful of games isn't a fair match for several seasons: count managers with at least
  // half as many games as the longest-serving one.
  const maxGames = Math.max(0, ...Object.values(sosMap).map((s) => s.games));
  const sosAll = Object.values(sosMap).filter((s) => s.games >= maxGames / 2).map((s) => ({ ...s, pct: s.W + s.L + s.T ? (s.W + s.T / 2) / (s.W + s.L + s.T) : 0, ppg: r2(s.ppgSum / Math.max(1, s.games)) }));
  const pct3 = (p) => p.toFixed(3).replace(/^0/, '');
  for (const [title, dir] of [['Easiest schedule', 1], ['Hardest schedule', -1]]) {
    const sorted = [...sosAll].sort((a, b) => dir * (a.pct - b.pct) || dir * (a.ppg - b.ppg));
    const top = sorted[0];
    if (!top) continue;
    const shared = sorted.slice(1).filter((s) => Math.abs(s.pct - top.pct) < 1e-9 && s.ppg === top.ppg);
    out.push({ title, value: pct3(top.pct), ...who(top.owner),
      note: `Opponents ${top.W}-${top.L}${top.T ? `-${top.T}` : ''} over ${top.games} games, ${span(years)}, ${top.ppg} points a game${shared.length ? `; shared with ${shared.map((s) => owners[s.owner]?.name).join(', ')}` : ''}` });
  }

  // Ice times: every season in the league's ice log.
  const timedAll = iceLogAll.filter((x) => x.secs != null);
  const iceTeam = (x) => allTime[x.ownerId]?.names.find((n) => n.year === x.season)?.name;
  const iceNoteAll = (x) => `${x.why}, ${x.season}${x.week ? ` week ${x.week}` : ''}${x.date ? ` · ${x.date}` : ''}`;
  add(by(timedAll, (x) => -x.secs), (x) => ({ title: 'Fastest ice', value: `${x.secs.toFixed(2)} s`, ...who(x.ownerId, iceTeam(x)), note: iceNoteAll(x) }));
  add(by(timedAll, (x) => x.secs), (x) => ({ title: 'Slowest ice', value: `${x.secs.toFixed(2)} s`, ...who(x.ownerId, iceTeam(x)), note: iceNoteAll(x) }));
  // Ices earned: worked out from box scores by the same rules as the Ice tab (the week's lowest score
  // and every 0-point starter, doubled in the playoffs). Past seasons from history/, this season from the
  // Ice tab, and seasons without box scores (2023) from the ices their sheet recorded.
  const earned = {};
  const tally = (owner, kind, n) => { const e = (earned[owner] ??= { owner, lowest: 0, duds: 0 }); e[kind] += n; };
  const sheetIceYears = pastSeasons.filter((y) => !boxYears.includes(y) && seasonData(y).ices).sort();
  for (const y of sheetIceYears) {
    const s = seasonData(y), reg = s.settings.scheduleSettings.matchupPeriodCount;
    const ownerOf = Object.fromEntries(s.teams.map((t) => [t.id, t.primaryOwner]));
    for (const x of s.ices) {
      const mult = x.week > reg ? multiplier : 1;
      tally(ownerOf[x.teamId], 'lowest', x.lowest * mult);
      tally(ownerOf[x.teamId], 'duds', x.duds * mult);
    }
  }
  for (const b of boxSeasons.filter((b) => b.year !== SEASON)) {
    for (const w of b.weeks) {
      const mult = w.playoff ? multiplier : 1;
      const all = w.sides;
      const low = Math.min(...all.map((s) => s.score));
      for (const s of all) {
        if (s.score === low) tally(s.owner, 'lowest', mult);
        tally(s.owner, 'duds', s.players.filter((p) => isStarter(p.slot) && p.pts <= 0).length * mult);
      }
    }
  }
  for (const r of iceTable) { tally(r.ownerId, 'lowest', r.lowest); tally(r.ownerId, 'duds', r.duds); }
  const iceRank = Object.values(earned).map((e) => ({ ...e, total: e.lowest + e.duds })).sort((a, b) => b.total - a.total);
  if (iceRank[0]?.total) {
    const top = iceRank[0], tied = iceRank.slice(1).filter((e) => e.total === top.total);
    out.push({ title: 'Most ices', value: String(top.total), ...who(top.owner),
      note: `${top.lowest} for the lowest score, ${top.duds} for 0-point starters, ${span([...sheetIceYears, ...boxYears].sort())}${tied.length ? `; tied with ${tied.map((e) => owners[e.owner]?.name).join(', ')}` : ''}` });
  }

  // Roster moves: ESPN's per-season counts for past ESPN seasons, plus this season's moves and trades.
  const moveYears = [...new Set([...pastSeasons.filter((y) => existsSync(new URL(`data/season-${y}.json`, import.meta.url))), SEASON])].sort();
  const adds = {}, deals = {};
  for (const y of moveYears.filter((y) => y !== SEASON)) for (const t of seasonData(y).teams) {
    adds[t.primaryOwner] = (adds[t.primaryOwner] ?? 0) + (t.transactionCounter?.acquisitions ?? 0);
    deals[t.primaryOwner] = (deals[t.primaryOwner] ?? 0) + (t.transactionCounter?.trades ?? 0);
  }
  for (const t of teams) adds[t.ownerId] = (adds[t.ownerId] ?? 0) + t.moves;
  for (const r of wire.teams) deals[team[r.teamId].ownerId] = (deals[team[r.teamId].ownerId] ?? 0) + r.trades;
  const most = (m) => Object.entries(m).sort((a, b) => b[1] - a[1]);
  const [addOwner, addN] = most(adds)[0] ?? [];
  if (addN) out.push({ title: 'Waiver wire addict', value: String(addN), ...who(addOwner), note: `Waiver claims and free-agent pickups, ${span(moveYears)}` });
  const dealers = most(deals), [dealOwner, dealN] = dealers[0] ?? [];
  if (dealN) {
    const tied = dealers.slice(1).filter(([, n]) => n === dealN).map(([o]) => owners[o]?.name);
    out.push({ title: 'Used Car Salesman', value: String(dealN), ...who(dealOwner), note: `Most trades completed, ${span(moveYears)}${tied.length ? `; tied with ${tied.join(', ')}` : ''}` });
  }
  return out;
})();
const mark = (x) => x && { score: r2(x.score), week: x.week, year: x.year, team: x.team, opp: x.opp.team };
const ownerHighLow = Object.keys(allTime).map((ownerId) => {
  const mine = sides.filter((x) => x.owner === ownerId);
  const seasonsHL = Object.fromEntries(years.map((y) => {
    const s = mine.filter((x) => x.year === y);
    return [y, s.length ? { high: mark(by(s, (x) => x.score)), low: mark(by(s, (x) => -x.score)), avg: r1(s.reduce((a, x) => a + x.score, 0) / s.length) } : null];
  }));
  return { ownerId, seasons: seasonsHL, high: mark(by(mine, (x) => x.score)), low: mark(by(mine, (x) => -x.score)) };
}).sort((a, b) => b.high.score - a.high.score);

// Weekly results by owner for every season, for the schedule-swap "what if".
const schedules = Object.fromEntries(years.map((y) => {
  const gs = allGames.filter((g) => g.year === y);
  const weeksList = [...new Set(gs.map((g) => g.week))].sort((a, b) => a - b);
  const ownersIn = [...new Set(gs.flatMap((g) => [g.home.owner, g.away.owner]))];
  const teamNames = Object.fromEntries(gs.flatMap((g) => [[g.home.owner, g.home.team], [g.away.owner, g.away.team]]));
  // weeks[i][owner] = [opponent owner, own score]
  const weeksOut = weeksList.map((w) => {
    const row = {};
    for (const g of gs.filter((g) => g.week === w)) {
      row[g.home.owner] = [g.away.owner, r2(g.home.score)];
      row[g.away.owner] = [g.home.owner, r2(g.away.score)];
    }
    return row;
  });
  return [y, { weeks: weeksList, owners: ownersIn, teamNames, results: weeksOut }];
}));

// ---------- Punishments (the league's own site only) ----------
// Two each season, from the sheet's Punishments tab: one for the worst regular-season record (the last
// seed), one for last place in the losers' bracket (the toilet bowl). Past seasons come from the final
// standings; this season's chances from simulating the rest of it, like the lowest-score watch.
const punishments = PUBLIC ? null : (() => {
  const byYear = {};
  const file = new URL('data/punishments.csv', import.meta.url);
  if (existsSync(file)) {
    const [header, ...rows] = parseCsv(readFileSync(file, 'utf8'));
    const iYear = header.findIndex((h) => /season|year/i.test(h));
    const iReg = header.findIndex((h) => /regular/i.test(h)), iPo = header.findIndex((h) => /playoff/i.test(h));
    // Each punishment's stipulations are in the column right after it; "None" means there wasn't one.
    const item = (r, i) => {
      const title = i < 0 ? '' : (r[i] || '').trim();
      return title && !/^none$/i.test(title) ? { title, rules: (r[i + 1] || '').trim().replace(/^none$/i, '') } : null;
    };
    for (const r of rows) {
      const y = Number(r[iYear]);
      if (y > 2000) byYear[y] = { regular: item(r, iReg), playoffs: item(r, iPo) };
    }
  }
  const none = { regular: null, playoffs: null };

  const past = seasons.filter((s) => s.complete).map((s) => {
    const last = s.teams.reduce((a, t) => (t.seed > a.seed ? t : a));
    const bowl = s.teams.find((t) => t.final === s.teams.length);
    return {
      year: s.year,
      regular: { ownerId: last.ownerId, team: last.name, record: `${last.w}-${last.l}`, ...(byYear[s.year] ?? none).regular },
      playoffs: bowl ? { ownerId: bowl.ownerId, team: bowl.name, ...(byYear[s.year] ?? none).playoffs } : null,
      hasPlayoffs: !!(byYear[s.year] ?? none).playoffs,
    };
  }).reverse();

  // ----- This season -----
  const sch = cur.settings.scheduleSettings;
  const spsOf = (mp) => sch.matchupPeriods?.[mp] ?? [Number(mp)];
  const regGames = cur.schedule.filter((m) => m.matchupPeriodId <= regWeeks && m.away);
  const decided = (m) => m.winner !== 'UNDECIDED';
  const winnerOf = (m) => (m.winner === 'HOME' ? m.home.teamId : m.winner === 'AWAY' ? m.away.teamId : null);
  const regDone = regGames.length > 0 && regGames.every(decided);

  // Weeks still to play: each team's scoring this season (pulled a little toward the league average),
  // with the league's week-to-week spread. The week in progress uses the live projections.
  const scores = Object.fromEntries(teams.map((t) => [t.id, doneWeeks.map((w) => t.weeks[w]?.score).filter((x) => x != null)]));
  const all = Object.values(scores).flat();
  if (!all.length) return { past, current: null, rules: byYear[SEASON] ?? none };
  const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const leagueAvg = avg(all);
  const mean = Object.fromEntries(teams.map((t) => [t.id, (scores[t.id].reduce((s, x) => s + x, 0) + 3 * leagueAvg) / (scores[t.id].length + 3)]));
  const sd = Math.max(15, Math.sqrt(avg(teams.flatMap((t) => scores[t.id].map((x) => (x - avg(scores[t.id])) ** 2)))));
  let seed = 11;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const gauss = () => Math.sqrt(-2 * Math.log(rand() || 1e-9)) * Math.cos(2 * Math.PI * rand());
  const finalSp = new Set(iceWeeks.filter((w) => w.final).map((w) => w.week));
  const actual = (teamId, sp) => {
    for (const m of cur.schedule) for (const s of [m.home, m.away]) if (s?.teamId === teamId && s.pointsByScoringPeriod?.[sp] != null) return s.pointsByScoringPeriod[sp];
    return null;
  };
  // One NFL week's score for a team: fixed once final, live projection while in progress, otherwise drawn.
  const weekDraw = (teamId, sp) => {
    if (finalSp.has(sp) && actual(teamId, sp) != null) { const a = actual(teamId, sp); return () => a; }
    const side = (box[sp] || []).flatMap((m) => [m.home, m.away]).find((s) => s?.teamId === teamId && s.rosterForCurrentScoringPeriod);
    if (side) { const l = liveSide(side, sp), spread = spreadFor(l.remaining); return () => l.proj + gauss() * spread; }
    return () => mean[teamId] + gauss() * sd;
  };
  const draws = {};
  const matchupScore = (teamId, mp) => (draws[`${teamId}:${mp}`] ??= spsOf(mp).map((sp) => weekDraw(teamId, Number(sp)))).reduce((s, f) => s + f(), 0);
  // The winner of a game: from ESPN once decided, otherwise simulated (a tie goes to the higher seed).
  const play = (a, b, mp, seedOf) => {
    const g = cur.schedule.find((m) => m.matchupPeriodId === mp && m.away && [m.home.teamId, m.away.teamId].includes(a) && [m.home.teamId, m.away.teamId].includes(b));
    if (g && decided(g)) return winnerOf(g) ?? (seedOf[a] < seedOf[b] ? a : b);
    const sa = matchupScore(a, mp), sb = matchupScore(b, mp);
    return sa > sb || (sa === sb && seedOf[a] < seedOf[b]) ? a : b;
  };

  // Regular-season standings so far, game by game (for head-to-head tiebreaks)
  const baseW = Object.fromEntries(teams.map((t) => [t.id, 0])), basePf = Object.fromEntries(teams.map((t) => [t.id, 0]));
  const baseGames = []; // [winner, loser]
  for (const m of regGames.filter(decided)) {
    basePf[m.home.teamId] += m.home.totalPoints; basePf[m.away.teamId] += m.away.totalPoints;
    const w = winnerOf(m);
    if (w) { baseW[w]++; baseGames.push([w, w === m.home.teamId ? m.away.teamId : m.home.teamId]); }
  }
  const open = regGames.filter((m) => !decided(m));
  const byH2H = sch.playoffSeedingRule === 'H2H_RECORD';
  const rankTeams = (W, PF, games) => {
    const ids = teams.map((t) => t.id);
    const h2h = (id, group) => {
      const g = games.filter(([a, b]) => group.includes(a) && group.includes(b) && (a === id || b === id));
      return g.length ? g.filter(([a]) => a === id).length / g.length : 0.5;
    };
    const groups = {};
    for (const id of ids) (groups[W[id]] ??= []).push(id);
    return Object.keys(groups).map(Number).sort((a, b) => b - a).flatMap((w) => {
      const g = groups[w];
      return g.sort((a, b) => (byH2H ? h2h(b, g) - h2h(a, g) : 0) || PF[b] - PF[a]);
    });
  };

  const RUNS = 10000;
  const lastCount = Object.fromEntries(teams.map((t) => [t.id, 0])), bowlCount = { ...lastCount };
  for (let i = 0; i < RUNS; i++) {
    let order;
    if (regDone) order = [...teams].sort((a, b) => a.seed - b.seed).map((t) => t.id);
    else {
      const W = { ...baseW }, PF = { ...basePf }, games = [...baseGames];
      for (const m of open) {
        const h = m.home.teamId, a = m.away.teamId;
        const sh = matchupScore(h, m.matchupPeriodId), sa = matchupScore(a, m.matchupPeriodId);
        PF[h] += sh; PF[a] += sa;
        const [w, l] = sh >= sa ? [h, a] : [a, h];
        W[w]++; games.push([w, l]);
      }
      order = rankTeams(W, PF, games);
    }
    lastCount[order.at(-1)]++;
    // The toilet bowl: the teams outside the playoffs. Round one pairs them 5 v 6 and 7 v 8 (as in past
    // seasons, or ESPN's own pairings once they're set); the two losers play for last place.
    const outside = order.slice(playoffTeams);
    if (outside.length !== 4) continue;
    const seedOf = Object.fromEntries(order.map((id, k) => [id, k + 1]));
    const r1 = regWeeks + 1, r2 = regWeeks + 2;
    const espnR1 = cur.schedule.filter((m) => m.matchupPeriodId === r1 && m.away && outside.includes(m.home.teamId) && outside.includes(m.away.teamId));
    const pairs = espnR1.length === 2 ? espnR1.map((m) => [m.home.teamId, m.away.teamId]) : [[outside[0], outside[1]], [outside[2], outside[3]]];
    const losers = pairs.map(([a, b]) => (play(a, b, r1, seedOf) === a ? b : a));
    const w = play(losers[0], losers[1], r2, seedOf);
    bowlCount[w === losers[0] ? losers[1] : losers[0]]++;
  }
  const chances = (count) => teams.map((t) => ({ teamId: t.id, ownerId: t.ownerId, chance: Math.round((count[t.id] / RUNS) * 1000) / 10, w: t.w, l: t.l }))
    .filter((x) => x.chance > 0).sort((a, b) => b.chance - a.chance);
  const reg = chances(lastCount), bowl = chances(bowlCount);
  return {
    past,
    rules: byYear[SEASON] ?? none,
    current: {
      year: SEASON, runs: RUNS, asOf: NOW, regDone, tiebreak: byH2H ? 'head-to-head record, then points scored' : 'points scored',
      regular: reg, playoffs: bowl,
      regularLocked: reg.length === 1 && reg[0].chance === 100,
      playoffsLocked: bowl.length === 1 && bowl[0].chance === 100,
    },
  };
})();

// ---------- League rules (from ESPN's league settings) ----------
// ESPN scoring stat IDs -> [group, label]. Stat 88 (missed PAT) checked against real box scores.
const STAT_NAMES = {
  3: ['Passing', 'Passing yards'], 4: ['Passing', 'TD pass'], 19: ['Passing', '2-pt conversion pass'], 20: ['Passing', 'Interception thrown'],
  24: ['Rushing', 'Rushing yards'], 25: ['Rushing', 'TD rush'], 26: ['Rushing', '2-pt conversion rush'],
  42: ['Receiving', 'Receiving yards'], 43: ['Receiving', 'TD reception'], 44: ['Receiving', '2-pt conversion reception'], 53: ['Receiving', 'Each reception'],
  63: ['Miscellaneous', 'Fumble recovered for TD'], 72: ['Miscellaneous', 'Fumble lost'],
  101: ['Miscellaneous', 'Kickoff return TD'], 102: ['Miscellaneous', 'Punt return TD'], 103: ['Miscellaneous', 'Interception return TD'], 104: ['Miscellaneous', 'Fumble return TD'],
  80: ['Kicking', 'FG made 0-39 yds'], 77: ['Kicking', 'FG made 40-49 yds'], 74: ['Kicking', 'FG made 50+ yds'], 198: ['Kicking', 'FG made 50-59 yds'], 201: ['Kicking', 'FG made 60+ yds'],
  85: ['Kicking', 'FG missed'], 86: ['Kicking', 'PAT made'], 88: ['Kicking', 'PAT missed'],
  89: ['Defense & special teams', '0 points allowed'], 90: ['Defense & special teams', '1-6 points allowed'], 91: ['Defense & special teams', '7-13 points allowed'],
  92: ['Defense & special teams', '14-17 points allowed'], 121: ['Defense & special teams', '18-21 points allowed'], 122: ['Defense & special teams', '22-27 points allowed'],
  123: ['Defense & special teams', '28-34 points allowed'], 124: ['Defense & special teams', '35-45 points allowed'], 125: ['Defense & special teams', '46+ points allowed'],
  128: ['Defense & special teams', 'Under 100 yards allowed'], 129: ['Defense & special teams', '100-199 yards allowed'], 130: ['Defense & special teams', '200-299 yards allowed'],
  131: ['Defense & special teams', '300-349 yards allowed'], 132: ['Defense & special teams', '350-399 yards allowed'], 133: ['Defense & special teams', '400-449 yards allowed'],
  134: ['Defense & special teams', '450-499 yards allowed'], 135: ['Defense & special teams', '500-549 yards allowed'], 136: ['Defense & special teams', '550+ yards allowed'],
  93: ['Defense & special teams', 'Blocked kick returned for TD'], 95: ['Defense & special teams', 'Interception'], 96: ['Defense & special teams', 'Fumble recovered'],
  97: ['Defense & special teams', 'Blocked kick'], 98: ['Defense & special teams', 'Safety'], 99: ['Defense & special teams', 'Sack'],
  206: ['Defense & special teams', '2-pt return'], 209: ['Defense & special teams', '1-pt safety'],
};
// Reading order within each scoring group (short FGs to long, fewest points/yards allowed to most).
const STAT_ORDER = [3, 4, 19, 20, 24, 25, 26, 53, 42, 43, 44, 80, 77, 74, 198, 201, 85, 86, 88,
  99, 95, 96, 97, 98, 93, 206, 209, 89, 90, 91, 92, 121, 122, 123, 124, 125, 128, 129, 130, 131, 132, 133, 134, 135, 136,
  101, 102, 103, 104, 63, 72];
const rules = (() => {
  const st = cur.settings;
  const fmtPts = (p) => {
    if (p > 0 && p < 1) return `1 pt per ${Math.round(1 / p)} yds`;
    return `${p > 0 ? '+' : ''}${Number.isInteger(p) ? p : p.toFixed(2)} ${Math.abs(p) === 1 ? 'pt' : 'pts'}`;
  };
  const etDay = (ms) => ms ? new Date(ms).toLocaleString('en-US', { timeZone: ET, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' ET' : '—';
  const yesNo = (b) => (b ? 'Yes' : 'No');
  const titleCase = (s) => String(s ?? '').toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

  // Scoring: one row per item; D/ST overrides apply to defense rows.
  const groups = {};
  const unknown = [];
  for (const it of st.scoringSettings.scoringItems) {
    const def = STAT_NAMES[it.statId];
    if (!def) unknown.push(it.statId);
    const [group, label] = def || ['Other', `Stat #${it.statId}`];
    const pts = group.startsWith('Defense') && it.pointsOverrides?.[16] !== undefined ? it.pointsOverrides[16] : it.points;
    if (!pts) continue;
    (groups[group] ??= []).push({ label, value: fmtPts(pts), id: it.statId });
  }
  if (unknown.length) console.warn(`Scoring stat IDs without a name: ${unknown.join(', ')}`);
  const ORDER = ['Passing', 'Rushing', 'Receiving', 'Kicking', 'Defense & special teams', 'Miscellaneous', 'Other'];
  const scoring = ORDER.filter((g) => groups[g]).map((g) => ({ group: g, items: groups[g].sort((a, b) => (STAT_ORDER.indexOf(a.id) + 1 || 999) - (STAT_ORDER.indexOf(b.id) + 1 || 999)).map(({ label, value }) => ({ label, value })) }));

  const counts = st.rosterSettings.lineupSlotCounts;
  const lineup = [[0, 'QB'], [2, 'RB'], [4, 'WR'], [6, 'TE'], [23, 'FLEX (RB/WR/TE)'], [16, 'D/ST'], [17, 'K'], [20, 'Bench'], [21, 'IR']]
    .filter(([id]) => counts[id] > 0).map(([id, label]) => ({ label, value: String(counts[id]) }));
  // Most of each position a team may carry (ESPN position IDs; -1/0 = no limit).
  const limits = Object.entries(st.rosterSettings.positionLimits)
    .filter(([id, v]) => v > 0 && POS[id])
    .map(([id, v]) => ({ label: `Max ${POS[id]} on roster`, value: String(v) }));
  const acq = st.acquisitionSettings, tr = st.tradeSettings, sch = st.scheduleSettings, dr = st.draftSettings;
  const DAYS = { MONDAY: 'Mon', TUESDAY: 'Tue', WEDNESDAY: 'Wed', THURSDAY: 'Thu', FRIDAY: 'Fri', SATURDAY: 'Sat', SUNDAY: 'Sun' };
  const hour = (h) => `${((h + 11) % 12) + 1}:00 ${h < 12 ? 'AM' : 'PM'}`;
  const fees = Object.values(st.financeSettings || {}).some((v) => v > 0);

  return {
    sections: [
      { title: 'Basics', icon: '🏈', rows: [
        { label: 'League name', value: leagueName }, { label: 'Teams', value: String(st.size) },
        { label: 'Scoring type', value: st.scoringSettings.scoringType === 'H2H_POINTS' ? 'Head-to-head points' : titleCase(st.scoringSettings.scoringType) },
        { label: 'Receptions', value: (() => { const r = st.scoringSettings.scoringItems.find((i) => i.statId === 53)?.points ?? 0; return r === 1 ? 'Full PPR (1 pt each)' : r ? `${r} pts each` : 'Standard (none)'; })() },
        { label: 'Ties', value: st.scoringSettings.matchupTieRule === 'NONE' ? 'Ties stand' : titleCase(st.scoringSettings.matchupTieRule) },
        // The buy-in is collected outside ESPN, so it comes from league.config.json (leagueFee).
        { label: 'League fee', value: config.leagueFee ? `$${config.leagueFee} per team` : fees ? 'Yes' : 'None' },
      ] },
      { title: 'Roster & lineup', icon: '👥', rows: [
        ...lineup,
        { label: 'Lineup locks', value: st.rosterSettings.rosterLocktimeType === 'INDIVIDUAL_GAME' ? 'At each player\'s game time' : titleCase(st.rosterSettings.rosterLocktimeType) },
        ...limits,
      ] },
      { title: 'Schedule & playoffs', icon: '🗓️', rows: [
        { label: 'Regular season', value: `${sch.matchupPeriodCount} weeks` },
        { label: 'Playoff teams', value: String(sch.playoffTeamCount) },
        { label: 'Playoff rounds', value: `${sch.playoffMatchupPeriodLength} weeks each` },
        { label: 'Playoffs start', value: `Week ${sch.matchupPeriodCount + 1}` },
        { label: 'Seeding', value: sch.playoffSeedingRule === 'H2H_RECORD' ? 'Head-to-head record' : titleCase(sch.playoffSeedingRule) },
        { label: 'Playoff ties', value: st.scoringSettings.playoffMatchupTieRule === 'NONE' ? 'Higher seed advances' : titleCase(st.scoringSettings.playoffMatchupTieRule) },
      ] },
      { title: 'Draft', icon: '📝', rows: [
        { label: 'Type', value: titleCase(dr.type) }, { label: 'Date', value: etDay(dr.date) },
        { label: 'Time per pick', value: `${dr.timePerSelection} seconds` },
        { label: 'Draft order', value: titleCase(dr.orderType) }, { label: 'Keepers', value: dr.keeperCount ? String(dr.keeperCount) : 'None' },
      ] },
      { title: 'Waivers & free agents', icon: '⏳', rows: [
        { label: 'System', value: acq.isUsingAcquisitionBudget ? `FAAB ($${acq.acquisitionBudget})` : 'Traditional waivers' },
        { label: 'Waiver period', value: `${acq.waiverHours} hours` },
        { label: 'Waivers process', value: `${(acq.waiverProcessDays || []).map((d) => DAYS[d] ?? d).join(', ')} at ${hour(acq.waiverProcessHour)} ET` },
        { label: 'Waiver order', value: acq.waiverOrderReset ? 'Resets each week' : 'Rolling' },
        { label: 'Acquisition limit', value: acq.acquisitionLimit < 0 ? 'No limit' : String(acq.acquisitionLimit) },
      ] },
      { title: 'Trades', icon: '🤝', rows: [
        { label: 'Trade deadline', value: etDay(tr.deadlineDate) },
        { label: 'Review period', value: `${tr.revisionHours} hours` },
        { label: 'Veto votes needed', value: tr.vetoVotesRequired ? String(tr.vetoVotesRequired) : 'None' },
        { label: 'Trade limit', value: tr.max < 0 ? 'No limit' : String(tr.max) },
      ] },
    ],
    scoring,
    // The missed-deadline doubling is a stated rule the site doesn't track, so the public copy leaves it out.
    ice: PUBLIC ? { multiplier } : { multiplier, missedMultiplier: 2 },
  };
})();

// Ice email pictures (notify-images/<kind>/) are published with each site as ice-images/<kind>/, so
// real emails link to them at a full https address (notify.mjs) and the on-site samples can show them.
const ICE_IMAGE_KINDS = ['lowest', 'dud', 'highest'];
const iceImageFiles = (kind) => { const dir = new URL(`notify-images/${kind}/`, import.meta.url); return existsSync(dir) ? readdirSync(dir).filter((f) => /\.(jpe?g|png|gif|webp)$/i.test(f)).sort() : []; };

// ---------- Output ----------
const model = {
  public: PUBLIC,
  iceImages: Object.fromEntries(ICE_IMAGE_KINDS.map((k) => [k, iceImageFiles(k).map((f) => `ice-images/${k}/${encodeURIComponent(f)}`)])),
  league: { name: leagueName, season: SEASON, currentWeek, lastWeek, regWeeks, playoffTeams, size: teams.length, trades, updated: cur.status.standingsUpdateDate, built: Date.now(), leagueId: PUBLIC ? null : env.LEAGUE_ID, // The public copy can have its own refresh address (one without the league's name in it)
    refreshUrl: (PUBLIC ? config.public.refreshUrl ?? config.refreshUrl : config.refreshUrl) || '', weekStart: weekSpans[currentWeek]?.first ?? null, weekEnd: weekSpans[currentWeek]?.last ?? null },
  teams: teams.sort((a, b) => a.seed - b.seed),
  matchups,
  upcoming,
  rosters,
  draft,
  moves: moves.slice(0, 40).map((m) => ({ ...m, adds: m.adds.map(({ name, pos }) => ({ name, pos })), drops: m.drops.map(({ name, pos }) => ({ name, pos })) })),
  wire,
  awards,
  awardsAllTime,
  seasons,
  allTime: allTimeList,
  h2h,
  owners,
  records,
  ownerHighLow,
  schedules,
  rules,
  highsLows,
  ice: { weeks: iceWeeks, log: iceLog, table: iceTable, multiplier, currentSp: latestSp },
  punishments,
};

// Light minify: drop indentation, CSS comments and whole-line JS comments. Done before the data goes in.
function minify(html) {
  return html
    .replace(/<style>([\s\S]*?)<\/style>/, (_, css) => `<style>${css.replace(/\/\*[\s\S]*?\*\//g, '')}</style>`)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('// '))
    .join('\n');
}
// The league's name goes where the pages say __LEAGUE__ / __SHORT__ / __BIG__. The private site asks
// search engines to stay away (it's unlisted). The public copy drops the ESPN link and counts its visits
// in the portfolio's counter (config public.goatcounter), as /fantasy-football/ and /fantasy-football/app.html#<tab>.
const names = PUBLIC ? config.public : { name: leagueName, short: 'Feetpics', big: 'FEETPICS' };
function brand(html) {
  html = html.replaceAll('__LEAGUE__', names.name).replaceAll('__SHORT__', names.short).replaceAll('__BIG__', names.big);
  if (!PUBLIC) {
    return html.replaceAll('__GC_COVER__', '/cover').replaceAll('__GC_TAB__', '/')
      .replace('<meta charset="utf-8">', '<meta charset="utf-8">\n<meta name="robots" content="noindex">');
  }
  for (const [from, to] of Object.entries(config.public.awards ?? {})) html = html.replaceAll(`'${from}'`, `'${to}'`);
  return html.replaceAll('__GC_COVER__', '/fantasy-football/').replaceAll('__GC_TAB__', '/fantasy-football/app.html#')
    .replaceAll('https://fantasy.goatcounter.com/count', `https://${config.public.goatcounter}.goatcounter.com/count`)
    // Off the Wall's own counter script: sends no query strings and only the referrer's domain
    .replaceAll('//gc.zgo.at/count.js', '/shared/count.js')
    .replace(/ <a href="https:\/\/fantasy\.espn\.com[^"]*"[^>]*>[^<]*<\/a>/g, '');
}
const out = (f) => new URL(OUT + f, import.meta.url);
const template = brand(minify(readFileSync(new URL('site-src/template.html', import.meta.url), 'utf8')));
if (!template.includes('/*__DATA__*/null')) throw new Error('Data placeholder missing from the template.');
// ESPN account IDs (one of them doubles as the SWID login cookie) never go on the page: swap each for a short label.
let json = JSON.stringify(model).replace(/</g, '\\u003c');
Object.keys(owners).forEach((id, i) => { json = json.split(id).join(`o${i + 1}`); });
if (/\{[0-9A-F]{8}-[0-9A-F]{4}-/i.test(json)) throw new Error('An ESPN account ID is still in the page data.');
mkdirSync(out(''), { recursive: true });
// The full site is app.html; index.html is the landing page in front of it.
const appHtml = template.replace('/*__DATA__*/null', json);
writeFileSync(out('app.html'), appHtml);
let landingHtml;
{
  const { latest, pending } = (() => {
    const finals = iceWeeks.filter((w) => w.final);
    return { latest: finals.at(-1), pending: iceWeeks.find((w) => !w.final) };
  })();
  const short = (ms) => new Date(ms).toLocaleString('en-US', { timeZone: ET, weekday: 'short', hour: 'numeric', minute: '2-digit' }) + ' ET';
  const leader = model.teams[0];
  const due = latest && latest.deadline > NOW ? latest : pending;
  const landing = {
    season: SEASON, size: teams.length, week: currentWeek, regWeeks,
    live: matchups[currentWeek]?.some((g) => g.live) ?? false,
    leader: leader ? `${leader.name} ${leader.w}-${leader.l}` : null,
    ice: due?.deadline ? `Week ${due.week} ices due ${short(due.deadline)}` : null,
  };
  landingHtml = brand(minify(readFileSync(new URL('site-src/landing.html', import.meta.url), 'utf8')))
    .replace('/*__LANDING__*/null', JSON.stringify(landing).replace(/</g, '\\u003c'));
  writeFileSync(out('index.html'), landingHtml);
}
cpSync(new URL('site-src/fonts/', import.meta.url), out('fonts/'), { recursive: true });
cpSync(new URL('site-src/static/', import.meta.url), out(''), { recursive: true });
for (const k of ICE_IMAGE_KINDS) for (const f of iceImageFiles(k)) {
  mkdirSync(out(`ice-images/${k}/`), { recursive: true });
  cpSync(new URL(`notify-images/${k}/${f}`, import.meta.url), out(`ice-images/${k}/${f}`));
}
const manifest = brand(readFileSync(new URL('site-src/static/manifest.webmanifest', import.meta.url), 'utf8'));
writeFileSync(out('manifest.webmanifest'), manifest);
// Tiny file the page polls (cache-busted) to know when newer data has been published.
writeFileSync(out('version.json'), JSON.stringify({ built: model.league.built }));
writeFileSync(out('.nojekyll'), '');

// The public copy must not name anyone: stop if a full name, ESPN profile name or a real team name
// (any season) made it onto a page, or the league's real name did.
if (PUBLIC) {
  const banned = [...privateNames, ...realTeamNames, ...Object.keys(config.public.awards ?? {}), cur.settings.name.trim(), 'feetpics'].filter((n) => n.length > 2);
  const pages = [appHtml, landingHtml, manifest].join('\n').toLowerCase();
  const found = banned.filter((n) => pages.includes(n.toLowerCase()) || pages.includes(JSON.stringify(n).slice(1, -1).toLowerCase()));
  if (found.length) throw new Error(`The public copy still shows: ${found.join(', ')}`);
}

// Copy for the claude.ai artifact preview, whose host supplies the doctype, <head> and <body> itself.
const page = template
  .replace(/^<!doctype html>\n<html[^>]*>\n<head>\n/i, '')
  .replace(/<meta charset[^>]*>\n|<meta name="viewport"[^>]*>\n/g, '')
  .replace('</style>\n</head>\n<body>\n', '</style>\n')
  .replace(/\n<\/body>\n<\/html>\n?$/, '\n')
  .replace('/*__DATA__*/null', json);
if (!PUBLIC) {
  mkdirSync(new URL('.artifact/', import.meta.url), { recursive: true });
  writeFileSync(new URL('.artifact/page.html', import.meta.url), page);
}
console.log(`Built ${OUT}index.html (${(json.length / 1024).toFixed(0)} KB of data, through week ${lastWeek}).`);
