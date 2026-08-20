# GitHub PR → DevHelm Incident — Cloudflare Worker

Automatically creates a DevHelm incident when a PR is opened to `main`
or labeled `incident`, `hotfix`, or `maintenance`. Syncs PR comments to
the incident timeline and auto-resolves when the PR is closed/merged.

---

## Prerequisites

- Node.js 18+
- Cloudflare account (free tier is fine)
- DevHelm Team account with an API key
- GitHub org admin access (to create the webhook)

---

## Step 1 — Install Wrangler

```bash
npm install -g wrangler
wrangler login
```

---

## Step 2 — Create the KV Namespace

```bash
wrangler kv:namespace create DEVHELM_KV
```

Copy the `id` from the output and paste it into `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "DEVHELM_KV"
id = "paste-your-id-here"
```

---

## Step 3 — Set Secrets

```bash
# GitHub webhook secret (you'll create this in Step 5)
wrangler secret put GITHUB_WEBHOOK_SECRET

# DevHelm API token — from app.devhelm.io → Settings → API Keys
wrangler secret put DEVHELM_API_TOKEN

# GitHub personal access token — needs repo scope (to post PR comments)
# Generate at: github.com → Settings → Developer settings → PAT
wrangler secret put GITHUB_TOKEN

# DevHelm org ID — visible in app.devhelm.io URL or API key settings
wrangler secret put DEVHELM_ORG_ID
```

---

## Step 4 — Deploy the Worker

```bash
wrangler deploy
```

Note the deployed URL — it will look like:
`https://github-devhelm-webhook.<your-subdomain>.workers.dev`

---

## Step 5 — Create GitHub Labels

In your org repo, create these three labels (exact names, lowercase):

| Label | Suggested colour |
|---|---|
| `incident` | `#d73a4a` (red) |
| `hotfix` | `#e4e669` (yellow) |
| `maintenance` | `#0075ca` (blue) |

Via GitHub CLI:
```bash
gh label create incident  --color d73a4a --description "Triggers DevHelm incident"
gh label create hotfix    --color e4e669 --description "Triggers DevHelm incident"
gh label create maintenance --color 0075ca --description "Triggers DevHelm incident"
```

---

## Step 6 — Register the GitHub Org Webhook

1. Go to **GitHub Org → Settings → Webhooks → Add webhook**
2. Set:
   - **Payload URL:** your Worker URL from Step 4
   - **Content type:** `application/json`
   - **Secret:** a random string (e.g. `openssl rand -hex 32`) — this goes into `GITHUB_WEBHOOK_SECRET`
   - **Events:** select **"Let me select individual events"**, then tick:
     - ✅ Pull requests
     - ✅ Issue comments
3. Save.

---

## How It Works

```
PR opened to main  ─┐
                    ├──► Worker ──► DevHelm incident created
PR labeled          ─┘           ──► PR comment: incident link posted

PR comment added   ──────────────► Incident timeline updated (no DevHelm login needed)

PR closed/merged   ──────────────► Incident auto-resolved + PR comment posted
```

### KV deduplication

The worker stores `pr:{owner}:{repo}:{number}` → `{ incidentId, incidentUrl }`
in Cloudflare KV. If a PR is both opened to `main` AND labeled, only one
incident is created (second trigger is a no-op).

---

## Environment Variables Reference

| Secret | Required | Description |
|---|---|---|
| `GITHUB_WEBHOOK_SECRET` | ✅ | HMAC-SHA256 key for verifying GitHub payloads |
| `DEVHELM_API_TOKEN` | ✅ | `dh_live_...` token from DevHelm Settings |
| `GITHUB_TOKEN` | ✅ | GitHub PAT with `repo` scope |
| `DEVHELM_ORG_ID` | ✅ | Your DevHelm org ID |

---

## Troubleshooting

**Webhook returns 401:** The `GITHUB_WEBHOOK_SECRET` doesn't match what
you set in GitHub. Re-check both ends.

**Incident created but no PR comment:** Check your `GITHUB_TOKEN` has
`repo` scope and isn't expired.

**Timeline updates not appearing:** DevHelm's `/incidents/{id}/updates`
endpoint may use a slightly different field name. Check the Worker logs
(`wrangler tail`) to see the exact error and adjust the payload in
`devhelmAddTimelineUpdate()`.

**Viewing logs:**
```bash
wrangler tail
```