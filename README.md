# Fantasy Feetpics

A stats site for the Fantasy Feetpics ESPN league (league 395796507).

## Refresh

```
node fetch.mjs   # pulls the latest data from ESPN into data/
node build.mjs   # builds site/index.html
PUBLIC=1 node build.mjs   # builds the public copy in site-public/ (see "Public copy" below)
```

Open `site/index.html` in a browser. The page has the data built in; `site/fonts/` holds its fonts.

## Refresh schedule

`.github/workflows/deploy.yml` runs `scripts/refresh.sh`: fetch, build, then push `site/` to the
`gh-pages` branch, which GitHub Pages serves within seconds. It runs on every push to `main`, on demand,
and whenever cron-job.org asks for it.

GitHub's own scheduler can start runs hours late, so on-time refreshes come from **cron-job.org**,
which calls GitHub's "run workflow" API at exact times (America/New_York):

- **Daily** at 7:00 and 19:00
- **Sundays** hourly, 8:00–23:00

Two GitHub crons stay in the workflow as a safety net in case cron-job.org is ever down.

### Setting up cron-job.org

1. **GitHub token.** GitHub → Settings → Developer settings → Fine-grained tokens → Generate new token.
   Repository access: only `fantasy-feetpics`. Permissions: **Actions → Read and write**, nothing else.
   It can do nothing except start this workflow.
2. **cron-job.org jobs.** Two jobs with the same request:
   - URL `https://api.github.com/repos/billywall732/fantasy-feetpics/actions/workflows/deploy.yml/dispatches`
   - Method POST, body `{"ref":"main"}`
   - Headers `Authorization: Bearer <token>`, `Accept: application/vnd.github+json`,
     `X-GitHub-Api-Version: 2022-11-28`, `Content-Type: application/json`
   - Time zone America/New_York
   - "Daily": every day at 7:00 and 19:00. "Sunday hourly": Sundays, minute 0 of hours 8–18 and 20–23.
3. **Test run** a job: GitHub answers 204, and a "Build and deploy" run appears under Actions.

- **Token expired** (cron-job.org reports 401): make a new token and paste it into both jobs.
- **Pause refreshes** (off-season): disable the two cron-job.org jobs.
- **Manual refresh:** `gh workflow run deploy.yml`, or Actions → Build and deploy → Run workflow.
  Set "hours" to keep it refreshing on the hour for that many hours.

## Refresh now button

