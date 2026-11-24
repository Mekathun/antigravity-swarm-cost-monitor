---
name: swarm-cost
description: Open the Swarm Cost Monitor auxiliary pane or inspect per-Swarm and per-Worker token usage, estimated USD cost share, model breakdown, current conversation context window, and account model quotas. Use when the user asks about swarm spend, worker cost share, context window usage, token consumption across agents, or wants to open the Swarm Cost Monitor UI.
---

# Swarm Cost Monitor

Use this skill when the user wants to monitor, compare, or break down token usage and estimated cost across Antigravity Swarms and their Workers.

## 1. Open the Auxiliary Pane UI

When the plugin is enabled and running, surface this clickable pill link on its own line so the user can toggle the live dashboard in the auxiliary pane:

```markdown
[Swarm Cost Monitor](sidecar://swarm-cost-monitor/swarm_cost/)
```

If the user needs to enable or disable the plugin first, link them to the plugin's Customizations page:

```markdown
[Swarm Cost Monitor](customization://swarm-cost-monitor)
```

## 2. How Metrics Are Calculated

- **Data Sources (Read-Only)**:
  - Native swarm rosters: `<appData>/brain/<coordinatorConv>/.system_generated/swarm/members.json` and `board.jsonl`.
  - Per-worker telemetry: `<appData>/brain/<memberConv>/.system_generated/logs/transcript.jsonl`.
- **Exact-First Token Accounting**:
  - Each `PLANNER_RESPONSE` step records exact `input_tokens`, `cache_read_tokens`, `output_tokens`, and `model`.
  - Every step is priced individually using its recorded model (`pricing.mjs`), accurately reflecting mid-session model switches and cache-read discounts.
  - When a transcript step lacks exact token fields, the backend falls back to CJK-aware character estimation (~1.5 chars/token for CJK, ~4 chars/token for Latin/ASCII) and marks `tokenSource` as `mixed` or `estimated`.
- **Optional Quota Probe**:
  - When `ANTIGRAVITY_LS_ADDRESS` and `ANTIGRAVITY_CSRF_TOKEN` are available, the sidecar queries the local Language Server `GetUserStatus` RPC with a short timeout to display live account model quota percentages and reset timers; if unavailable, the dashboard degrades gracefully without error.

## 3. Sidecar HTTP Endpoints

- `GET /api/health` — Sidecar health and discovery metadata.
- `GET /api/overview?conversationId=<id>` — Summary totals, per-Swarm cost/token shares, and optional `quotas`.
- `GET /api/swarm?id=<swarmId>` (and `GET /api/swarms/:id` in standalone mode) — Full per-Worker breakdown, per-Model distribution, and cost timeline.
- `GET /api/context?conversationId=<id>` — Current conversation's active Context Window usage, category composition, turn-by-turn growth history, and top token consumers.
- `GET /api/pricing` — Reference USD per 1M token pricing table, context window limits, and estimation rules.
- `GET /api/settings` & `POST /api/settings` — Persistent UI settings (`quotaWidgetSize`, `showWeeklyQuota`, `language`).
