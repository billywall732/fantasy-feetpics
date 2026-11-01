// The "Refresh now" button's server: starts the Build and deploy workflow with source=button,
// at most once every 10 minutes, and never while a refresh is already running.
//
//   POST /refresh  → { ok: true }  or  { ok: false, reason, retryInSec, lastUpdated }
//   GET  /status   → { running, lastUpdated, retryInSec }
//
// "Last refresh" comes straight from GitHub's list of runs (any kind: scheduled, button, push),
// so there's nothing to store. The GitHub token is a Worker secret, never in the repo or the page.
// Nothing about visitors is logged or kept.

const COOLDOWN_SEC = 10 * 60;
const BUSY = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending']);

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: cors ? 204 : 403, headers: cors || {} });
    if (!cors) return json({ ok: false, reason: 'origin' }, 403, {});

    const url = new URL(request.url);
    try {
      if (url.pathname === '/status' && request.method === 'GET') return json(await status(env), 200, cors);
      if (url.pathname === '/refresh' && request.method === 'POST') {
        const s = await status(env);
        if (s.running) return json({ ok: false, reason: 'running', retryInSec: 60, lastUpdated: s.lastUpdated }, 200, cors);
        if (s.retryInSec > 0) return json({ ok: false, reason: 'cooldown', retryInSec: s.retryInSec, lastUpdated: s.lastUpdated }, 200, cors);
        const res = await gh(env, `/actions/workflows/${env.WORKFLOW}/dispatches`, { method: 'POST', body: JSON.stringify({ ref: env.BRANCH, inputs: { source: 'button' } }) });
        if (res.status !== 204) return json({ ok: false, reason: 'github', status: res.status }, 502, cors);
        return json({ ok: true }, 200, cors);
      }
      return json({ ok: false, reason: 'not found' }, 404, cors);
    } catch {
      return json({ ok: false, reason: 'error' }, 502, cors);
    }
  },
};

// The newest runs of the workflow tell us both "is one running" and "when was the last one"
async function status(env) {
  const res = await gh(env, `/actions/workflows/${env.WORKFLOW}/runs?per_page=10`);
  if (!res.ok) throw new Error(`GitHub ${res.status}`);
  const { workflow_runs: runs = [] } = await res.json();
  const running = runs.some((r) => BUSY.has(r.status));
  const latest = runs[0];
  const lastDone = runs.find((r) => r.status === 'completed' && r.conclusion === 'success');
  const startedAgo = latest ? (Date.now() - Date.parse(latest.run_started_at || latest.created_at)) / 1000 : Infinity;
  return {
    running,
    lastUpdated: lastDone ? lastDone.updated_at : null,
    retryInSec: Math.max(0, Math.ceil(COOLDOWN_SEC - startedAgo)),
  };
}

function gh(env, path, init = {}) {
  return fetch(`https://api.github.com/repos/${env.REPO}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'fantasy-feetpics-refresh-button',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
}

// Only the site's own pages (and local development) may call this
function corsHeaders(origin, env) {
  const allowed = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  const ok = allowed.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return ok ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400', Vary: 'Origin' } : null;
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });
}