Both sites (the league's and Fantasy Football) have a **Refresh now** button next to "Updated X min ago". It asks a small Cloudflare Worker (`worker-refresh/`, set up as described in its README) to start the Build and deploy workflow with `source: button`.

- **What a button run does:** it fetches, rebuilds and publishes both sites, and sends **no ice emails**. An ice that locks in during a button run is emailed at the next scheduled run.
- **Limits:** the Worker refuses while a refresh is running, or within 10 minutes of the last one (of any kind). The page then shows a countdown.
- **After a press:** the page checks `version.json` every 15 seconds and reloads itself when the new data is published.
- **Turning it on:** the Worker's address goes in `league.config.json` → `refreshUrl`. With it empty, the button is hidden.

Scheduled and other runs (cron-job.org, GitHub's crons, pushes, Run workflow) leave `source` at `schedule` and behave as before.

## Ice emails

Each refresh, `notify.mjs` emails the manager who owes as soon as an ice locks in, with a picture, the
reason and the deadline.

- **A starter at 0 or less:** sent once their game is over (4½ hours after kickoff).
- **Lowest score of the week:** sent once the week is final.
- **Ices already emailed** are listed in `notified.json` on the `gh-pages` branch, so nothing goes out twice.
- **Pictures:** `notify-images/dud/` and `notify-images/lowest/` (one is picked at random per email).

Setup:
1. **Gmail app password:** turn on 2-Step Verification for the Gmail account, then go to
   https://myaccount.google.com/apppasswords and create one named "Feetpics".
2. **Secrets** (run these yourself so the values never leave your machine):
   ```
   gh secret set GMAIL_USER -R billywall732/fantasy-feetpics
   gh secret set GMAIL_APP_PASSWORD -R billywall732/fantasy-feetpics
   gh secret set ICE_EMAILS -R billywall732/fantasy-feetpics < ice-emails.json
   ```
   `ICE_EMAILS` is a JSON map of the names shown on the site to email addresses. Locally, the same three
   values go in `.env`.
3. **Test:** `node notify.mjs --test you@example.com` sends one made-up sample of each kind.
4. **Switch on:** `gh variable set NOTIFY_ENABLED --body true -R billywall732/fantasy-feetpics`.
   Until then refreshes only log what they would send. Set it to `false` to pause.

## Publish on GitHub Pages

1. Create a **public** GitHub repo and push this folder to its `main` branch. `.env`, `data/` and `site/`
   are gitignored, so no cookies or raw data get pushed.
2. In the repo, go to **Settings → Secrets and variables → Actions**:
   - **Secrets:** `ESPN_S2` and `ESPN_SWID` (the same values as in `.env`).
   - **Variables:** `LEAGUE_ID` = `395796507`, `SEASON` = `2026`, `ICE_SHEET_ID` = the sheet ID,
     `ICE_SHEET_TAB` = `Ice Stats`.
3. **Settings → Pages → Build and deployment → Source: Deploy from a branch → `gh-pages` / root**
   (the branch appears after the first workflow run).
4. **Actions → Build and deploy → Run workflow.** The site appears at
   `https://<your-username>.github.io/<repo-name>/`.

Anyone with that link can see the site, including owners' real names. It's kept *unlisted*: nothing
public links to it and its pages tell search engines not to index them. The public copy below is the one
to share. If the ESPN cookies expire,
the workflow fails and GitHub emails the repo owner; update the two secrets with fresh cookies.

## Public copy: Fantasy Football

`PUBLIC=1 node build.mjs` builds a copy that's safe to show anyone into `site-public/`, from the same data
and code. Each refresh builds it after the league's site and pushes it to the `gh-pages` branch of
**billywall732/fantasy-football**, served at https://billywall732.github.io/fantasy-football/.

How it differs:
- **Name:** Fantasy Football (`league.config.json` → `public.name`, `short`, `big` for the cover).
- **Team names:** one football pun per manager for every season (`public.teams`, keyed like `owners`;
  a new manager needs an entry there or the public build stops).
- **Award names:** `public.awards` renames awards for the public copy (Bench Cuck → Left on Bench).
- **Managers:** first names only. The ice sheet still matches on full names; they just never reach the page.
- **Ice rules:** only the ones the site tracks (lowest score, 0-point starters, playoffs double). No
  missed-deadline doubling and no off-the-field ices.
- **No emails, no ESPN league ID or link.** `notify.mjs` only ever reads the league build's
  `data/ice-events.json`; the public build doesn't write it.
- **Visit counts** go to the portfolio's GoatCounter (`public.goatcounter`, offthewall.goatcounter.com) as
  `/fantasy-football/` and `/fantasy-football/app.html#<tab>`, not to the league's counter or traffic report.
- **Leak check:** the public build stops with an error if a full name, ESPN profile name, any real team
  name or "Feetpics" ends up on a page.

Push access is an SSH deploy key that can write to `fantasy-football` and nothing else. Its private half
is this repo's `PUBLIC_DEPLOY_KEY` secret; without it, refreshes skip the public copy. To replace it:
```
ssh-keygen -t ed25519 -N "" -C fantasy-football-deploy -f key
gh repo deploy-key add key.pub -R billywall732/fantasy-football --allow-write -t "Refresh from fantasy-feetpics"
gh secret set PUBLIC_DEPLOY_KEY -R billywall732/fantasy-feetpics < key
rm key key.pub
```

## Setup

`fetch.mjs` reads ESPN login cookies from `.env` (gitignored):

```
ESPN_S2=...
ESPN_SWID={...}
LEAGUE_ID=395796507
SEASON=2026
```

If fetching starts returning 401, the cookies have expired. Log into espn.com again and copy fresh
`espn_s2` and `SWID` values from DevTools → Application → Cookies.

`.env` also holds `ICE_SHEET_ID` and `ICE_SHEET_TAB` for the ice log. The sheet must be shared as
"Anyone with the link can view". If it can't be read, the build keeps the last `data/ice-log.csv`.

## Ice rules

Worked out from ESPN scores in `build.mjs`. One ice for the lowest team score of each NFL week (all tied
teams owe one) and one for every starter scoring 0 or less. Playoff ices count double
(`league.config.json` → `ice.playoffMultiplier`). Due Thursday 8:00 PM ET after the week's last game.

`league.config.json` maps ESPN accounts to the names the league uses. If the build warns about an
unmatched name in the ice log, add it to that owner's `aliases`.

## Files

- `env.mjs`: reads settings from environment variables, falling back to `.env`
- `fetch.mjs`: ESPN API calls (teams, rosters, matchups, box scores, draft, transactions, past seasons)
- `build.mjs`: computes standings, all-play, luck, power rankings, optimal lineups, draft value, awards and history
- `site-src/template.html`: the page; `build.mjs` injects the data where it says `/*__DATA__*/null`
- `site-src/fonts/`: Barlow and Big Shoulders Display (latin), copied into `site/fonts/` by the build
