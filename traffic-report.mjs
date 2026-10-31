// Weekly site-traffic email from GoatCounter: visits by day and by hour (Eastern time), top tabs and referrers.
//
// Usage:
//   node traffic-report.mjs              email the last 7 full days (Wed..Tue) to the report address
//   node traffic-report.mjs --dry-run    write the email to data/traffic-report.html instead of sending
//   node traffic-report.mjs --to x@y.com send to a different address
//
// Needs GOATCOUNTER_TOKEN (GoatCounter → Settings → API, "Read statistics") plus GMAIL_USER / GMAIL_APP_PASSWORD.
import { readFileSync, writeFileSync } from 'node:fs';
import nodemailer from 'nodemailer';
import { env } from './env.mjs';

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const config = JSON.parse(readFileSync(new URL('league.config.json', import.meta.url), 'utf8'));
const TO = args.includes('--to') ? args[args.indexOf('--to') + 1] : config.trafficReportTo;
const SITE = 'fantasy';
const API = `https://${SITE}.goatcounter.com/api/v0`;
const ET = 'America/New_York';
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

if (!env.GOATCOUNTER_TOKEN) { console.error('GOATCOUNTER_TOKEN is not set.'); process.exit(1); }

// ---------- Date range: the 7 full Eastern days before today (run on Wednesday → Wed..Tue) ----------
const etParts = (ms) => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: ET, year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', hourCycle: 'h23', weekday: 'short' })
  .formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
const etKey = (ms) => { const p = etParts(ms); return `${p.year}-${p.month}-${p.day}`; };
const today = etKey(Date.now());
const dayKeys = [];
for (let i = 7; i >= 1; i--) dayKeys.push(etKey(Date.parse(today + 'T12:00:00Z') - i * 86400e3));
const prevKeys = [];
for (let i = 14; i >= 8; i--) prevKeys.push(etKey(Date.parse(today + 'T12:00:00Z') - i * 86400e3));

// Ask for a window a day wider than both Eastern weeks, to cover the time-zone shift.
const utcDay = (key, offset) => new Date(Date.parse(key + 'T00:00:00Z') + offset * 86400e3).toISOString().slice(0, 10);
async function api(path, params) {
  const url = `${API}${path}?${new URLSearchParams(params)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${env.GOATCOUNTER_TOKEN}`, 'Content-Type': 'application/json' } });
  if (!res.ok) throw new Error(`GoatCounter ${res.status} for ${path}: ${await res.text()}`);
  return res.json();
}
const span = { start: utcDay(prevKeys[0], -1), end: utcDay(dayKeys.at(-1), 1) };

// ---------- Visits by Eastern day and hour ----------
// GoatCounter reports days and hours in the account's own time zone (e.g. "US.America/Los_Angeles").
const me = await api('/me', {});
const GC_TZ = String(me.user?.settings?.timezone || 'UTC').split('.').pop();
const tzOffset = (ms, tz) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' })
    .formatToParts(new Date(ms)).map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - ms;
};
// Wall-clock time in the account's zone -> real instant.
const fromZone = (day, hour) => { const guess = Date.parse(`${day}T${String(hour).padStart(2, '0')}:00:00Z`); return guess - tzOffset(guess, GC_TZ); };
const total = await api('/stats/total', span);
const grid = {}; // 'YYYY-MM-DD' (ET) -> [24]
for (const d of total.stats || []) {
  (d.hourly || []).forEach((n, h) => {
    if (!n) return;
    const ms = fromZone(d.day, h);
    const p = etParts(ms);
    const key = `${p.year}-${p.month}-${p.day}`;
    (grid[key] ??= Array(24).fill(0))[Number(p.hour)] += n;
  });
}
const row = (k) => grid[k] || Array(24).fill(0);
const sum = (a) => a.reduce((x, y) => x + y, 0);
const daily = dayKeys.map((k) => ({ key: k, label: DAYS[new Date(k + 'T12:00:00Z').getUTCDay()], date: new Date(k + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }), hours: row(k), total: sum(row(k)) }));
const weekTotal = sum(daily.map((d) => d.total));
const prevTotal = sum(prevKeys.map((k) => sum(row(k))));
const byHour = Array.from({ length: 24 }, (_, h) => sum(daily.map((d) => d.hours[h])));
const busiestDay = [...daily].sort((a, b) => b.total - a.total)[0];
const busiestHour = byHour.indexOf(Math.max(...byHour));

