// Weekly stats email for offthewall.dev (the whole site), separate from the league's own report
// (traffic-report.mjs). It reads the site's stats Worker, the same numbers as offthewall.dev/stats/,
// so there's no second GoatCounter key to keep. Counts only: nothing about any one visitor.
//
// Usage:
//   node site-report.mjs              email the last 7 days to the report address
//   node site-report.mjs --dry-run    write the email to data/site-report.html instead of sending
//   node site-report.mjs --to x@y.com send to a different address
//
// Lives in this repo because the Gmail login it sends with is already a secret here.
import { readFileSync, writeFileSync } from 'node:fs';
import nodemailer from 'nodemailer';
import { env } from './env.mjs';

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const config = JSON.parse(readFileSync(new URL('league.config.json', import.meta.url), 'utf8'));
const TO = args.includes('--to') ? args[args.indexOf('--to') + 1] : (config.siteReportTo || config.trafficReportTo);
const WORKER = 'https://otw-stats.offthewall-dev.workers.dev/summary?site=offthewall';
const DASHBOARD = 'https://offthewall.dev/stats/';
const FROM = () => `"Off the Wall Stats" <${env.GMAIL_USER}>`;

// If anything below fails, say so by email instead of the report just not arriving, and still
// exit with an error so the GitHub Actions run shows red.
process.on('uncaughtException', async (err) => {
  console.error(err);
  if (!DRY && TO && env.GMAIL_USER && env.GMAIL_APP_PASSWORD) {
    try {
      await mailer().sendMail({
        from: FROM(), to: TO, subject: '⚠️ The Off the Wall weekly stats email failed',
        text: `This week's Off the Wall stats email couldn't be made:\n\n${err?.message || err}\n\nThe run's full log is on GitHub: fantasy-feetpics → Actions → Off the Wall weekly stats.\nThe numbers are still on ${DASHBOARD}`,
      });
      console.error(`Sent a failure notice to ${TO}`);
    } catch (e) { console.error('Could not send the failure notice:', e.message); }
  }
  process.exit(1);
});
const mailer = () => nodemailer.createTransport({ service: 'gmail', auth: { user: env.GMAIL_USER, pass: env.GMAIL_APP_PASSWORD.replace(/\s+/g, '') } });

// ---------- The numbers ----------
// The Worker answers only the site's own pages (it checks the Origin header), so say this comes
// from the site. The data is the same aggregate summary the public /stats/ page shows.
const res = await fetch(WORKER, { headers: { Origin: 'https://offthewall.dev' } });
const data = await res.json().catch(() => ({}));
if (!res.ok || data.error) throw new Error(`Stats Worker ${res.status}: ${data.error || 'no summary'}${data.detail ? ` (${data.detail})` : ''}`);
const week = data.ranges?.week, month = data.ranges?.month;
if (!week?.trend?.points || !month?.trend?.points) throw new Error('The stats Worker answered without the weekly numbers');
const ageHours = (Date.now() - Date.parse(data.generatedAt)) / 36e5;
if (ageHours > 6) throw new Error(`The stats Worker's numbers are ${Math.round(ageHours)} hours old (it should refresh every 20 minutes)`);

const days = week.trend.points; // the last 7 days through today, in the site's time zone
const before = month.trend.points.filter((p) => p.day < days[0].day).slice(-7); // the 7 days before
const total = week.views;
const prevTotal = before.reduce((a, p) => a + p.views, 0);
const change = prevTotal ? Math.round(((total - prevTotal) / prevTotal) * 100) : null;
const busiest = [...days].sort((a, b) => b.views - a.views)[0];

