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
 *       incident / hotfix  → status page incident  (POST /status-pages/{id}/incidents)
 *       maintenance        → maintenance window (POST /maintenance-windows)
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
    console.error("DevHelm API error:", err.stack ?? err.message);
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
  // POST /api/v1/incidents — Required: title, severity. No status field.
  // Manual incidents immediately become CONFIRMED; severity drives alert routing.
  const res = await fetch(`${DEVHELM_API}/incidents`, {
    method: "POST",
    headers: await devhelmHeaders(env),
    body: JSON.stringify({ title, severity: "DOWN", body: description }),
  });
  if (!res.ok) throw new Error(`Incident create ${res.status}: ${await res.text()}`);
  const json = await res.json();
  // Response: { data: { incident, updates, statusPageIncidents, trigger } }
  return json.data?.incident ?? json.data ?? json;
}

async function devhelmResolveIncident(incidentId, reason, env) {
  // POST /api/v1/incidents/{id}/resolve — body field is the resolution note.
  // No status/resolvedAt/resolvedNote fields; endpoint handles the transition.
  const res = await fetch(`${DEVHELM_API}/incidents/${incidentId}/resolve`, {
    method: "POST",
    headers: await devhelmHeaders(env),
    body: JSON.stringify({ body: reason }),
  });
  if (!res.ok) console.error(`Resolve incident ${res.status}: ${await res.text()}`);
}

async function devhelmAddTimelineUpdate(incidentId, message, env) {
  // POST /api/v1/incidents/{id}/updates
  // Required: notifySubscribers (boolean). Optional: body (string), newStatus.
  // Field is "body" not "message".
  const res = await fetch(`${DEVHELM_API}/incidents/${incidentId}/updates`, {
    method: "POST",
    headers: await devhelmHeaders(env),
    body: JSON.stringify({ body: message, notifySubscribers: false }),
  });
  if (!res.ok) throw new Error(`Timeline ${res.status}: ${await res.text()}`);
}

// ─── DevHelm status page API ──────────────────────────────────────────────────

async function devhelmCreateStatusPageIncident(title, description, triggerLabel, env) {
  // POST /api/v1/status-pages/{id}/incidents — {id} is the status page UUID, not slug.
  // impact enum: NONE | MINOR | MAJOR | CRITICAL (uppercase)
  // status enum: INVESTIGATING | IDENTIFIED | MONITORING | RESOLVED (uppercase)
  // Required: title, impact, body.
  const statusPageId = await env.DEVHELM_STATUS_PAGE_ID.get();
  const impact = triggerLabel === "hotfix" ? "MAJOR" : "MINOR";

  const res = await fetch(`${DEVHELM_API}/status-pages/${statusPageId}/incidents`, {
    method: "POST",
    headers: await devhelmHeaders(env),
    body: JSON.stringify({
      title,
      impact,
      body: description,
      status: "INVESTIGATING",
      // affectedComponents: [{ componentId: "<uuid>", status: "PARTIAL_OUTAGE" }],
    }),
  });
  if (!res.ok) throw new Error(`Status page incident ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return json.data ?? json;
}

async function devhelmCreateMaintenanceWindow(title, description, pr, env) {
  // Maintenance windows are org-level, not status-page-level.
  // Endpoint: POST /api/v1/maintenance-windows
  // Docs: https://docs.devhelm.io/incidents/maintenance-windows

  // Default: starts now, ends in 2 hours.
  // Customise by parsing dates from the PR body if your team uses a convention
  // like "Start: 2026-08-21 02:00 UTC / End: 04:00 UTC"
  const startsAt = new Date();
  const endsAt   = new Date(startsAt.getTime() + 2 * 60 * 60 * 1000);

  const payload = {
    startsAt:       startsAt.toISOString(),
    endsAt:         endsAt.toISOString(),
    reason:         `${title}\n\n${description}`,
    suppressAlerts: true,
    // monitorId: "<uuid>",  // omit for org-wide window
  };

  let res;
  try {
    res = await fetch(`${DEVHELM_API}/maintenance-windows`, {
      method: "POST",
      headers: await devhelmHeaders(env),
      body: JSON.stringify(payload),
    });
  } catch (networkErr) {
    throw new Error(`Maintenance window network error: ${networkErr.message}`);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Maintenance window ${res.status}: ${body}`);
  }

  const json = await res.json();
  return json.data ?? json;
}

async function resolveStatusPageEntry(stored, reason, env) {
  const id = stored.statusPageEntryId;
  if (!id) return;

  if (stored.statusPageEntryType === "maintenance") {
    // Cancel the maintenance window early — endpoint: DELETE /api/v1/maintenance-windows/{id}/cancel
    const res = await fetch(`${DEVHELM_API}/maintenance-windows/${id}/cancel`, {
      method: "POST",
      headers: await devhelmHeaders(env),
      body: JSON.stringify({ reason }),
    });
    if (!res.ok) console.error(`Cancel maintenance window ${res.status}: ${await res.text()}`);
  } else {
    // Resolve the status page incident
    // PATCH /api/v1/status-pages/{id}/incidents/{incidentId}
    // status enum is uppercase: RESOLVED. Endpoint uses page UUID not slug.
    const statusPageId = await env.DEVHELM_STATUS_PAGE_ID.get();
    const res = await fetch(`${DEVHELM_API}/status-pages/${statusPageId}/incidents/${id}`, {
      method: "PATCH",
      headers: await devhelmHeaders(env),
      body: JSON.stringify({ status: "RESOLVED", body: reason }),
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
  const [apiToken, orgId] = await Promise.all([
    env.DEVHELM_API_TOKEN.get(),
    env.DEVHELM_ORG_ID.get(),
  ]);
  return {
    "Authorization":    `Bearer ${apiToken}`,
    "Content-Type":     "application/json",
    "x-phelm-org-id":  orgId || "",
  };
}

async function buildStatusPageUrl(entry, isMaintenance, env) {
  if (isMaintenance) {
    // Maintenance windows are org-level, not on the status page.
    return `https://app.devhelm.io/maintenance-windows/${entry.id}`;
  }
  // Status page incidents: use custom domain if set, else DevHelm-hosted URL.
  // Slug is still used for the public-facing URL; ID is used for API calls.
  const [statusPageUrl, statusPageSlug] = await Promise.all([
    env.DEVHELM_STATUS_PAGE_URL.get(),
    env.DEVHELM_STATUS_PAGE_SLUG.get(),
  ]);
  const base = (statusPageUrl || `https://${statusPageSlug}.devhelm.io`).replace(/\/$/, "");
  return `${base}/incidents/${entry.id}`;
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
