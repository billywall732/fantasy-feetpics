#!/usr/bin/env bash
# Fetch from ESPN, build the site and publish it to the gh-pages branch (which GitHub Pages serves).
# Refreshes are started on time by cron-job.org (see README), so each run refreshes once.
#   HOURS  manual runs only: keep refreshing at the top of every hour for this many hours (0 = once)
set -uo pipefail

STOP=$(( $(date +%s) + ${HOURS:-0} * 3600 ))

publish() {
  if ! node fetch.mjs || ! node build.mjs; then
    echo "::warning::Refresh failed at $(date -u +%H:%M) UTC"
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
