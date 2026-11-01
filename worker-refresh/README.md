# Refresh now: the Worker

The **Refresh now** button on Fantasy Feetpics and Fantasy Football asks this Cloudflare Worker to start a refresh.

- `POST /refresh` starts the Build and deploy workflow with `source: button`. That run fetches, rebuilds and publishes both sites, and sends **no ice emails**. Any ice that locks in during that run is emailed at the next scheduled run.
- It refuses if a refresh is running, or if the last one (of any kind) started under 10 minutes ago. It answers `{ ok: false, retryInSec, lastUpdated }`.
- `GET /status` returns `{ running, lastUpdated, retryInSec }`.
- Only https://offthewall.dev, https://billywall732.github.io and localhost can call it. Nothing about visitors is logged.

## Set it up (once)

1. **GitHub token.**
   - Go to GitHub → your picture → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
   - Name it `feetpics-refresh-button` and set an expiration (a year is fine).
   - **Repository access:** Only select repositories → `fantasy-feetpics`.
   - **Permissions → Repository permissions → Actions: Read and write.** Leave everything else at No access.
   - Generate it and copy the token. You'll paste it once in step 3.
2. **Cloudflare.** In this folder:
   ```
   npx wrangler login
   ```
   This makes a free Cloudflare account if you don't have one, and signs you in.
3. **The secret.** Still in this folder:
   ```
   npx wrangler secret put GITHUB_TOKEN
   ```
   Paste the token when it asks. It's stored encrypted with the Worker and isn't written to any file.
4. **Deploy:**
   ```
   npx wrangler deploy
   ```
   It prints the Worker's address, like `https://league-refresh.<your-subdomain>.workers.dev`.
5. **Switch the button on.** Put that address in `league.config.json`, both in `"refreshUrl"` (the league site) and in `public` → `"refreshUrl"` (Fantasy Football), then commit and push. The button appears after the next refresh.

   The Worker's name stays neutral (`league-refresh`) because its address appears on the public site, and the public build refuses to publish anything that says "Feetpics".

**When the token expires,** make a new one (step 1) and run step 3 again.

**To turn the button off,** set `refreshUrl` back to `""` and push.
