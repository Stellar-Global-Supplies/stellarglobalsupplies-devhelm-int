/**
 * Cloudflare Worker: GitHub PR → DevHelm Incident + Status Page Integration
 *
 * Triggers:
 *   - PR opened targeting `main`
 *   - PR labeled with `incident`, `hotfix`, or `maintenance`
 *
 * On trigger:
 *   - Creates a DevHelm internal incident (team dashboard)
 *   - ALSO posts to your public status page:
 *       incident / hotfix  → status page incident  (POST /status-pages/{slug}/incidents)
 *       maintenance        → status page maintenance window (POST /status-pages/{slug}/maintenance-windows)
 *   - Posts PR comment with both links
 *   - Syncs PR comments → internal incident timeline
 *   - Auto-resolves both internal incident + status page entry when PR closes/merges
 *
 * KV key schema:
 *   pr:{owner}:{repo}:{pr_number} → { incidentId, statusPageEntryId, statusPageEntryType, incidentUrl, statusPageUrl, createdAt }
 */

const TRIGGER_LABELS   = new Set(["incident", "hotfix", "maintenance"]);
const TRIGGER_BASE     = "main";
const DEVHELM_API      = "https://api.devhelm.io/api/v1";
const GITHUB_API       = "https://api.github.com";

// ─── Entry point ──────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    if (request.method !== "POST")
      return new Response("Method Not Allowed", { status: 405 });

    const rawBody = await request.text();
    const sig     = request.headers.get("x-hub-signature-256") || "";

    if (!(await verifyGitHubSignature(rawBody, sig, await env.GITHUB_WEBHOOK_SECRET.get())))
      return new Response("Unauthorized: invalid signature", { status: 401 });

    const event = request.headers.get("x-github-event");
    let payload;
    try { payload = JSON.parse(rawBody); }
    catch { return new Response("Bad Request: invalid JSON", { status: 400 }); }

    if (event === "pull_request") return handlePullRequest(payload, env);
    if (event === "issue_comment") return handleIssueComment(payload, env);

    return new Response("OK: event ignored", { status: 200 });
  },
};

// ─── Pull request handler ─────────────────────────────────────────────────────

