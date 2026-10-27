// Settings come from environment variables (GitHub Actions secrets) or, locally, from .env.
import { readFileSync, existsSync } from 'node:fs';

const file = new URL('.env', import.meta.url);
const fromFile = existsSync(file)
  ? Object.fromEntries(
      readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .filter((l) => l.includes('='))
        .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
    )
  : {};

const KEYS = ['ESPN_S2', 'ESPN_SWID', 'LEAGUE_ID', 'SEASON', 'ICE_SHEET_ID', 'ICE_SHEET_TAB', 'GMAIL_USER', 'GMAIL_APP_PASSWORD', 'ICE_EMAILS', 'NOTIFY_ENABLED', 'NOTIFY_BCC'];
export const env = Object.fromEntries(KEYS.map((k) => [k, process.env[k] || fromFile[k]]));

const missing = ['ESPN_S2', 'ESPN_SWID', 'LEAGUE_ID', 'SEASON'].filter((k) => !env[k]);
if (missing.length) {
  console.error(`Missing settings: ${missing.join(', ')}. Add them to .env or set them as environment variables.`);
  process.exit(1);
}
