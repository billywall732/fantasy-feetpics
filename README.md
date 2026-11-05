# Fantasy Football League

> This is a private friends league. Team names, people names, and awards are members' inside jokes
> and are shown in full on the league site. They are redacted from this repo's documentation.

A stats site for an 8-team, full-PPR ESPN fantasy football league: standings, live scores, power
rankings, awards, head-to-head history and an automatic ice penalty tracker, rebuilt from the ESPN API
on a schedule and published to GitHub Pages.

- **Public site:** https://offthewall.dev/fantasy-football/
- **Seasons:** 2023 (imported from the league's spreadsheet, kept in `history/`) through the current season
- **Stack:** Node.js (no framework), the ESPN Fantasy API, GitHub Actions and GitHub Pages, a small
  Cloudflare Worker, and Nodemailer for email

The repo builds two copies of the site from the same data and code: the league's own (unlisted) and
a public copy with pun team names and first names only (see [Public copy](#public-copy)).

## Requirements

Node.js 20 or newer (the workflow runs Node 22). One dependency, `nodemailer`, for the ice penalty emails.

```
npm install
```

## Build

```
node fetch.mjs            # pulls the latest data from ESPN into data/
node build.mjs            # builds the league site into site/
PUBLIC=1 node build.mjs   # builds the public copy into site-public/
```

Open `site/index.html` in a browser. The page has the data built in; `site/fonts/` holds its fonts.

## Setup

`fetch.mjs` reads ESPN login cookies from `.env` (gitignored):

```
ESPN_S2=...
ESPN_SWID={...}
LEAGUE_ID=...
SEASON=2026
```

If fetching starts returning 401, the cookies have expired. Log into espn.com again and copy fresh
`espn_s2` and `SWID` values from DevTools → Application → Cookies.

`.env` also holds `ICE_SHEET_ID` and `ICE_SHEET_TAB` for the league's penalty log, a Google Sheet shared
as "Anyone with the link can view". If it can't be read, the build keeps the last `data/ice-log.csv`.

## Deploy

`.github/workflows/deploy.yml` runs `scripts/refresh.sh`: fetch, build, then push `site/` to the
`gh-pages` branch, which GitHub Pages serves within seconds, and push `site-public/` to the public
repo. It runs on every push to `main`, on demand, and on a schedule.

1. **Secrets** (Settings → Secrets and variables → Actions): `ESPN_S2` and `ESPN_SWID`.
2. **Variables:** `LEAGUE_ID`, `SEASON`, `ICE_SHEET_ID`, `ICE_SHEET_TAB`.
3. **Pages:** Settings → Pages → Deploy from a branch → `gh-pages` / root (the branch appears after the
   first run).
4. **Run it:** Actions → Build and deploy → Run workflow, or `gh workflow run deploy.yml`. Set "hours"
   to keep it refreshing on the hour for that many hours.

If the ESPN cookies expire, the workflow fails and GitHub emails the repo owner; update the two secrets.

### Refresh schedule

GitHub's own scheduler can start runs hours late, so on-time refreshes come from **cron-job.org**, which
calls GitHub's "run workflow" API at exact times (America/New_York):

- **Daily** at 7:00 and 19:00
- **Sundays** hourly, 8:00–23:00

Two GitHub crons stay in the workflow as a safety net in case cron-job.org is down.

Setting up cron-job.org:

1. **GitHub token:** a fine-grained token with access to this repository only and **Actions → Read and
   write**, nothing else. It can do nothing except start this workflow.
2. **Jobs:** two jobs with the same request:
   - URL `https://api.github.com/repos/billywall732/fantasy-feetpics/actions/workflows/deploy.yml/dispatches`
   - Method POST, body `{"ref":"main"}`
   - Headers `Authorization: Bearer <token>`, `Accept: application/vnd.github+json`,
     `X-GitHub-Api-Version: 2022-11-28`, `Content-Type: application/json`
   - Time zone America/New_York; "Daily" at 7:00 and 19:00, "Sunday hourly" at minute 0 of hours 8–18 and 20–23
3. **Test run:** GitHub answers 204 and a "Build and deploy" run appears under Actions.

A 401 from cron-job.org means the token expired: make a new one and paste it into both jobs. To pause
refreshes in the off-season, disable the two jobs.

### Refresh now button

Both sites have a **Refresh now** button next to "Updated X min ago". It asks a small Cloudflare Worker
(`worker-refresh/`, set up as described in its README) to start the workflow with `source: button`.

- A button run fetches, rebuilds and publishes both sites, and sends no penalty emails (anything that
  locks in is emailed at the next scheduled run).
- The Worker refuses while a refresh is running or within 10 minutes of the last one; the page shows a
  countdown.
- After a press, the page checks `version.json` every 15 seconds and reloads when the new data is live.
- The Worker's address goes in `league.config.json` → `refreshUrl`; with it empty, the button is hidden.

## Ice penalties

Worked out from ESPN scores in `build.mjs`: one ice penalty for the lowest team score of each NFL week
(all tied teams owe one) and one for every starter scoring 0 or less. Playoff penalties count double
(`league.config.json` → `ice.playoffMultiplier`). Due Thursday 8:00 PM ET after the week's last game.

`league.config.json` maps ESPN accounts to the names the league uses. If the build warns about an
unmatched name in the penalty log, add it to that owner's `aliases`.

### Penalty emails

Each refresh, `notify.mjs` emails the manager who owes as soon as a penalty locks in, with a picture,
the reason and the deadline.

- **A starter at 0 or less:** sent once their game is over (4½ hours after kickoff).
- **Lowest score of the week:** sent once the week is final.
- **Already sent:** listed in `notified.json` on the `gh-pages` branch, so nothing goes out twice.
- **Pictures:** `notify-images/dud/` and `notify-images/lowest/` (one is picked at random per email).

Setup:

1. **Gmail app password:** turn on 2-Step Verification for the sending account, then create an app
   password at https://myaccount.google.com/apppasswords.
2. **Secrets** (run these yourself so the values never leave your machine):
   ```
   gh secret set GMAIL_USER -R billywall732/fantasy-feetpics
   gh secret set GMAIL_APP_PASSWORD -R billywall732/fantasy-feetpics
   gh secret set ICE_EMAILS -R billywall732/fantasy-feetpics < ice-emails.json
   ```
   `ICE_EMAILS` is a JSON map of the names shown on the site to email addresses. Locally, the same three
   values go in `.env`.
3. **Test:** `node notify.mjs --test you@example.com` sends one made-up sample of each kind.
4. **Switch on:** `gh variable set NOTIFY_ENABLED --body true -R billywall732/fantasy-feetpics`. Until
   then refreshes only log what they would send; set it to `false` to pause.

## Public copy

`PUBLIC=1 node build.mjs` builds a copy that's safe to show anyone into `site-public/`, from the same data
and code. Each refresh pushes it to the `gh-pages` branch of **billywall732/fantasy-football**, served at
https://offthewall.dev/fantasy-football/. The league's own copy stays unlisted: nothing public links to it,
and its pages tell search engines not to index them.

How the public copy differs:

- **Name:** "Fantasy Football" (`league.config.json` → `public.name`, `short`, `big`).
- **Team names:** one football pun per manager for every season (`public.teams`, keyed like `owners`; a
  new manager needs an entry there or the public build stops).
- **Award names:** `public.awards` gives the public copy its own award names.
- **Managers:** first names only.
- **Penalty rules:** only the ones the site tracks (lowest score, 0-point starters, playoffs double).
- **No emails, no ESPN league ID or link.** `notify.mjs` only reads the league build's
  `data/ice-events.json`; the public build doesn't write it.
- **Leak check:** the public build stops with an error if a full name, an ESPN profile name, a real team
  name or the league's own name ends up on a page.

Push access is an SSH deploy key that can write to `fantasy-football` and nothing else. Its private half
is this repo's `PUBLIC_DEPLOY_KEY` secret; without it, refreshes skip the public copy. To replace it:

```
ssh-keygen -t ed25519 -N "" -C fantasy-football-deploy -f key
gh repo deploy-key add key.pub -R billywall732/fantasy-football --allow-write -t "Publish from the league repo"
gh secret set PUBLIC_DEPLOY_KEY -R billywall732/fantasy-feetpics < key
rm key key.pub
```

## Visit counts

Both sites load Off the Wall's counter script, `https://offthewall.dev/shared/count.js`. It sends page
paths without query strings, the referrer's domain only, device type and browser family, and entry page,
time on page and an estimated exit page. There are no cookies. The weekly traffic email
(`traffic-report.mjs`) counts page views only.

## Files

- `env.mjs`: reads settings from environment variables, falling back to `.env`
- `fetch.mjs`: ESPN API calls (teams, rosters, matchups, box scores, draft, transactions, past seasons)
- `build.mjs`: standings, all-play, luck, power rankings, optimal lineups, draft value, awards and history
- `history/`: seasons from before the league moved to ESPN, imported by `scripts/import-season-sheet.mjs`
- `site-src/template.html`: the page; `build.mjs` injects the data where it says `/*__DATA__*/null`
- `site-src/fonts/`: Barlow and Big Shoulders Display (latin), copied into `site/fonts/` by the build
- `notify.mjs`, `traffic-report.mjs`: the penalty emails and the weekly traffic email
- `worker-refresh/`: the Cloudflare Worker behind the Refresh now button

## License

[MIT](LICENSE)
