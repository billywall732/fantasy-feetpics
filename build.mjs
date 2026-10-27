// Turns data/*.json into site/index.html (data built in) plus site/fonts/.
// Usage: node build.mjs   (run fetch.mjs first)
import { readFileSync, writeFileSync, mkdirSync, existsSync, cpSync } from 'node:fs';
import { env } from './env.mjs';

const read = (f) => JSON.parse(readFileSync(new URL(f, import.meta.url), 'utf8'));
const SEASON = Number(env.SEASON);

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

// ---------- Owners (stable across seasons; team names change every year) ----------
const owners = {};
for (const season of [SEASON, ...(cur.status.previousSeasons || [])]) {
  const s = season === SEASON ? cur : read(`data/season-${season}.json`);
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

// ---------- Current season ----------
const regWeeks = cur.settings.scheduleSettings.matchupPeriodCount;
const playoffTeams = cur.settings.scheduleSettings.playoffTeamCount;
const currentWeek = cur.status.currentMatchupPeriod;
const doneMatchups = cur.schedule.filter((m) => m.winner !== 'UNDECIDED' && m.matchupPeriodId <= regWeeks);
const doneWeeks = [...new Set(doneMatchups.map((m) => m.matchupPeriodId))].sort((a, b) => a - b);

const teams = cur.teams.map((t) => ({
  id: t.id,
  name: t.name.trim(),
  abbrev: t.abbrev,
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
  const pool = entries
    .filter((e) => e.lineupSlotId !== 21)
    .map((e) => ({ pos: POS[e.playerPoolEntry.player.defaultPositionId], pts: e.playerPoolEntry.appliedStatTotal || 0 }))
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
  { title: 'Bench Cuck', value: fmt(benchy.benchLeft), teamId: benchy.id, note: `Points short of the optimal lineup; ${benchy.optimalLosses} losses would have been wins` },
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
// Doubled in the playoffs. Due Thursday 8:00 PM Eastern after the week's last NFL game.
const nflWeeks = read('data/nfl-weeks.json');
const periodOf = {};
for (const [mp, sps] of Object.entries(cur.settings.scheduleSettings.matchupPeriods)) for (const sp of sps) periodOf[sp] = Number(mp);
const ET = 'America/New_York';
const etParts = (ms) => Object.fromEntries(
  new Intl.DateTimeFormat('en-US', { timeZone: ET, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short', hour: 'numeric', hourCycle: 'h23' })
    .formatToParts(new Date(ms)).map((p) => [p.type, p.value])
);
function etToUtc(y, mo, d, h) {
  for (const off of [4, 5]) {
    const t = Date.UTC(y, mo - 1, d, h + off);
    const p = etParts(t);
    if (Number(p.hour) === h && Number(p.day) === new Date(Date.UTC(y, mo - 1, d)).getUTCDate()) return t;
  }
  return Date.UTC(y, mo - 1, d, h + 5);
}
function deadlineFor(sp) {
  const last = nflWeeks[sp]?.last;
  if (!last) return null;
  const p = etParts(last);
  const days = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  let ahead = (4 - days[p.weekday] + 7) % 7 || 7; // the next Thursday after the last game
  const d = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day) + ahead));
  return etToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), 20);
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
    live,
  });
}
for (const t of teams) for (const w of doneWeeks) t.weeks[w].ices = iceWeeks.find((x) => x.week === w)?.owed.find((o) => o.teamId === t.id)?.ices ?? 0;