// Names a person would use, like the stats page
const APPS = { 'snow-surf-report': 'Snow and Surf Report', 'fantasy-football': 'Fantasy Football', 'my-budget-ledger': 'Budget Ledger', contrail: 'Contrail', wallet: 'What’s in My Wallet?', 'code-breaker': 'Krillion Code Breaker', 'loop-lab': 'Loop Lab', contact: 'Contact', privacy: 'Privacy' };
function pageName(path) {
  if (path === '/') return 'Cover';
  const home = path.match(/^\/home\/(?:#(.+))?$/);
  if (home) return home[1] ? `Home · ${home[1]}` : 'Home';
  const project = path.match(/^\/projects\/([^/]+)\/?$/);
  if (project) return `Project page · ${project[1].replace(/-/g, ' ')}`;
  const [, app = '', ...rest] = path.split('/');
  const more = rest.join('/').replace(/^app\.html#?/, '').replace(/\/$/, '');
  return APPS[app] ? `${APPS[app]}${more ? ` · ${more}` : ''}` : path;
}
const pages = [...week.pages].sort((a, b) => b.views - a.views).slice(0, 8).map((p) => ({ name: pageName(p.path), count: p.views }));
const OWN = new Set(['offthewall.dev', 'www.offthewall.dev', 'billywall732.github.io']);
const referrers = (week.referrers || []).filter((r) => r.domain && !r.domain.startsWith('(') && !OWN.has(r.domain)).slice(0, 6).map((r) => ({ name: r.domain, count: r.views }));
const deviceTotal = Object.values(week.devices || {}).reduce((a, b) => a + b, 0);
const DEVICE = { phone: 'Phone', tablet: 'Tablet', laptop: 'Laptop or desktop' };
const devices = Object.entries(week.devices || {}).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${DEVICE[k] || k} ${Math.round((n / deviceTotal) * 100)}%`).join(' · ');
const stateTotal = (week.regions || []).reduce((a, r) => a + r.views, 0);
const states = (week.regions || []).filter((r) => r.name !== 'Unknown').slice(0, 5).map((r) => `${r.name} ${Math.round((r.views / stateTotal) * 100)}%`).join(' · ');

// ---------- Email ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const dayName = (d, opts) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', ...opts });
const short = (d) => dayName(d, { month: 'short', day: 'numeric' });
const first = days[0].day, last = days.at(-1).day;
const ORANGE = '#ff6a1f', INK = '#161513', MUTED = '#6b655c', CARD = '#f6f2ea';
const maxDay = Math.max(1, ...days.map((d) => d.views));
// Summary boxes: a 2 x 2 grid of equal boxes with one fixed size per line. Four across was too
// cramped on a phone (each box wrapped differently and sized itself), and iPhone Mail enlarged the
// small text by different amounts, so the boxes came out in different sizes. The background is on
// the cell itself, so the two boxes in a row always share one height.
const tile = (label, value, sub) => `<td width="50%" valign="top" style="background:${CARD};border-radius:10px;padding:12px 14px">
  <div style="font-size:11px;line-height:14px;letter-spacing:1.5px;color:${MUTED};font-weight:bold;text-transform:uppercase;white-space:nowrap">${label}</div>
  <div style="font-size:24px;line-height:30px;font-weight:900;color:${INK}">${value}</div>
  <div style="font-size:12px;line-height:16px;color:${MUTED}">${sub}</div></td>`;
const tiles = (a, b, c, d) => `<table role="presentation" width="100%" cellspacing="8" cellpadding="0" style="border-collapse:separate;table-layout:fixed"><tr>${a}${b}</tr><tr>${c}${d}</tr></table>`;
const listRows = (items) => items.map((it) => `<tr><td style="padding:6px 0;border-bottom:1px solid #eee7da;font-size:14px">${esc(it.name)}</td><td style="padding:6px 0;border-bottom:1px solid #eee7da;font-size:14px;text-align:right;font-weight:bold">${it.count}</td></tr>`).join('');
const subject = `📈 Off the Wall: ${total} views this week (${short(first)}–${short(last)})${change == null ? '' : `, ${change >= 0 ? '▲' : '▼'} ${Math.abs(change)}%`}`;

// The head tells phones to show the email at its real size: without it, iPhone Mail rescales text
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="x-apple-disable-message-reformatting">
<style>body{-webkit-text-size-adjust:100%;text-size-adjust:100%}</style></head><body style="margin:0;padding:0;background:#efe9de;font-family:Arial,Helvetica,sans-serif;color:${INK};-webkit-text-size-adjust:100%">
<div style="max-width:620px;margin:0 auto;padding:16px">
  <div style="background:#121110;color:#f1ede4;border-radius:12px 12px 0 0;padding:18px 20px">
    <div style="font-size:12px;letter-spacing:2px;color:${ORANGE};font-weight:bold">OFF THE WALL · WEEKLY STATS</div>
    <div style="font-size:24px;font-weight:900;margin-top:4px">${dayName(first, { weekday: 'short' })} ${short(first)} – ${dayName(last, { weekday: 'short' })} ${short(last)}</div>
  </div>
  <div style="background:#ffffff;border-radius:0 0 12px 12px;padding:16px 14px">
    ${tiles(
      tile('Views', total, change == null ? 'first week tracked' : `${change >= 0 ? '▲' : '▼'} ${Math.abs(change)}% vs last week`),
      tile('Daily avg', (total / 7).toFixed(1), 'views per day'),
      tile('Busiest day', total ? dayName(busiest.day, { weekday: 'short' }) : '—', total ? `${busiest.views} views` : ''),
      tile('Top page', pages[0] ? esc(pages[0].name.split(' · ')[0]) : '—', pages[0] ? `${pages[0].count} views` : ''))}

    <h3 style="margin:18px 6px 8px;font-size:16px">Views by day</h3>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:0 6px">
      ${days.map((d) => `<tr><td style="font-size:13px;padding:4px 8px 4px 0;white-space:nowrap;width:86px">${dayName(d.day, { weekday: 'short' })} ${short(d.day)}</td>
        <td style="padding:4px 0"><div style="background:${ORANGE};height:16px;border-radius:4px;width:${Math.max(2, Math.round((d.views / maxDay) * 100))}%"></div></td>
        <td style="font-size:13px;font-weight:bold;text-align:right;width:40px;padding-left:8px">${d.views}</td></tr>`).join('')}
    </table>

    <h3 style="margin:22px 6px 6px;font-size:16px">Most-viewed pages and apps</h3>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:0 6px">${pages.length ? listRows(pages) : `<tr><td style="color:${MUTED};font-size:13px">No views this week.</td></tr>`}</table>

    <h3 style="margin:22px 6px 6px;font-size:16px">Outside sites that sent visitors</h3>
    ${referrers.length
      ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:0 6px">${listRows(referrers)}</table>`
      : `<p style="margin:0 6px;color:${MUTED};font-size:13px">None this week: everyone came straight in (a bookmark, a typed address, or a link in a text or app).</p>`}

    <h3 style="margin:22px 6px 6px;font-size:16px">Who's looking</h3>
    <p style="margin:0 6px;font-size:14px;line-height:1.6">${devices ? `<b>Devices:</b> ${esc(devices)}<br>` : ''}${states ? `<b>Top states</b> (share of US views): ${esc(states)}` : ''}${!devices && !states ? `<span style="color:${MUTED}">Not enough data this week.</span>` : ''}</p>

    <div style="margin-top:22px;text-align:center">
      <a href="${DASHBOARD}" style="display:inline-block;background:${ORANGE};color:#fff;text-decoration:none;font-weight:bold;padding:11px 18px;border-radius:999px">Open the stats page</a>
    </div>
  </div>
  <p style="font-size:11px;color:${MUTED};text-align:center;margin:14px 0 0">Sent every Monday morning. The same counts as offthewall.dev/stats/ (GoatCounter: no cookies, nothing about any one visitor). The last 7 days run through this morning, ${esc(data.timezone)} time.</p>
</div></body></html>`;

const text = `Off the Wall stats, ${short(first)} – ${short(last)}\n\nViews: ${total}${change == null ? '' : ` (${change >= 0 ? '+' : ''}${change}% vs the week before)`}\n`
  + days.map((d) => `${dayName(d.day, { weekday: 'short' })} ${short(d.day)}: ${d.views}`).join('\n')
  + `\n\nTop pages: ${pages.map((p) => `${p.name} ${p.count}`).join(', ') || '—'}`
  + `\nOutside sites: ${referrers.map((r) => `${r.name} ${r.count}`).join(', ') || 'none'}`
  + (devices ? `\nDevices: ${devices}` : '') + (states ? `\nTop states: ${states}` : '')
  + `\n\nStats page: ${DASHBOARD}`;

if (DRY) {
  writeFileSync(new URL('data/site-report.html', import.meta.url), html);
  console.log(`[dry run] ${subject}\nWrote data/site-report.html`);
} else {
  if (!TO) { console.error('No report address: set siteReportTo (or trafficReportTo) in league.config.json, or pass --to.'); process.exit(1); }
  await mailer().sendMail({ from: FROM(), to: TO, subject, html, text });
  console.log(`Sent to ${TO}: ${subject}`);
}
