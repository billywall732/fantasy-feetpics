// Emails each manager when an ice is locked in for them: the picture, the reason and the deadline.
//
// Usage:
//   node notify.mjs                     send new ices (only when NOTIFY_ENABLED=true; otherwise a dry run)
//   node notify.mjs --dry-run           show what would be sent
//   node notify.mjs --test you@x.com    send one sample of each kind (made-up data) to one address
//   --state <file>                      ids already sent (refresh.sh passes the copy from gh-pages)
//
// Reads data/ice-events.json (written by build.mjs) and writes site/notified.json, which is published
// with the site so the next refresh knows what has already gone out.
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import nodemailer from 'nodemailer';
import { env } from './env.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const DRY = flag('--dry-run');
const TEST_TO = value('--test');
const STATE = value('--state');
const SITE_URL = 'https://billywall732.github.io/fantasy-feetpics/';
const here = (p) => new URL(p, import.meta.url);

// ---------- Pictures: a random one from notify-images/<kind>/ ----------
function pickImage(kind) {
  const dir = here(`notify-images/${kind}/`);
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => /\.(jpe?g|png|gif|webp)$/i.test(f));
  if (!files.length) return null;
  const file = files[Math.floor(Math.random() * files.length)];
  return { filename: file, path: new URL(file, dir).pathname.replace(/^\/([A-Za-z]:)/, '$1'), cid: 'ice-picture' };
}

// ---------- Message ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtPts = (n) => Number(n).toFixed(2);
function compose(ev) {
  const first = ev.owner.split(' ')[0] || ev.owner;
  const count = ev.ices > 1 ? `${ev.ices} ices` : 'an ice';
  const reason = ev.kind === 'lowest'
    ? `You had the lowest score in the league in week ${ev.week}: ${fmtPts(ev.score)} points.`
    : `${ev.player}${ev.pos ? ` (${ev.pos}${ev.pro ? `, ${ev.pro}` : ''})` : ''} scored ${fmtPts(ev.pts)} in your starting lineup in week ${ev.week}.`;
  const subject = ev.kind === 'lowest'
    ? `🧊 You owe ${count}: lowest score of week ${ev.week} (${fmtPts(ev.score)})`
    : `🧊 You owe ${count}: ${ev.player} scored ${fmtPts(ev.pts)}`;
  const image = pickImage(ev.kind);
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#eef3ee;font-family:Arial,Helvetica,sans-serif;color:#0c1810">
  <div style="max-width:520px;margin:0 auto;padding:16px">
    <div style="background:#04110b;color:#f2f8f3;border-radius:12px 12px 0 0;padding:16px 20px">
      <div style="font-size:12px;letter-spacing:2px;color:#a9c2b1;font-weight:bold">FANTASY FEETPICS · WEEK ${ev.week}</div>
      <div style="font-size:26px;font-weight:900;margin-top:4px">🧊 ICE ALERT</div>
    </div>
    <div style="background:#ffffff;border-radius:0 0 12px 12px;padding:20px">
      ${image ? `<img src="cid:${image.cid}" alt="" style="display:block;width:100%;max-width:480px;height:auto;border-radius:10px;margin:0 auto 18px">` : ''}
      <p style="font-size:18px;margin:0 0 10px"><b>${esc(first)}, you owe ${count}.</b></p>
      <p style="font-size:16px;line-height:1.5;margin:0 0 14px">${esc(reason)}</p>
      <p style="font-size:14px;color:#3a493f;margin:0 0 16px">Team: ${esc(ev.team)}${ev.playoff ? ' · Playoffs: ices count double' : ''}</p>
      <div style="background:#e8f4ff;border-left:4px solid #1b7fe8;border-radius:8px;padding:12px 14px;font-size:16px;margin:0 0 18px">
        ⏰ <b>Due ${esc(ev.deadlineText)}</b>
      </div>
      <a href="${SITE_URL}#ice" style="display:inline-block;background:#0d8a48;color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 18px;border-radius:999px">See the ice tracker</a>
    </div>
    <p style="font-size:11px;color:#5a685f;text-align:center;margin:14px 0 0">Sent automatically by the Fantasy Feetpics site.</p>
  </div></body></html>`;
  const text = `${first}, you owe ${count}.\n\n${reason}\nTeam: ${ev.team}${ev.playoff ? ' (playoffs: ices count double)' : ''}\n\nDue ${ev.deadlineText}.\n\nIce tracker: ${SITE_URL}#ice`;
  return { subject, html, text, attachments: image ? [image] : [] };
}

// ---------- Sending ----------
let transport = null;
function mailer() {
  if (!env.GMAIL_USER || !env.GMAIL_APP_PASSWORD) throw new Error('GMAIL_USER and GMAIL_APP_PASSWORD are not set.');
  transport ??= nodemailer.createTransport({ service: 'gmail', auth: { user: env.GMAIL_USER, pass: env.GMAIL_APP_PASSWORD.replace(/\s+/g, '') } });
  return transport;
}
async function send(to, ev) {
  const m = compose(ev);
  await mailer().sendMail({ from: `"Feetpics Ice Bot" <${env.GMAIL_USER}>`, to, subject: m.subject, html: m.html, text: m.text, attachments: m.attachments });
  return m.subject;
}

// ---------- Test mode: one made-up sample of each kind ----------
if (TEST_TO) {
  const deadline = Date.now() + 3 * 86400e3;
  const deadlineText = new Date(deadline).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'long', month: 'short', day: 'numeric' }) + ', 8:00 PM ET';
  const base = { season: 2026, week: 99, owner: 'Test Manager', team: 'Test Team (sample)', deadline, deadlineText, ices: 1, playoff: false };
  const samples = [
    { ...base, id: 'test-dud', kind: 'dud', player: 'Sample Player', pos: 'WR', pro: 'NYJ', pts: 0 },
    { ...base, id: 'test-lowest', kind: 'lowest', score: 64.2 },
  ];
  for (const ev of samples) {
    const subject = await send(TEST_TO, ev);
    console.log(`Sent test to ${TEST_TO}: ${subject}${compose(ev).attachments.length ? '' : ' (no picture: add one to notify-images/' + ev.kind + '/)'}`);
  }
  process.exit(0);
}

// ---------- Real run ----------
const events = existsSync(here('data/ice-events.json')) ? JSON.parse(readFileSync(here('data/ice-events.json'), 'utf8')) : [];
const sent = new Set(STATE && existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8') || '[]') : []);
const emails = Object.fromEntries(Object.entries(JSON.parse(env.ICE_EMAILS || '{}')).map(([k, v]) => [k.toLowerCase(), v]));
const enabled = env.NOTIFY_ENABLED === 'true' && !DRY;
const pending = events.filter((ev) => !sent.has(ev.id));
if (!pending.length) console.log('Ice notifications: nothing new.');
let failures = 0;
for (const ev of pending) {
  const to = emails[ev.owner.toLowerCase()];
  if (!to) { console.warn(`::warning::No email for ${ev.owner}; skipped ${ev.id}`); continue; }
  if (!enabled) { console.log(`[dry run] would email ${ev.owner}: ${compose(ev).subject}`); continue; }
  try {
    const subject = await send(to, ev);
    sent.add(ev.id);
    console.log(`Sent to ${ev.owner}: ${subject}`);
  } catch (e) {
    failures++;
    console.warn(`::warning::Could not email ${ev.owner} (${ev.id}): ${e.message}. Will retry next refresh.`);
  }
}
if (existsSync(here('site/'))) writeFileSync(here('site/notified.json'), JSON.stringify([...sent]));
if (failures) process.exitCode = 1;