// ---------- Top tabs and referrers ----------
const range = { start: utcDay(dayKeys[0], 0), end: utcDay(dayKeys.at(-1), 1) };
const hits = await api('/stats/hits', { ...range, limit: 12 }).catch(() => ({ hits: [] }));
const refs = await api('/stats/toprefs', { ...range, limit: 8 }).catch(() => ({ stats: [] }));
const pages = (hits.hits || []).map((h) => ({ name: h.title || h.path, path: h.path, count: h.count })).filter((p) => p.count > 0);
const referrers = (refs.stats || []).map((r) => ({ name: r.name || '(direct / unknown)', count: r.count })).filter((r) => r.count > 0);

// ---------- Email ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const hourLabel = (h) => `${((h + 11) % 12) + 1}${h < 12 ? 'a' : 'p'}`;
const change = prevTotal ? Math.round(((weekTotal - prevTotal) / prevTotal) * 100) : null;
const maxDay = Math.max(1, ...daily.map((d) => d.total));
const maxCell = Math.max(1, ...daily.flatMap((d) => d.hours));
const cell = (n) => {
  if (!n) return '<td style="background:#f1f5f2;border:1px solid #fff;height:16px"></td>';
  const a = 0.18 + 0.82 * (n / maxCell);
  return `<td title="${n}" style="background:rgba(13,138,72,${a.toFixed(2)});border:1px solid #fff;height:16px;text-align:center;font-size:9px;color:${a > 0.6 ? '#fff' : '#0c1810'}">${n}</td>`;
};
const tile = (label, value, sub) => `<td style="padding:6px" width="25%"><div style="background:#f4f8f5;border-radius:10px;padding:12px 10px">
  <div style="font-size:10px;letter-spacing:1.5px;color:#5a685f;font-weight:bold;text-transform:uppercase">${label}</div>
  <div style="font-size:26px;font-weight:900;color:#0c1810;line-height:1.2">${value}</div><div style="font-size:12px;color:#5a685f">${sub}</div></div></td>`;
const listRows = (items) => items.length ? items.map((it) => `<tr><td style="padding:6px 0;border-bottom:1px solid #edf2ee;font-size:14px">${esc(it.name)}</td><td style="padding:6px 0;border-bottom:1px solid #edf2ee;font-size:14px;text-align:right;font-weight:bold">${it.count}</td></tr>`).join('') : '<tr><td style="color:#5a685f;font-size:13px">No data this week.</td></tr>';
const first = daily[0], last = daily.at(-1);
const subject = `📊 Fantasy Feetpics traffic: ${weekTotal} visits (${first.date}–${last.date})`;