// Locked-in ices that aren't due yet, for notify.mjs to email (never published: owner names stay in data/).
// Duds lock when the player's game ends; the lowest score locks when the week is final.
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
    // Emails can't be taken back, so mid-week duds wait until well after the game (overtime, delays).
    for (const r of wk.live?.locked || []) {
      if (r.kickoff && NOW >= r.kickoff + 4.5 * 3600e3) dud(r.teamId, { player: r.name, pos: r.pos, pro: r.pro, pts: r.pts });
    }
  }
  writeFileSync(new URL('data/ice-events.json', import.meta.url), JSON.stringify([...events.values()], null, 2));
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
for (const o of Object.values(owners)) for (const n of [o.name, o.espnName, o.short, ...(o.aliases || [])].filter(Boolean)) nameToOwner.set(n.toLowerCase(), o.id);
const iceLog = [];
const unmatched = new Set();
if (existsSync(new URL('data/ice-log.csv', import.meta.url))) {
  const [header, ...rows] = parseCsv(readFileSync(new URL('data/ice-log.csv', import.meta.url), 'utf8'));
  const col = (re) => header.findIndex((h) => re.test(h));
  const c = { who: col(/manager|name/i), week: col(/week/i), why: col(/why|reason/i), date: col(/date/i), time: col(/time completed/i), secs: col(/time of ice|seconds|duration/i) };
  for (const r of rows) {
    const name = (r[c.who] || '').trim();
    if (!name) continue;
    const ownerId = nameToOwner.get(name.toLowerCase());
    if (!ownerId) { unmatched.add(name); continue; }
    const secs = parseFloat(String(r[c.secs] || '').replace(/[^\d.]/g, ''));
    iceLog.push({ ownerId, week: Number(r[c.week]) || null, why: (r[c.why] || '').trim(), date: (r[c.date] || '').trim(), time: (r[c.time] || '').trim(), secs: Number.isFinite(secs) ? secs : null });
  }
}
if (unmatched.size) console.warn(`Ice log names not matched to an owner (add them as aliases in league.config.json): ${[...unmatched].join(', ')}`);

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
for (const year of [...(cur.status.previousSeasons || []), SEASON].sort()) {
  const s = year === SEASON ? cur : read(`data/season-${year}.json`);
  const reg = s.settings.scheduleSettings.matchupPeriodCount;
  const done = s.schedule.filter((m) => m.winner !== 'UNDECIDED' && m.away);
  const tName = Object.fromEntries(s.teams.map((t) => [t.id, t.name.trim()]));
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
        name: t.name.trim(),
        ownerId: t.primaryOwner,
        owner: owners[t.primaryOwner]?.name,
        w: t.record.overall.wins,
        l: t.record.overall.losses,
        pf: r2(t.record.overall.pointsFor),
        seed: t.playoffSeed,
        final: complete ? t.rankCalculatedFinal : null,
      }))
      .sort((a, b) => (complete ? a.final - b.final : a.seed - b.seed)),
    champion: champ && { name: champ.name.trim(), owner: owners[champ.primaryOwner]?.name },
    runnerUp: runner && { name: runner.name.trim(), owner: owners[runner.primaryOwner]?.name },
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

// ---------- Output ----------
const model = {
  league: { name: cur.settings.name.trim(), season: SEASON, currentWeek, lastWeek, regWeeks, playoffTeams, size: teams.length, trades, updated: cur.status.standingsUpdateDate, built: Date.now(), leagueId: env.LEAGUE_ID, weekStart: weekSpans[currentWeek]?.first ?? null, weekEnd: weekSpans[currentWeek]?.last ?? null },
  teams: teams.sort((a, b) => a.seed - b.seed),
  matchups,
  upcoming,
  rosters,
  draft,
  moves: moves.slice(0, 40).map((m) => ({ ...m, adds: m.adds.map(({ name, pos }) => ({ name, pos })), drops: m.drops.map(({ name, pos }) => ({ name, pos })) })),
  wire,
  awards,
  seasons,
  allTime: allTimeList,
  h2h,
  owners,
  records,
  ownerHighLow,
  schedules,
  highsLows,
  ice: { weeks: iceWeeks, log: iceLog, table: iceTable, multiplier, currentSp: latestSp },
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
const template = minify(readFileSync(new URL('site-src/template.html', import.meta.url), 'utf8'));
if (!template.includes('/*__DATA__*/null')) throw new Error('Data placeholder missing from the template.');
// ESPN account IDs (one of them doubles as the SWID login cookie) never go on the page: swap each for a short label.
let json = JSON.stringify(model).replace(/</g, '\\u003c');
Object.keys(owners).forEach((id, i) => { json = json.split(id).join(`o${i + 1}`); });
if (/\{[0-9A-F]{8}-[0-9A-F]{4}-/i.test(json)) throw new Error('An ESPN account ID is still in the page data.');
mkdirSync(new URL('site/', import.meta.url), { recursive: true });
writeFileSync(new URL('site/index.html', import.meta.url), template.replace('/*__DATA__*/null', json));
cpSync(new URL('site-src/fonts/', import.meta.url), new URL('site/fonts/', import.meta.url), { recursive: true });
cpSync(new URL('site-src/static/', import.meta.url), new URL('site/', import.meta.url), { recursive: true });
// Tiny file the page polls (cache-busted) to know when newer data has been published.
writeFileSync(new URL('site/version.json', import.meta.url), JSON.stringify({ built: model.league.built }));
writeFileSync(new URL('site/.nojekyll', import.meta.url), '');

// Copy for the claude.ai artifact preview, whose host supplies the doctype, <head> and <body> itself.
const page = template
  .replace(/^<!doctype html>\n<html[^>]*>\n<head>\n/i, '')
  .replace(/<meta charset[^>]*>\n|<meta name="viewport"[^>]*>\n/g, '')
  .replace('</style>\n</head>\n<body>\n', '</style>\n')
  .replace(/\n<\/body>\n<\/html>\n?$/, '\n')
  .replace('/*__DATA__*/null', json);
mkdirSync(new URL('.artifact/', import.meta.url), { recursive: true });
writeFileSync(new URL('.artifact/page.html', import.meta.url), page);
console.log(`Built site/index.html (${(json.length / 1024).toFixed(0)} KB of data, through week ${lastWeek}).`);