async function handlePullRequest(payload, env) {
  const { action, pull_request: pr, label, repository } = payload;
  const owner    = repository.owner.login;
  const repo     = repository.name;
  const prNumber = pr.number;
  const kvKey    = `pr:${owner}:${repo}:${prNumber}`;

  // ── Resolve when PR closes / merges ───────────────────────────────────────
  if (action === "closed") {
    const stored = await env.DEVHELM_KV.get(kvKey, { type: "json" });
    if (!stored) return new Response("OK: no tracked incident", { status: 200 });

    const reason = pr.merged
      ? `PR #${prNumber} was merged by @${pr.merged_by?.login || "unknown"}.`
      : `PR #${prNumber} was closed without merging.`;

    await Promise.all([
      devhelmResolveIncident(stored.incidentId, reason, env),
      resolveStatusPageEntry(stored, reason, env),
    ]);

    await env.DEVHELM_KV.delete(kvKey);

    await postGitHubComment(owner, repo, prNumber,
      `✅ **DevHelm incident resolved**\n\n` +
      `- Internal incident [${stored.incidentId}](${stored.incidentUrl}) → resolved\n` +
      `- Status page entry → resolved\n\n` +
      `Reason: ${reason}`,
      env
    );
    return new Response("OK: resolved", { status: 200 });
  }

  // ── Check trigger conditions ───────────────────────────────────────────────
  const isOpenedToMain = (action === "opened" || action === "reopened") &&
                          pr.base.ref === TRIGGER_BASE;
  const isLabelTrigger  = action === "labeled" && TRIGGER_LABELS.has(label?.name?.toLowerCase());

  if (!isOpenedToMain && !isLabelTrigger)
    return new Response("OK: no trigger condition matched", { status: 200 });

  // ── Deduplication ─────────────────────────────────────────────────────────
  const existing = await env.DEVHELM_KV.get(kvKey, { type: "json" });
  if (existing) return new Response("OK: already tracked", { status: 200 });

  // ── Determine trigger label ───────────────────────────────────────────────
  const allLabels    = pr.labels || [];
  const triggerLabel = isLabelTrigger
    ? label.name.toLowerCase()
    : (allLabels.find(l => TRIGGER_LABELS.has(l.name.toLowerCase()))?.name?.toLowerCase() || "incident");

  const isMaintenance = triggerLabel === "maintenance";
  const incidentType  = labelToType(triggerLabel);

  // ── Build shared content ──────────────────────────────────────────────────
  const title       = `[${incidentType}] PR #${pr.number}: ${pr.title}`;
  const description = buildDescription(pr, repository, triggerLabel);

  // ── Fire both DevHelm calls in parallel ──────────────────────────────────
  let internalIncident, statusPageEntry;
  try {
    [internalIncident, statusPageEntry] = await Promise.all([
      devhelmCreateIncident(title, description, env),
      isMaintenance
        ? devhelmCreateMaintenanceWindow(title, description, pr, env)
        : devhelmCreateStatusPageIncident(title, description, triggerLabel, env),
    ]);
  } catch (err) {
    console.error("DevHelm API error:", err);
    return new Response(`Error: ${err.message}`, { status: 500 });
  }

  const incidentUrl    = `https://app.devhelm.io/incidents/${internalIncident.id}`;
  const statusPageUrl  = await buildStatusPageUrl(statusPageEntry, isMaintenance, env);
  const entryType      = isMaintenance ? "maintenance" : "incident";

  // ── Store mapping ─────────────────────────────────────────────────────────
  await env.DEVHELM_KV.put(kvKey, JSON.stringify({
    incidentId:          internalIncident.id,
    statusPageEntryId:   statusPageEntry.id,
    statusPageEntryType: entryType,
    incidentUrl,
    statusPageUrl,
    prNumber,
    repo: `${owner}/${repo}`,
    createdAt: new Date().toISOString(),
  }), { expirationTtl: 60 * 60 * 24 * 30 });

  // ── Post PR comment ───────────────────────────────────────────────────────
  const labelBadge    = `\`${triggerLabel}\``;
  const spEntryLabel  = isMaintenance ? "Maintenance window" : "Status page incident";

  await postGitHubComment(owner, repo, prNumber,
    `🚨 **DevHelm incident automatically created**\n\n` +
    `| | |\n` +
    `|---|---|\n` +
    `| **Type** | ${labelBadge} |\n` +
    `| **Title** | ${title} |\n` +
    `| **Internal incident** | [View in DevHelm](${incidentUrl}) |\n` +
    `| **${spEntryLabel}** | [View on status page](${statusPageUrl}) |\n\n` +
    `> 💬 PR comments are synced to the incident timeline.\n` +
    `> ✅ Both entries resolve automatically when this PR is closed or merged.`,
    env
  );

  return new Response(JSON.stringify({ incidentId: internalIncident.id, statusPageEntryId: statusPageEntry.id }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
}

// ─── Issue comment handler ────────────────────────────────────────────────────

async function handleIssueComment(payload, env) {
  const { action, issue, comment, repository } = payload;
  if (action !== "created" || !issue.pull_request) return new Response("OK", { status: 200 });
  if (comment.user?.type === "Bot") return new Response("OK: bot ignored", { status: 200 });

  const owner    = repository.owner.login;
  const repo     = repository.name;
  const prNumber = issue.number;
  const stored   = await env.DEVHELM_KV.get(`pr:${owner}:${repo}:${prNumber}`, { type: "json" });
  if (!stored) return new Response("OK: not tracked", { status: 200 });

  const update = `**@${comment.user.login}** on [PR #${prNumber}](${issue.html_url}):\n\n${comment.body}`;
  try { await devhelmAddTimelineUpdate(stored.incidentId, update, env); }
  catch (err) { console.error("Timeline update failed:", err); }

  return new Response("OK: timeline updated", { status: 200 });
}

// ─── DevHelm internal incident API ───────────────────────────────────────────

async function devhelmCreateIncident(title, description, env) {
  const res = await fetch(`${DEVHELM_API}/incidents`, {
    method: "POST",
    headers: await devhelmHeaders(env),
    body: JSON.stringify({ title, description, status: "OPEN" }),
  });
  if (!res.ok) throw new Error(`Incident create ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return json.data ?? json;
}

async function devhelmResolveIncident(incidentId, reason, env) {
  const res = await fetch(`${DEVHELM_API}/incidents/${incidentId}`, {
    method: "PATCH",
    headers: await devhelmHeaders(env),
    body: JSON.stringify({ status: "RESOLVED", resolvedAt: new Date().toISOString(), resolvedNote: reason }),
  });
  if (!res.ok) console.error(`Resolve incident ${res.status}: ${await res.text()}`);
}

async function devhelmAddTimelineUpdate(incidentId, message, env) {
  const res = await fetch(`${DEVHELM_API}/incidents/${incidentId}/updates`, {
    method: "POST",
    headers: await devhelmHeaders(env),
    body: JSON.stringify({ message }),
  });
  if (!res.ok) throw new Error(`Timeline ${res.status}: ${await res.text()}`);
}

// ─── DevHelm status page API ──────────────────────────────────────────────────

async function devhelmCreateStatusPageIncident(title, description, triggerLabel, env) {
  const slug   = await env.DEVHELM_STATUS_PAGE_SLUG.get();
  const impact = triggerLabel === "hotfix" ? "major" : "minor";

  const res = await fetch(`${DEVHELM_API}/status-pages/${slug}/incidents`, {
    method: "POST",
    headers: await devhelmHeaders(env),
    body: JSON.stringify({
      title,
      impact,        // "minor" | "major" | "critical"
      body: description,
      status: "investigating",
      // components: ["component-id-here"],  // optional — add your component IDs
    }),
  });
  if (!res.ok) throw new Error(`Status page incident ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return json.data ?? json;
}

async function devhelmCreateMaintenanceWindow(title, description, pr, env) {
  const slug = await env.DEVHELM_STATUS_PAGE_SLUG.get();

  // Default: maintenance window starts now, ends in 2 hours.
  // You can customise by parsing dates out of the PR body if your team
  // follows a convention like "Start: 2026-08-21 02:00 UTC / End: 04:00 UTC"
  const startAt = new Date();
  const endAt   = new Date(startAt.getTime() + 2 * 60 * 60 * 1000);

  const res = await fetch(`${DEVHELM_API}/status-pages/${slug}/maintenance-windows`, {
    method: "POST",
    headers: await devhelmHeaders(env),
    body: JSON.stringify({
      title,
      body: description,
      scheduledFor:  startAt.toISOString(),
      scheduledUntil: endAt.toISOString(),
      // components: ["component-id-here"],  // optional
    }),
  });
  if (!res.ok) throw new Error(`Maintenance window ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return json.data ?? json;
}

async function resolveStatusPageEntry(stored, reason, env) {
  const slug = await env.DEVHELM_STATUS_PAGE_SLUG.get();
  const id   = stored.statusPageEntryId;
  if (!id) return;

  if (stored.statusPageEntryType === "maintenance") {
    // Close the maintenance window early
    const res = await fetch(`${DEVHELM_API}/status-pages/${slug}/maintenance-windows/${id}`, {
      method: "PATCH",
      headers: await devhelmHeaders(env),
      body: JSON.stringify({ status: "completed", body: reason }),
    });
    if (!res.ok) console.error(`Resolve maintenance ${res.status}: ${await res.text()}`);
  } else {
    // Resolve the status page incident
    const res = await fetch(`${DEVHELM_API}/status-pages/${slug}/incidents/${id}`, {
      method: "PATCH",
      headers: await devhelmHeaders(env),
      body: JSON.stringify({ status: "resolved", body: reason }),
    });
    if (!res.ok) console.error(`Resolve SP incident ${res.status}: ${await res.text()}`);
  }
}

// ─── GitHub API ───────────────────────────────────────────────────────────────

async function postGitHubComment(owner, repo, prNumber, body, env) {
  const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await env.GITHUB_TOKEN.get()}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "devhelm-gh-webhook/1.0",
    },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) console.error(`GitHub comment ${res.status}: ${await res.text()}`);
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

async function devhelmHeaders(env) {
  const [apiToken, orgId, workspaceId] = await Promise.all([
    env.DEVHELM_API_TOKEN.get(),
    env.DEVHELM_ORG_ID.get(),
    env.DEVHELM_WORKSPACE_ID.get(),
  ]);
  const h = {
    "Authorization":    `Bearer ${apiToken}`,
    "Content-Type":     "application/json",
    "x-phelm-org-id":  orgId || "",
  };
  if (workspaceId) h["x-phelm-workspace-id"] = workspaceId;
  return h;
}

async function buildStatusPageUrl(entry, isMaintenance, env) {
  // Uses your custom domain (DEVHELM_STATUS_PAGE_URL) if set,
  // otherwise falls back to the DevHelm-hosted URL.
  const [statusPageUrl, statusPageSlug] = await Promise.all([
    env.DEVHELM_STATUS_PAGE_URL.get(),
    env.DEVHELM_STATUS_PAGE_SLUG.get(),
  ]);
  const base = (statusPageUrl || `https://app.devhelm.io/dashboard/status-pages/${statusPageSlug}`).replace(/\/$/, "");
  const path = isMaintenance ? "maintenance" : "incidents";
  return `${base}/${path}/${entry.id}`;
}

function labelToType(label) {
  switch (label) {
    case "hotfix":      return "Hotfix";
    case "maintenance": return "Maintenance";
    default:            return "Incident";
  }
}

function buildDescription(pr, repository, triggerLabel) {
  const labels = (pr.labels || []).map(l => `\`${l.name}\``).join(", ") || "none";
  return [
    `## Source`,
    `- **Repository:** ${repository.full_name}`,
    `- **PR:** [#${pr.number} — ${pr.title}](${pr.html_url})`,
    `- **Author:** @${pr.user.login}`,
    `- **Base branch:** \`${pr.base.ref}\``,
    `- **Trigger label:** \`${triggerLabel}\``,
    `- **All labels:** ${labels}`,
    ``,
    `## PR Description`,
    pr.body || "_No description provided._",
  ].join("\n");
}

// ─── GitHub HMAC-SHA256 signature verification ────────────────────────────────

async function verifyGitHubSignature(rawBody, sigHeader, secret) {
  if (!sigHeader.startsWith("sha256=")) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig  = await crypto.subtle.sign("HMAC", key, enc.encode(rawBody));
  const hex  = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
  const expected = `sha256=${hex}`;
  if (expected.length !== sigHeader.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sigHeader.charCodeAt(i);
  return diff === 0;
}