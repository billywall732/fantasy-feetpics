// Pulls league data from ESPN's fantasy API into data/*.json.
// Usage: node fetch.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { env } from './env.mjs';

const { ESPN_S2, ESPN_SWID, LEAGUE_ID } = env;
const SEASON = Number(env.SEASON);
const BASE = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons';
const cookie = `espn_s2=${ESPN_S2}; SWID=${ESPN_SWID}`;

async function get(url, headers = {}) {
  const res = await fetch(url, { headers: { cookie, ...headers } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}\n${await res.text()}`);
  return res.json();
}

const league = (season, views, extra = '') =>
  get(`${BASE}/${season}/segments/0/leagues/${LEAGUE_ID}?${views.map((v) => `view=${v}`).join('&')}${extra}`);

mkdirSync(new URL('data/', import.meta.url), { recursive: true });
const save = (name, data) => {
  writeFileSync(new URL(`data/${name}.json`, import.meta.url), JSON.stringify(data));
  console.log(`  saved data/${name}.json`);
};

console.log(`Fetching ${SEASON} season...`);
const current = await league(SEASON, ['mTeam', 'mSettings', 'mStatus', 'mRoster', 'mMatchup', 'mMatchupScore', 'mDraftDetail']);
save(`season-${SEASON}`, current);

// Transactions are paged by scoring period.
const latest = current.status.latestScoringPeriod;
const transactions = [];
for (let sp = 0; sp <= latest; sp++) {
  const t = await league(SEASON, ['mTransactions2'], `&scoringPeriodId=${sp}`);
  transactions.push(...(t.transactions || []));
}
// ESPN returns the current week's transactions under more than one period, so keep each ID once.
save(`transactions-${SEASON}`, [...new Map(transactions.map((x) => [x.id, x])).values()]);

// League activity feed: the only place ESPN lists which players moved in a trade.
const activity = [];
for (let offset = 0; ; offset += 200) {
  const page = await get(`${BASE}/${SEASON}/segments/0/leagues/${LEAGUE_ID}/communication/?view=kona_league_communication`, {
    'x-fantasy-filter': JSON.stringify({
      topics: {
        filterType: { value: ['ACTIVITY_TRANSACTIONS'] },
        limit: 200,
        limitPerMessageSet: { value: 25 },
        offset,
        sortMessageDate: { sortPriority: 1, sortAsc: false },
        sortFor: { sortPriority: 2, sortAsc: false },
        filterIncludeMessageTypeIds: { value: [178, 179, 180, 181, 239, 244] },
      },
    }),
  });
  const topics = page.topics || [];
  activity.push(...topics.map((t) => ({ id: t.id, date: t.date, messages: (t.messages || []).map((m) => ({ type: m.messageTypeId, from: m.from, to: m.to, playerId: m.targetId })) })));
  if (topics.length < 200) break;
}
save(`activity-${SEASON}`, activity);

// Per-NFL-week box scores with each player's points. Keyed by scoring period (NFL week); playoff
// matchups span two scoring periods, so map each week to its matchup period.
const periodOf = {};
for (const [mp, sps] of Object.entries(current.settings.scheduleSettings.matchupPeriods)) {
  for (const sp of sps) periodOf[sp] = Number(mp);
}
const boxscores = {};
for (let sp = 1; sp <= latest; sp++) {
  const b = await league(SEASON, ['mMatchupScore', 'mBoxscore'], `&scoringPeriodId=${sp}`);
  boxscores[sp] = (b.schedule || []).filter((m) => m.matchupPeriodId === periodOf[sp]);
}
save(`boxscores-${SEASON}`, boxscores);

// NFL game times, for each week's ice deadline.
console.log('Fetching NFL schedule...');
const pro = await get(`${BASE}/${SEASON}?view=proTeamSchedules_wl`);
const gameTimes = {};
for (const t of pro.settings.proTeams) {
  for (const [sp, gs] of Object.entries(t.proGamesByScoringPeriod || {})) {
    for (const g of gs) (gameTimes[sp] ??= []).push(g.date);
  }
}
save('nfl-weeks', Object.fromEntries(Object.entries(gameTimes).map(([sp, ds]) => [sp, { first: Math.min(...ds), last: Math.max(...ds) }])));

// Ice log from the league's Google Sheet (needs "anyone with the link can view").
console.log('Fetching ice log...');
if (env.ICE_SHEET_ID) {
  const url = `https://docs.google.com/spreadsheets/d/${env.ICE_SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(env.ICE_SHEET_TAB || 'Ice Stats')}`;
  const res = await fetch(url);
  const text = await res.text();
  if (res.ok && !text.trimStart().startsWith('<')) {
    writeFileSync(new URL('data/ice-log.csv', import.meta.url), text);
    console.log('  saved data/ice-log.csv');
  } else {
    console.warn(`  Could not read the sheet (HTTP ${res.status}). Set its sharing to "Anyone with the link can view".`);
    console.warn('  Keeping the previous data/ice-log.csv if there is one.');
  }
}

for (const season of current.status.previousSeasons || []) {
  console.log(`Fetching ${season} season...`);
  save(`season-${season}`, await league(season, ['mTeam', 'mSettings', 'mStatus', 'mMatchup', 'mDraftDetail']));
}

// Player names for draft picks and transactions (players not currently rostered).
console.log('Fetching player index...');
const players = await get(`${BASE}/${SEASON}/players?scoringPeriodId=0&view=players_wl`, {
  'x-fantasy-filter': JSON.stringify({ filterActive: { value: true } }),
});
save('players', players.map((p) => ({ id: p.id, name: p.fullName, pos: p.defaultPositionId, team: p.proTeamId })));

// Season totals and positional ranks for every drafted or rostered player.
console.log('Fetching player season stats...');
const ids = [
  ...new Set([
    ...current.draftDetail.picks.map((p) => p.playerId),
    ...current.teams.flatMap((t) => t.roster.entries.map((e) => e.playerId)),
  ]),
];
const pinfo = await get(
  `${BASE}/${SEASON}/segments/0/leagues/${LEAGUE_ID}?view=kona_player_info&scoringPeriodId=${latest}`,
  { 'x-fantasy-filter': JSON.stringify({ players: { filterIds: { value: ids }, limit: ids.length, sortPercOwned: { sortPriority: 1, sortAsc: false } } }) }
);
save(
  'player-stats',
  pinfo.players.map((p) => ({
    id: p.id,
    name: p.player.fullName,
    pos: p.player.defaultPositionId,
    team: p.player.proTeamId,
    injury: p.player.injuryStatus,
    onTeamId: p.onTeamId,
    seasonPts:
      p.player.stats?.find((s) => s.seasonId === SEASON && s.statSourceId === 0 && s.statSplitTypeId === 0)
        ?.appliedTotal ?? 0,
    posRank: p.ratings?.['0']?.positionalRanking ?? null,
  }))
);

console.log('Done.');
