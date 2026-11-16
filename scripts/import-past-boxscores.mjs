// Saves finished ESPN seasons' weekly box scores to history/boxscores-<year>.json, so the All-time awards
// (player weeks, lineups, ices) can reach back before this season. Past seasons don't change, so this
// runs once per season, by hand, and the result is kept in git; refreshes don't fetch them again.
// Usage: node scripts/import-past-boxscores.mjs [year ...]   (default: every past ESPN season)
// Kept small: per NFL week, each team's ESPN team number and every rostered player's slot, name,
// position, NFL team and points. No ESPN account IDs.
import { writeFileSync } from 'node:fs';
import { env } from '../env.mjs';

const { ESPN_S2, ESPN_SWID, LEAGUE_ID } = env;
const SEASON = Number(env.SEASON);
const BASE = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons';
const cookie = `espn_s2=${ESPN_S2}; SWID=${ESPN_SWID}`;
const get = async (url) => {
  const res = await fetch(url, { headers: { cookie } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
};
const league = (season, views, extra = '') =>
  get(`${BASE}/${season}/segments/0/leagues/${LEAGUE_ID}?${views.map((v) => `view=${v}`).join('&')}${extra}`);

const POS = { 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'D/ST' };
const PRO = {
  0: 'FA', 1: 'ATL', 2: 'BUF', 3: 'CHI', 4: 'CIN', 5: 'CLE', 6: 'DAL', 7: 'DEN', 8: 'DET', 9: 'GB', 10: 'TEN',
  11: 'IND', 12: 'KC', 13: 'LV', 14: 'LAR', 15: 'MIA', 16: 'MIN', 17: 'NE', 18: 'NO', 19: 'NYG', 20: 'NYJ',
  21: 'PHI', 22: 'ARI', 23: 'PIT', 24: 'LAC', 25: 'SF', 26: 'SEA', 27: 'TB', 28: 'WSH', 29: 'CAR', 30: 'JAX',
  33: 'BAL', 34: 'HOU',
};

let years = process.argv.slice(2).map(Number);
if (!years.length) years = (await league(SEASON, ['mStatus'])).status.previousSeasons ?? [];
for (const year of years.filter((y) => y !== SEASON)) {
  const s = await league(year, ['mSettings', 'mStatus']);
  const periodOf = {};
  for (const [mp, sps] of Object.entries(s.settings.scheduleSettings.matchupPeriods)) for (const sp of sps) periodOf[sp] = Number(mp);
  const lastSp = Math.max(...Object.keys(periodOf).map(Number));
  const weeks = {};
  for (let sp = 1; sp <= lastSp; sp++) {
    const b = await league(year, ['mMatchupScore', 'mBoxscore'], `&scoringPeriodId=${sp}`);
    weeks[sp] = (b.schedule || []).filter((m) => m.matchupPeriodId === periodOf[sp]).map((m) => ({
      matchupPeriod: m.matchupPeriodId,
      sides: [m.home, m.away].filter((x) => x?.rosterForCurrentScoringPeriod).map((x) => ({
        teamId: x.teamId,
        players: x.rosterForCurrentScoringPeriod.entries.map((e) => {
          const p = e.playerPoolEntry.player;
          return [e.lineupSlotId, p.fullName, POS[p.defaultPositionId] ?? '?', PRO[p.proTeamId] ?? '', Math.round((e.playerPoolEntry.appliedStatTotal || 0) * 100) / 100];
        }),
      })),
    }));
    process.stdout.write('.');
  }
  const out = { seasonId: year, source: 'ESPN box scores (scripts/import-past-boxscores.mjs)', regWeeks: s.settings.scheduleSettings.matchupPeriodCount,
    fields: ['slot', 'name', 'pos', 'pro', 'pts'], weeks };
  writeFileSync(new URL(`../history/boxscores-${year}.json`, import.meta.url), JSON.stringify(out));
  console.log(`\nSaved history/boxscores-${year}.json (${Object.keys(weeks).length} NFL weeks)`);
}