const html = `<!doctype html><html><body style="margin:0;padding:0;background:#eef3ee;font-family:Arial,Helvetica,sans-serif;color:#0c1810">
<div style="max-width:620px;margin:0 auto;padding:16px">
  <div style="background:#04110b;color:#f2f8f3;border-radius:12px 12px 0 0;padding:18px 20px">
    <div style="font-size:12px;letter-spacing:2px;color:#a9c2b1;font-weight:bold">FANTASY FEETPICS · WEEKLY TRAFFIC</div>
    <div style="font-size:24px;font-weight:900;margin-top:4px">${first.label} ${first.date} – ${last.label} ${last.date}</div>
  </div>
  <div style="background:#ffffff;border-radius:0 0 12px 12px;padding:16px 14px">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>
      ${tile('Visits', weekTotal, change == null ? 'first week tracked' : `${change >= 0 ? '▲' : '▼'} ${Math.abs(change)}% vs last week`)}
      ${tile('Daily avg', (weekTotal / 7).toFixed(1), 'visits per day')}
      ${tile('Busiest day', weekTotal ? busiestDay.label : '—', weekTotal ? `${busiestDay.total} visits` : '')}
      ${tile('Peak hour', weekTotal ? hourLabel(busiestHour) : '—', weekTotal ? `${byHour[busiestHour]} visits (ET)` : '')}
    </tr></table>

    <h3 style="margin:18px 6px 8px;font-size:16px">Visits by day</h3>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="padding:0 6px">
      ${daily.map((d) => `<tr><td style="font-size:13px;padding:4px 8px 4px 0;white-space:nowrap;width:78px">${d.label} ${d.date}</td>
        <td style="padding:4px 0"><div style="background:#0d8a48;height:16px;border-radius:4px;width:${Math.max(2, Math.round((d.total / maxDay) * 100))}%"></div></td>
        <td style="font-size:13px;font-weight:bold;text-align:right;width:40px;padding-left:8px">${d.total}</td></tr>`).join('')}
    </table>

    <h3 style="margin:20px 6px 4px;font-size:16px">Visits by day and hour <span style="font-weight:normal;color:#5a685f;font-size:12px">(Eastern time; darker = busier)</span></h3>
    <table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;table-layout:fixed;border-collapse:collapse;margin:0 0 4px">
      <tr><td style="width:52px"></td>${daily.map((d) => `<td style="font-size:11px;font-weight:bold;text-align:center;color:#3a493f;padding-bottom:3px">${d.label}</td>`).join('')}<td style="width:36px;font-size:11px;color:#5a685f;text-align:right">Total</td></tr>
      ${Array.from({ length: 24 }, (_, h) => `<tr><td style="font-size:10px;color:#5a685f;text-align:right;padding-right:6px">${hourLabel(h)}</td>${daily.map((d) => cell(d.hours[h])).join('')}<td style="font-size:10px;text-align:right;color:#3a493f">${byHour[h] || ''}</td></tr>`).join('')}
    </table>

    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:18px"><tr>
      <td valign="top" width="50%" style="padding:0 8px 0 6px"><h3 style="margin:0 0 6px;font-size:16px">Most viewed tabs</h3><table width="100%" cellspacing="0" cellpadding="0">${listRows(pages)}</table></td>
      <td valign="top" width="50%" style="padding:0 6px 0 8px"><h3 style="margin:0 0 6px;font-size:16px">Where visitors came from</h3><table width="100%" cellspacing="0" cellpadding="0">${listRows(referrers)}</table></td>
    </tr></table>

    <div style="margin-top:20px;text-align:center">
      <a href="https://${SITE}.goatcounter.com" style="display:inline-block;background:#0d8a48;color:#fff;text-decoration:none;font-weight:bold;padding:11px 18px;border-radius:999px">Open the full dashboard</a>
    </div>
  </div>
  <p style="font-size:11px;color:#5a685f;text-align:center;margin:14px 0 0">Sent every Wednesday by the Fantasy Feetpics site. Counts come from GoatCounter (no cookies, no personal data).</p>
</div></body></html>`;

const text = `Fantasy Feetpics traffic, ${first.date} – ${last.date}\n\nVisits: ${weekTotal}${change == null ? '' : ` (${change >= 0 ? '+' : ''}${change}% vs last week)`}\n`
  + daily.map((d) => `${d.label} ${d.date}: ${d.total}`).join('\n')
  + `\n\nPeak hour: ${weekTotal ? hourLabel(busiestHour) + ' ET' : '—'}\nTop tabs: ${pages.map((p) => `${p.name} (${p.count})`).join(', ') || '—'}\n\nDashboard: https://${SITE}.goatcounter.com`;

if (DRY) {
  writeFileSync(new URL('data/traffic-report.html', import.meta.url), html);
  console.log(`[dry run] ${subject}\nWrote data/traffic-report.html`);
} else {
  if (!TO) { console.error('No report address: set trafficReportTo in league.config.json or pass --to.'); process.exit(1); }
  const mail = nodemailer.createTransport({ service: 'gmail', auth: { user: env.GMAIL_USER, pass: env.GMAIL_APP_PASSWORD.replace(/\s+/g, '') } });
  await mail.sendMail({ from: `"Feetpics Site Stats" <${env.GMAIL_USER}>`, to: TO, subject, html, text });
  console.log(`Sent to ${TO}: ${subject}`);
}
