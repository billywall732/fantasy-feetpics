#!/usr/bin/env bash
# Fetch from ESPN, build the site and publish it to the gh-pages branch (which GitHub Pages serves).
# Game-day runs then stay up and repeat at the top of every hour, because GitHub's own scheduler is
# too unreliable at busy times to start a fresh run each hour.
#   SCHEDULE  the cron line that started this run (empty for pushes and manual runs)
#   HOURS     for manual runs: keep refreshing on the hour for this many hours (0 = once)
set -uo pipefail

case "${SCHEDULE:-}" in
  "") LOOP_MIN=$(( ${HOURS:-0} * 60 )) ;;
  "30 10 "* | "50 10 "* | "30 22 "* | "50 22 "*) LOOP_MIN=45 ;;  # daily: once now, once at the next hour
  *) LOOP_MIN=350 ;;                                               # game window: hourly for ~6 hours
esac
STOP=$(( $(date +%s) + LOOP_MIN * 60 ))

publish() {
  if ! node fetch.mjs || ! node build.mjs; then
    echo "::warning::Refresh failed at $(date -u +%H:%M) UTC; will try again next hour"
    return 1
  fi
  rm -rf /tmp/pub && cp -r site /tmp/pub
  (
    cd /tmp/pub &&
    git init -q -b gh-pages &&
    git add -A &&
    git -c user.name="github-actions[bot]" -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
      commit -q -m "Refresh $(date -u +%Y-%m-%dT%H:%MZ)" &&
    git push -q -f "https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" gh-pages
  ) && echo "Published at $(date -u +%H:%M:%S) UTC"
}

publish
while :; do
  NOW=$(date +%s)
  NEXT=$(( (NOW / 3600 + 1) * 3600 ))
  [ "$NEXT" -gt "$STOP" ] && break
  echo "Next refresh at $(date -u -d "@$NEXT" +%H:%M) UTC"
  sleep $(( NEXT - NOW ))
  publish
done
