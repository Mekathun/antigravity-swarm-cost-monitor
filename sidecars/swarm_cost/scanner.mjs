/**
 * Read-only local scanner for Antigravity native Swarms, worker transcripts,
 * standalone subagent trees, and optional Language Server account quotas.
 *
 * Zero external dependencies (Node.js v24 built-ins only).
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import {
  computeStepCost,
  estimateTokensFromText,
  formatModelLabel,
  resolveModelPricing,
  roundPercent,
  roundUsd,
} from './pricing.mjs';

const ID_RE = /^[0-9a-f-]{8,}$/i;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const QUOTA_ERROR_RE = /RESOURCE_EXHAUSTED|quota|\b429\b|exhausted your capacity|rate.?limit/i;
const SCAN_TTL_MS = 2500;
const QUOTA_TTL_MS = 15000;
const TOOL_DEFS_TTL_MS = 30000;
const QUOTA_TIMEOUT_MS = 1500;
const COMPLETED_IDLE_MS = 30 * 60 * 1000;
const WEEKLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const WEEKLY_RESET_THRESHOLD_SEC = 6 * 3600;
const MAX_TIMELINE_POINTS = 120;
const MAX_TRANSCRIPT_CACHE = 1000;
const MAX_CONTEXT_CACHE = 64;

const transcriptCache = new Map(); // path -> { statKey, analysis }
const contextCache = new Map();    // path -> { statKey, payload }
let scanCache = { builtAt: 0, appDataDirs: [], swarmsById: new Map(), orderedIds: [], weeklyLocalUsage: null };
let quotaCache = { fetchedAtMs: 0, payload: null };
let toolDefsCache = { fetchedAtMs: 0, items: null };

function safeReaddir(dirPath) {
  try {
    return readdirSync(dirPath);
  } catch {
    return [];
  }
}

function safeStat(filePath) {
  try {
    const s = statSync(filePath);
    return { mtimeMs: s.mtimeMs, size: s.size, isFile: s.isFile(), isDir: s.isDirectory() };
  } catch {
    return null;
  }
}

function safeReadUtf8(filePath) {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function toIso(msOrStr) {
  if (typeof msOrStr === 'number' && Number.isFinite(msOrStr) && msOrStr > 0) {
    return new Date(msOrStr).toISOString();
  }
  if (typeof msOrStr === 'string' && msOrStr.trim()) {
    const parsed = Date.parse(msOrStr.includes('T') ? msOrStr : msOrStr.replace(' ', 'T'));
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return null;
}

function toMs(isoOrStr) {
  if (typeof isoOrStr === 'number' && Number.isFinite(isoOrStr)) return isoOrStr;
  if (typeof isoOrStr !== 'string' || !isoOrStr.trim()) return 0;
  const parsed = Date.parse(isoOrStr.includes('T') ? isoOrStr : isoOrStr.replace(' ', 'T'));
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Locate Antigravity app data directories containing a `brain/` folder.
 */
export function findAppDataDirs() {
  const candidates = [];

  if (process.env.SWARM_COST_APP_DATA_DIR) {
    candidates.push(process.env.SWARM_COST_APP_DATA_DIR);
  }

  if (process.env.ANTIGRAVITY_APP_DATA_DIR) {
    candidates.push(process.env.ANTIGRAVITY_APP_DATA_DIR);
  }

  const execDataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (execDataDir) {
    for (let d = execDataDir; d !== dirname(d); d = dirname(d)) {
      if (basename(d) === 'sidecar_data') {
        candidates.push(dirname(d));
        break;
      }
    }
  }

  // Fallback: scan ~/.gemini/<product> directories that contain a brain/ folder.
  if (candidates.length === 0) {
    const geminiRoot = join(homedir(), '.gemini');
    for (const entry of safeReaddir(geminiRoot).sort()) {
      candidates.push(join(geminiRoot, entry));
    }
  }

  const seen = new Set();
  const valid = [];
  for (const dir of candidates) {
    const resolved = resolve(dir);
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    if (existsSync(join(resolved, 'brain'))) {
      seen.add(key);
      valid.push(resolved);
    }
  }
  return valid;
}

function roleOf(name, member) {
  const r = typeof member?.role === 'string' ? member.role.trim() : '';
  if (r && r !== 'worker') return r;
  const match = /^(narrator|monitor)(?:-\d+)?$/i.exec(String(name || ''));
  return match ? match[1].toLowerCase() : r || 'worker';
}

function turnEnded(steps) {
  const results = [];
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (!step || typeof step !== 'object') return false;
    if (step.type === 'GENERIC') {
      results.unshift(step);
      continue;
    }
    if (step.type !== 'PLANNER_RESPONSE') return false;
    const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
    if (calls.length === 0) return results.length === 0;
    const waitIdx = calls.findIndex((c) => c?.name === 'swarm_wait');
    return waitIdx >= 0 && results.length >= calls.length && results[waitIdx]?.status === 'DONE';
  }
  return false;
}

function extractUserPromptSnippet(content) {
  if (typeof content !== 'string' || !content) return '';
  const match = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i.exec(content);
  const raw = match ? match[1] : content;
  const clean = raw.replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  return clean.length > 56 ? `${clean.slice(0, 55).trimEnd()}…` : clean;
}

function serializeToolCalls(calls) {
  if (!Array.isArray(calls) || calls.length === 0) return '';
  try {
    return JSON.stringify(calls);
  } catch {
    return '';
  }
}

/**
 * Analyze one conversation's `transcript.jsonl` with mtime+size caching.
 */
function analyzeTranscript(appData, convId, fallbackModel = '') {
  if (!appData || !convId || !ID_RE.test(convId)) return null;
  const trPath = join(appData, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');
  const st = safeStat(trPath);
  if (!st || !st.isFile) return null;

  const statKey = `${st.mtimeMs}:${st.size}:${fallbackModel}`;
  const hit = transcriptCache.get(trPath);
  if (hit && hit.statKey === statKey) return hit.analysis;

  const rawText = safeReadUtf8(trPath);
  if (rawText == null) return null;

  const lines = rawText.split('\n');
  const parsedSteps = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === 'object') parsedSteps.push(obj);
    } catch {
      // Ignore torn final line while transcript is actively being appended.
    }
  }

  let steps = parsedSteps.length;
  let plannerSteps = 0;
  let toolCalls = 0;
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let thinkingTokens = 0;
  let outputTokens = 0;
  let inputUsd = 0;
  let cacheReadUsd = 0;
  let outputUsd = 0;
  let exactSteps = 0;
  let estimatedSteps = 0;
  let startedMs = 0;
  let lastActiveMs = 0;
  let firstUserPrompt = '';
  let lastModel = fallbackModel || '';
  let runningContextEst = 1800; // Baseline system prompt overhead for fallback estimation.

  const modelsUsedSet = new Set();
  const modelStats = new Map();
  const timelineEvents = [];
  const subagentConvIds = new Set();
  let sawSubagentInvoke = false;

  for (let i = 0; i < parsedSteps.length; i++) {
    const step = parsedSteps[i];
    if (Number.isFinite(step.step_index)) {
      steps = Math.max(steps, step.step_index + 1);
    }

    const tsMs = toMs(step.created_at);
    if (tsMs > 0) {
      if (!startedMs || tsMs < startedMs) startedMs = tsMs;
      if (tsMs > lastActiveMs) lastActiveMs = tsMs;
    }

    if (step.type === 'USER_INPUT') {
      if (!firstUserPrompt && typeof step.content === 'string') {
        firstUserPrompt = extractUserPromptSnippet(step.content);
      }
      runningContextEst += estimateTokensFromText(step.content || '');
      continue;
    }

    if (step.type === 'SYSTEM_MESSAGE') {
      runningContextEst += estimateTokensFromText(step.content || '');
      continue;
    }

    if (step.type === 'GENERIC') {
      const contentStr = typeof step.content === 'string' ? step.content : '';
      runningContextEst += Math.min(25000, estimateTokensFromText(contentStr));
      if (sawSubagentInvoke && contentStr) {
        const matches = contentStr.match(UUID_RE) || [];
        for (const candidate of matches) {
          const lower = candidate.toLowerCase();
          if (lower !== convId.toLowerCase()) {
            subagentConvIds.add(lower);
          }
        }
      }
      continue;
    }

    if (step.type !== 'PLANNER_RESPONSE') continue;

    plannerSteps++;
    const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
    toolCalls += calls.length;
    if (calls.some((tc) => tc?.name === 'invoke_subagent')) {
      sawSubagentInvoke = true;
    }

    const stepModel =
      (typeof step.model === 'string' && step.model.trim()) ||
      lastModel ||
      fallbackModel ||
      'unknown';
    if (stepModel && stepModel !== 'unknown') {
      lastModel = stepModel;
    }
    modelsUsedSet.add(stepModel);

    const hasExactInput = Number.isFinite(Number(step.input_tokens)) && step.input_tokens !== null && step.input_tokens !== undefined;
    const hasExactOutput = Number.isFinite(Number(step.output_tokens)) && step.output_tokens !== null && step.output_tokens !== undefined;
    const isExact = hasExactInput || hasExactOutput;

    let stepIn = 0;
    let stepCache = 0;
    let stepOut = 0;
    let stepThink = 0;

    if (isExact) {
      exactSteps++;
      stepIn = Math.max(0, Math.round(Number(step.input_tokens) || 0));
      stepCache = Math.max(0, Math.round(Number(step.cache_read_tokens) || 0));
      stepOut = Math.max(0, Math.round(Number(step.output_tokens) || 0));
      if (Number.isFinite(Number(step.thinking_tokens)) && step.thinking_tokens !== null && step.thinking_tokens !== undefined) {
        stepThink = Math.min(stepOut, Math.max(0, Math.round(Number(step.thinking_tokens))));
      } else {
        const estThink = estimateTokensFromText(typeof step.thinking === 'string' ? step.thinking : '');
        stepThink = Math.min(stepOut, estThink);
      }
      runningContextEst = stepIn + stepCache + stepOut;
    } else {
      estimatedSteps++;
      stepThink = estimateTokensFromText(typeof step.thinking === 'string' ? step.thinking : '');
      const visibleOut =
        estimateTokensFromText(typeof step.content === 'string' ? step.content : '') +
        estimateTokensFromText(serializeToolCalls(calls));
      stepOut = stepThink + visibleOut;
      stepIn = Math.max(500, Math.min(200_000, Math.round(runningContextEst)));
      stepCache = 0;
      runningContextEst += stepOut;
    }

    const stepTokens = stepIn + stepCache + stepOut;
    const cost = computeStepCost(stepModel, {
      inputTokens: stepIn,
      cacheReadTokens: stepCache,
      outputTokens: stepOut,
      thinkingTokens: stepThink,
    });

    inputTokens += stepIn;
    cacheReadTokens += stepCache;
    thinkingTokens += stepThink;
    outputTokens += stepOut;
    inputUsd += cost.inputUsd;
    cacheReadUsd += cost.cacheReadUsd;
    outputUsd += cost.outputUsd;

    const msEntry = modelStats.get(stepModel) || {
      model: stepModel,
      plannerSteps: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      thinkingTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
    };
    msEntry.plannerSteps++;
    msEntry.inputTokens += stepIn;
    msEntry.cacheReadTokens += stepCache;
    msEntry.thinkingTokens += stepThink;
    msEntry.outputTokens += stepOut;
    msEntry.totalTokens += stepTokens;
    msEntry.estimatedCostUsd += cost.totalUsd;
    modelStats.set(stepModel, msEntry);

    timelineEvents.push({
      timestampMs: tsMs || st.mtimeMs,
      timestamp: toIso(tsMs || st.mtimeMs),
      model: stepModel,
      stepCostUsd: cost.totalUsd,
      stepTokens,
    });
  }

  if (!lastActiveMs && st.mtimeMs) lastActiveMs = st.mtimeMs;
  if (!startedMs && lastActiveMs) startedMs = lastActiveMs;

  const newest = parsedSteps[parsedSteps.length - 1] || null;
  const hasQuotaError = Boolean(
    newest &&
      (newest.type === 'ERROR_MESSAGE' || newest.status === 'ERROR') &&
      QUOTA_ERROR_RE.test(String(newest.error || newest.content || ''))
  );

  const tokenSource =
    exactSteps > 0 && estimatedSteps === 0
      ? 'exact'
      : exactSteps > 0 && estimatedSteps > 0
        ? 'mixed'
        : 'estimated';

  const analysis = {
    steps,
    plannerSteps,
    toolCalls,
    inputTokens,
    cacheReadTokens,
    thinkingTokens,
    outputTokens,
    totalTokens: inputTokens + cacheReadTokens + outputTokens,
    estimatedCostUsd: inputUsd + cacheReadUsd + outputUsd,
    costBreakdown: { inputUsd, cacheReadUsd, outputUsd },
    exactSteps,
    estimatedSteps,
    tokenSource,
    modelsUsed: [...modelsUsedSet],
    modelStats,
    lastModel,
    startedMs,
    lastActiveMs,
    idle: parsedSteps.length > 0 ? turnEnded(parsedSteps) : true,
    hasQuotaError,
    firstUserPrompt,
    timelineEvents,
    subagentConvIds: [...subagentConvIds],
  };

  if (transcriptCache.size > MAX_TRANSCRIPT_CACHE) {
    transcriptCache.clear();
  }
  transcriptCache.set(trPath, { statKey, analysis });
  return analysis;
}

function parseBoardStats(boardPath) {
  const text = safeReadUtf8(boardPath);
  if (!text) return { count: 0, postsByAgent: new Map(), earliestMs: 0, latestMs: 0 };
  let count = 0;
  let earliestMs = 0;
  let latestMs = 0;
  const postsByAgent = new Map();

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line);
      if (!m || typeof m !== 'object') continue;
      count++;
      if (typeof m.agent === 'string' && m.agent) {
        postsByAgent.set(m.agent, (postsByAgent.get(m.agent) || 0) + 1);
      }
      const ts = toMs(m.time);
      if (ts > 0) {
        if (!earliestMs || ts < earliestMs) earliestMs = ts;
        if (ts > latestMs) latestMs = ts;
      }
    } catch {
      // Ignore torn line.
    }
  }
  return { count, postsByAgent, earliestMs, latestMs };
}

function mergeTokenSources(sources) {
  const present = sources.filter(Boolean);
  if (present.length === 0) return 'estimated';
  const allExact = present.every((s) => s === 'exact');
  if (allExact) return 'exact';
  const allEstimated = present.every((s) => s === 'estimated');
  if (allEstimated) return 'estimated';
  return 'mixed';
}

function buildTimeline(rawEvents) {
  if (!rawEvents.length) return [];
  rawEvents.sort((a, b) => a.timestampMs - b.timestampMs);

  let cumulativeCost = 0;
  let cumulativeTokens = 0;
  const full = rawEvents.map((ev) => {
    cumulativeCost += ev.stepCostUsd;
    cumulativeTokens += ev.stepTokens;
    return {
      timestamp: ev.timestamp || new Date(ev.timestampMs).toISOString(),
      worker: ev.worker,
      model: ev.model,
      stepCostUsd: roundUsd(ev.stepCostUsd),
      cumulativeCostUsd: roundUsd(cumulativeCost),
      stepTokens: ev.stepTokens,
      cumulativeTokens,
    };
  });

  if (full.length <= MAX_TIMELINE_POINTS) return full;

  // Evenly downsample while always retaining first and final points.
  const sampled = [full[0]];
  const innerCount = MAX_TIMELINE_POINTS - 2;
  const span = full.length - 2;
  for (let i = 1; i <= innerCount; i++) {
    const idx = Math.min(full.length - 2, Math.max(1, Math.round((i * span) / (innerCount + 1))));
    sampled.push(full[idx]);
  }
  sampled.push(full[full.length - 1]);
  return sampled;
}

function buildSwarmRecord({ appData, id, kind, title, memberEntries, boardStats, nowMs }) {
  const workers = [];
  const swarmModelMap = new Map();
  const rawTimeline = [];

  let totalSteps = 0;
  let totalPlannerSteps = 0;
  let totalToolCalls = 0;
  let totalInputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalThinkingTokens = 0;
  let totalOutputTokens = 0;
  let totalTokens = 0;
  let totalCostUsd = 0;
  let activeWorkerCount = 0;
  let killedWorkerCount = 0;
  let startedMs = boardStats.earliestMs || 0;
  let lastActiveMs = boardStats.latestMs || 0;
  let fallbackTitle = '';

  for (const entry of memberEntries) {
    const tr = analyzeTranscript(appData, entry.conversationId, entry.rosterModel);
    const model = entry.rosterModel || tr?.lastModel || 'unknown';
    const pricing = resolveModelPricing(model);

    let state = 'unknown';
    if (entry.killed) {
      state = 'killed';
      killedWorkerCount++;
    } else if (tr) {
      state = tr.idle ? 'waiting' : 'working';
    } else if (entry.wakeMode === 'mentions' || entry.wakeMode === 'anything') {
      state = 'waiting';
    } else if (entry.wakeMode === 'working') {
      state = 'working';
    }
    if (state === 'working') activeWorkerCount++;

    if (entry.role === 'coordinator' && tr?.firstUserPrompt && !fallbackTitle) {
      fallbackTitle = tr.firstUserPrompt;
    }

    const wSteps = tr?.steps || 0;
    const wPlannerSteps = tr?.plannerSteps || 0;
    const wToolCalls = tr?.toolCalls || 0;
    const wIn = tr?.inputTokens || 0;
    const wCache = tr?.cacheReadTokens || 0;
    const wThink = tr?.thinkingTokens || 0;
    const wOut = tr?.outputTokens || 0;
    const wTotal = tr?.totalTokens || 0;
    const wCost = tr?.estimatedCostUsd || 0;

    if (tr?.startedMs && (!startedMs || tr.startedMs < startedMs)) startedMs = tr.startedMs;
    if (tr?.lastActiveMs && tr.lastActiveMs > lastActiveMs) lastActiveMs = tr.lastActiveMs;

    totalSteps += wSteps;
    totalPlannerSteps += wPlannerSteps;
    totalToolCalls += wToolCalls;
    totalInputTokens += wIn;
    totalCacheReadTokens += wCache;
    totalThinkingTokens += wThink;
    totalOutputTokens += wOut;
    totalTokens += wTotal;
    totalCostUsd += wCost;

    // Aggregate per-model stats from each worker's actual step-level model usage.
    const workerModelsSeen = new Set();
    if (tr && tr.modelStats.size > 0) {
      for (const [mId, stats] of tr.modelStats.entries()) {
        workerModelsSeen.add(mId);
        const agg = swarmModelMap.get(mId) || {
          model: mId,
          modelLabel: formatModelLabel(mId),
          modelFamily: resolveModelPricing(mId).family,
          workerSet: new Set(),
          plannerSteps: 0,
          inputTokens: 0,
          cacheReadTokens: 0,
          thinkingTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          estimatedCostUsd: 0,
        };
        agg.workerSet.add(entry.name);
        agg.plannerSteps += stats.plannerSteps;
        agg.inputTokens += stats.inputTokens;
        agg.cacheReadTokens += stats.cacheReadTokens;
        agg.thinkingTokens += stats.thinkingTokens;
        agg.outputTokens += stats.outputTokens;
        agg.totalTokens += stats.totalTokens;
        agg.estimatedCostUsd += stats.estimatedCostUsd;
        swarmModelMap.set(mId, agg);
      }
    } else if (model && model !== 'unknown') {
      workerModelsSeen.add(model);
      const agg = swarmModelMap.get(model) || {
        model,
        modelLabel: formatModelLabel(model),
        modelFamily: pricing.family,
        workerSet: new Set(),
        plannerSteps: 0,
        inputTokens: 0,
        cacheReadTokens: 0,
        thinkingTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        estimatedCostUsd: 0,
      };
      agg.workerSet.add(entry.name);
      swarmModelMap.set(model, agg);
    }

    if (tr?.timelineEvents?.length) {
      for (const ev of tr.timelineEvents) {
        rawTimeline.push({
          timestampMs: ev.timestampMs,
          timestamp: ev.timestamp,
          worker: entry.name,
          model: ev.model,
          stepCostUsd: ev.stepCostUsd,
          stepTokens: ev.stepTokens,
        });
      }
    }

    // Build per-worker model breakdown for multi-color stacked bars & detail view.
    const modelBreakdown = [];
    if (tr && tr.modelStats.size > 0) {
      for (const [mId, stats] of tr.modelStats.entries()) {
        modelBreakdown.push({
          model: mId,
          modelLabel: formatModelLabel(mId),
          modelFamily: resolveModelPricing(mId).family,
          plannerSteps: stats.plannerSteps,
          inputTokens: stats.inputTokens,
          cacheReadTokens: stats.cacheReadTokens,
          thinkingTokens: stats.thinkingTokens,
          outputTokens: stats.outputTokens,
          totalTokens: stats.totalTokens,
          estimatedCostUsd: roundUsd(stats.estimatedCostUsd),
          costSharePercent: wCost > 0 ? roundPercent((stats.estimatedCostUsd / wCost) * 100) : 0,
          tokenSharePercent: wTotal > 0 ? roundPercent((stats.totalTokens / wTotal) * 100) : 0,
          stepSharePercent: wPlannerSteps > 0 ? roundPercent((stats.plannerSteps / wPlannerSteps) * 100) : 0,
        });
      }
      modelBreakdown.sort(
        (a, b) =>
          b.estimatedCostUsd - a.estimatedCostUsd ||
          b.totalTokens - a.totalTokens ||
          b.plannerSteps - a.plannerSteps
      );
    } else if (model && model !== 'unknown') {
      modelBreakdown.push({
        model,
        modelLabel: formatModelLabel(model),
        modelFamily: pricing.family,
        plannerSteps: wPlannerSteps,
        inputTokens: wIn,
        cacheReadTokens: wCache,
        thinkingTokens: wThink,
        outputTokens: wOut,
        totalTokens: wTotal,
        estimatedCostUsd: roundUsd(wCost),
        costSharePercent: wCost > 0 ? 100 : 0,
        tokenSharePercent: wTotal > 0 ? 100 : 0,
        stepSharePercent: wPlannerSteps > 0 ? 100 : 0,
      });
    }

    workers.push({
      name: entry.name,
      role: entry.role,
      model,
      modelLabel: formatModelLabel(model),
      modelFamily: pricing.family,
      state,
      conversationId: entry.conversationId,
      steps: wSteps,
      plannerSteps: wPlannerSteps,
      toolCalls: wToolCalls,
      inputTokens: wIn,
      cacheReadTokens: wCache,
      thinkingTokens: wThink,
      outputTokens: wOut,
      totalTokens: wTotal,
      estimatedCostUsd: roundUsd(wCost),
      _rawCostUsd: wCost,
      costBreakdown: {
        inputUsd: roundUsd(tr?.costBreakdown?.inputUsd || 0),
        cacheReadUsd: roundUsd(tr?.costBreakdown?.cacheReadUsd || 0),
        outputUsd: roundUsd(tr?.costBreakdown?.outputUsd || 0),
      },
      costSharePercent: 0,
      tokenSharePercent: 0,
      stepSharePercent: 0,
      tokenSource: tr ? tr.tokenSource : 'exact',
      exactSteps: tr?.exactSteps || 0,
      estimatedSteps: tr?.estimatedSteps || 0,
      modelsUsed: [...workerModelsSeen],
      modelBreakdown,
      lastActiveAt: toIso(tr?.lastActiveMs || 0),
      boardPosts: boardStats.postsByAgent.get(entry.name) || 0,
      hasQuotaError: Boolean(tr?.hasQuotaError),
    });
  }

  // Compute worker share percentages safely (no NaN / Infinity).
  for (const w of workers) {
    w.costSharePercent = totalCostUsd > 0 ? roundPercent((w._rawCostUsd / totalCostUsd) * 100) : 0;
    w.tokenSharePercent = totalTokens > 0 ? roundPercent((w.totalTokens / totalTokens) * 100) : 0;
    w.stepSharePercent = totalSteps > 0 ? roundPercent((w.steps / totalSteps) * 100) : 0;
    delete w._rawCostUsd;
  }

  workers.sort(
    (a, b) =>
      b.estimatedCostUsd - a.estimatedCostUsd ||
      b.totalTokens - a.totalTokens ||
      (a.role === 'coordinator' ? -1 : b.role === 'coordinator' ? 1 : 0) ||
      a.name.localeCompare(b.name)
  );

  const models = [...swarmModelMap.values()]
    .map((m) => ({
      model: m.model,
      modelLabel: m.modelLabel,
      modelFamily: m.modelFamily,
      workerCount: m.workerSet.size,
      plannerSteps: m.plannerSteps,
      inputTokens: m.inputTokens,
      cacheReadTokens: m.cacheReadTokens,
      thinkingTokens: m.thinkingTokens,
      outputTokens: m.outputTokens,
      totalTokens: m.totalTokens,
      estimatedCostUsd: roundUsd(m.estimatedCostUsd),
      costSharePercent: totalCostUsd > 0 ? roundPercent((m.estimatedCostUsd / totalCostUsd) * 100) : 0,
      tokenSharePercent: totalTokens > 0 ? roundPercent((m.totalTokens / totalTokens) * 100) : 0,
    }))
    .sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd || b.totalTokens - a.totalTokens);

  const nonCoordinatorWorkers = workers.filter((w) => w.role !== 'coordinator');
  const allNonCoordKilled =
    nonCoordinatorWorkers.length > 0 && nonCoordinatorWorkers.every((w) => w.state === 'killed');

  let status = 'idle';
  if (activeWorkerCount > 0) {
    status = 'active';
  } else if (allNonCoordKilled || (lastActiveMs > 0 && nowMs - lastActiveMs > COMPLETED_IDLE_MS)) {
    status = 'completed';
  }

  const primaryModel = models[0]?.model || workers[0]?.model || 'unknown';
  const resolvedTitle = title || fallbackTitle || (kind === 'subagent_tree' ? `Subagent Tree ${id.slice(0, 8)}` : `Swarm ${id.slice(0, 8)}`);
  const tokenSource = mergeTokenSources(
    workers.filter((w) => w.plannerSteps > 0).map((w) => w.tokenSource)
  );

  return {
    id,
    title: resolvedTitle,
    kind,
    status,
    startedAt: toIso(startedMs),
    lastActiveAt: toIso(lastActiveMs),
    _lastActiveMs: lastActiveMs,
    boardMessages: boardStats.count,
    tokenSource,
    primaryModel,
    primaryModelLabel: formatModelLabel(primaryModel),
    modelIds: models.map((m) => m.model),
    totals: {
      workerCount: workers.length,
      activeWorkerCount,
      killedWorkerCount,
      steps: totalSteps,
      plannerSteps: totalPlannerSteps,
      toolCalls: totalToolCalls,
      inputTokens: totalInputTokens,
      cacheReadTokens: totalCacheReadTokens,
      thinkingTokens: totalThinkingTokens,
      outputTokens: totalOutputTokens,
      totalTokens,
      estimatedCostUsd: roundUsd(totalCostUsd),
      _rawCostUsd: totalCostUsd,
    },
    workers,
    models,
    timeline: buildTimeline(rawTimeline),
  };
}

/**
 * Scan local brain directories for all native Swarms (and standalone subagent trees).
 */
export function scanSwarms({ force = false } = {}) {
  const nowMs = Date.now();
  if (!force && nowMs - scanCache.builtAt < SCAN_TTL_MS && scanCache.builtAt > 0) {
    return { ...scanCache, cached: true };
  }

  const appDataDirs = findAppDataDirs();
  const swarmsById = new Map();
  const claimedConvIds = new Set();
  const brainEntries = [];

  for (const appData of appDataDirs) {
    const brainRoot = join(appData, 'brain');
    for (const convId of safeReaddir(brainRoot)) {
      if (!ID_RE.test(convId)) continue;
      brainEntries.push({ appData, convId });
    }
  }

  // Pass 1: Discover all first-class native Swarms via `.system_generated/swarm/members.json`.
  for (const { appData, convId } of brainEntries) {
    if (swarmsById.has(convId)) continue;
    const swarmDir = join(appData, 'brain', convId, '.system_generated', 'swarm');
    const membersPath = join(swarmDir, 'members.json');
    if (!existsSync(membersPath)) continue;

    const rawMembers = safeReadUtf8(membersPath);
    if (!rawMembers) continue;
    let roster;
    try {
      roster = JSON.parse(rawMembers);
    } catch {
      continue;
    }
    if (!roster || typeof roster !== 'object' || !roster.members || typeof roster.members !== 'object') {
      continue;
    }

    const memberEntries = [];
    for (const [name, m] of Object.entries(roster.members)) {
      if (!m || typeof m !== 'object') continue;
      const memberConv = typeof m.conversation_id === 'string' ? m.conversation_id : '';
      if (memberConv) claimedConvIds.add(memberConv.toLowerCase());
      memberEntries.push({
        name,
        role: roleOf(name, m),
        conversationId: memberConv,
        rosterModel: m.model || m.applied_model || m.desired_model || '',
        killed: Boolean(m.killed || m.desired_state === 'KILLED' || m.phase === 'KILLED'),
        wakeMode: typeof m.wake_mode === 'string' ? m.wake_mode : '',
      });
    }
    claimedConvIds.add(convId.toLowerCase());

    const boardStats = parseBoardStats(join(swarmDir, 'board.jsonl'));
    const record = buildSwarmRecord({
      appData,
      id: convId,
      kind: 'swarm',
      title: typeof roster.title === 'string' ? roster.title.trim() : '',
      memberEntries,
      boardStats,
      nowMs,
    });
    swarmsById.set(convId, record);
  }

  // Pass 2: Gracefully discover standalone subagent trees (conversations invoking subagents
  // whose child conversation IDs exist in brain/ and aren't already part of a native swarm).
  const existingConvSet = new Set(brainEntries.map((e) => e.convId.toLowerCase()));
  for (const { appData, convId } of brainEntries) {
    const lowerId = convId.toLowerCase();
    if (claimedConvIds.has(lowerId) || swarmsById.has(convId)) continue;
    const tr = analyzeTranscript(appData, convId, '');
    if (!tr || !tr.subagentConvIds.length) continue;

    const children = tr.subagentConvIds.filter(
      (cid) => existingConvSet.has(cid) && !claimedConvIds.has(cid)
    );
    if (!children.length) continue;

    const memberEntries = [
      {
        name: 'parent',
        role: 'coordinator',
        conversationId: convId,
        rosterModel: tr.lastModel || '',
        killed: false,
        wakeMode: '',
      },
      ...children.map((cid, idx) => ({
        name: `subagent-${idx + 1}`,
        role: 'subagent',
        conversationId: cid,
        rosterModel: '',
        killed: false,
        wakeMode: '',
      })),
    ];

    claimedConvIds.add(lowerId);
    for (const cid of children) claimedConvIds.add(cid);

    const record = buildSwarmRecord({
      appData,
      id: convId,
      kind: 'subagent_tree',
      title: tr.firstUserPrompt || '',
      memberEntries,
      boardStats: { count: 0, postsByAgent: new Map(), earliestMs: 0, latestMs: 0 },
      nowMs,
    });
    swarmsById.set(convId, record);
  }

  const ordered = [...swarmsById.values()].sort(
    (a, b) =>
      (a.kind === 'swarm' ? 0 : 1) - (b.kind === 'swarm' ? 0 : 1) ||
      b._lastActiveMs - a._lastActiveMs ||
      b.totals.estimatedCostUsd - a.totals.estimatedCostUsd
  );

  // Pass 3: Compute 7-day rolling local usage rollup across all brain transcripts.
  const weeklyLocalUsage = computeWeeklyLocalUsage(brainEntries, nowMs);

  scanCache = {
    builtAt: nowMs,
    appDataDirs,
    swarmsById,
    orderedIds: ordered.map((s) => s.id),
    weeklyLocalUsage,
  };

  return { ...scanCache, cached: false };
}

function roundOneDecimal(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n >= 100) return 100;
  return Math.round(n * 10) / 10;
}

function computeWeeklyLocalUsage(brainEntries, nowMs) {
  const sinceMs = nowMs - WEEKLY_WINDOW_MS;
  const total = { tokens: 0, steps: 0, _rawCost: 0 };
  const gemini = { tokens: 0, steps: 0, _rawCost: 0 };
  const claude = { tokens: 0, steps: 0, _rawCost: 0 };

  const seenConvs = new Set();
  for (const { appData, convId } of brainEntries) {
    const key = convId.toLowerCase();
    if (seenConvs.has(key)) continue;
    seenConvs.add(key);

    const tr = analyzeTranscript(appData, convId, '');
    if (!tr || !tr.timelineEvents.length) continue;

    for (const ev of tr.timelineEvents) {
      if ((ev.timestampMs || 0) < sinceMs) continue;
      total.tokens += ev.stepTokens;
      total.steps += 1;
      total._rawCost += ev.stepCostUsd;

      const family = resolveModelPricing(ev.model).family;
      if (family === 'gemini') {
        gemini.tokens += ev.stepTokens;
        gemini.steps += 1;
        gemini._rawCost += ev.stepCostUsd;
      } else if (family === 'claude') {
        claude.tokens += ev.stepTokens;
        claude.steps += 1;
        claude._rawCost += ev.stepCostUsd;
      }
    }
  }

  const shareOf = (bucket) => {
    if (total._rawCost > 0) return roundPercent((bucket._rawCost / total._rawCost) * 100);
    if (total.tokens > 0) return roundPercent((bucket.tokens / total.tokens) * 100);
    return 0;
  };

  return {
    windowDays: 7,
    since: new Date(sinceMs).toISOString(),
    total: {
      tokens: total.tokens,
      steps: total.steps,
      estimatedCostUsd: roundUsd(total._rawCost),
    },
    byPool: {
      gemini: {
        tokens: gemini.tokens,
        steps: gemini.steps,
        estimatedCostUsd: roundUsd(gemini._rawCost),
        sharePercent: shareOf(gemini),
      },
      claude: {
        tokens: claude.tokens,
        steps: claude.steps,
        estimatedCostUsd: roundUsd(claude._rawCost),
        sharePercent: shareOf(claude),
      },
    },
  };
}

function classifyQuotaPool(label, rawModel) {
  const s = `${label || ''} ${rawModel || ''}`.toLowerCase();
  if (s.includes('gemini') || s.includes('orchestrator')) return 'gemini';
  if (s.includes('claude')) return 'claude';
  return 'other';
}

function baseModelName(label) {
  return String(label || '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .trim();
}

function windowKindFromReset(resetInSec) {
  if (resetInSec === null || !Number.isFinite(resetInSec)) return 'unknown';
  return resetInSec > WEEKLY_RESET_THRESHOLD_SEC ? 'weekly' : '5h';
}

function buildQuotaPools(items) {
  // Determine Claude's reset signature so shared third-party models (e.g. GPT-OSS)
  // that share the exact same resetTime & remainingPercent merge into the Claude pool
  // rather than creating a noisy duplicate third gauge.
  const claudeRef = items.find((it) => it.pool === 'claude') || null;
  const groups = new Map();

  for (const it of items) {
    let poolId = it.pool;
    if (
      poolId === 'other' &&
      claudeRef &&
      it.resetTime &&
      it.resetTime === claudeRef.resetTime &&
      Math.abs(it.remainingPercent - claudeRef.remainingPercent) < 0.05
    ) {
      poolId = 'claude';
    }

    let g = groups.get(poolId);
    if (!g) {
      g = {
        id: poolId,
        label: poolId === 'gemini' ? 'Gemini' : poolId === 'claude' ? 'Claude' : 'Other',
        minRemaining: it.remainingPercent,
        resetTime: it.resetTime,
        resetInSec: it.resetInSec,
        modelCount: 0,
        sampleSet: new Set(),
      };
      groups.set(poolId, g);
    }
    g.modelCount += 1;
    if (it.remainingPercent < g.minRemaining) {
      g.minRemaining = it.remainingPercent;
      g.resetTime = it.resetTime;
      g.resetInSec = it.resetInSec;
    } else if (!g.resetTime && it.resetTime) {
      g.resetTime = it.resetTime;
      g.resetInSec = it.resetInSec;
    }
    const base = baseModelName(it.label);
    if (base && g.sampleSet.size < 4) g.sampleSet.add(base);
  }

  const order = { gemini: 0, claude: 1, other: 2 };
  return [...groups.values()]
    .sort((a, b) => (order[a.id] ?? 9) - (order[b.id] ?? 9))
    .map((g) => {
      const remainingPercent = roundOneDecimal(g.minRemaining);
      const usedPercent = roundOneDecimal(100 - remainingPercent);
      const status =
        remainingPercent <= 0 ? 'exhausted' : remainingPercent <= 20 ? 'low' : 'ok';
      return {
        id: g.id,
        label: g.label,
        remainingPercent,
        usedPercent,
        resetTime: g.resetTime,
        resetInSec: g.resetInSec,
        windowKind: windowKindFromReset(g.resetInSec),
        status,
        modelCount: g.modelCount,
        sampleModels: [...g.sampleSet],
      };
    });
}

function extractCredits(planStatus) {
  if (!planStatus || typeof planStatus !== 'object') return null;
  const numOrNull = (v) =>
    v !== undefined && v !== null && Number.isFinite(Number(v)) ? Number(v) : null;
  const availablePromptCredits = numOrNull(planStatus.availablePromptCredits);
  const availableFlowCredits = numOrNull(planStatus.availableFlowCredits);
  const monthlyPromptCredits = numOrNull(planStatus.planInfo?.monthlyPromptCredits);
  const monthlyFlowCredits = numOrNull(planStatus.planInfo?.monthlyFlowCredits);
  if (
    availablePromptCredits === null &&
    availableFlowCredits === null &&
    monthlyPromptCredits === null &&
    monthlyFlowCredits === null
  ) {
    return null;
  }
  return {
    availablePromptCredits,
    availableFlowCredits,
    monthlyPromptCredits,
    monthlyFlowCredits,
  };
}

/**
 * Optional local Language Server quota probe via GetUserStatus.
 * Always fails soft and returns a clean schema if unavailable.
 */
export async function probeQuotas({ force = false } = {}) {
  const nowMs = Date.now();
  if (!force && quotaCache.payload && nowMs - quotaCache.fetchedAtMs < QUOTA_TTL_MS) {
    return quotaCache.payload;
  }

  const fetchedAt = new Date(nowMs).toISOString();
  const lsAddr = process.env.ANTIGRAVITY_LS_ADDRESS;
  const csrfToken = process.env.ANTIGRAVITY_CSRF_TOKEN;

  const emptyUnavailable = (reason) => ({
    available: false,
    source: 'unavailable',
    reason,
    fetchedAt,
    planTier: null,
    credits: null,
    pools: [],
    items: [],
  });

  if (!lsAddr || !csrfToken) {
    const payload = emptyUnavailable('Local Language Server RPC environment variables are not set');
    quotaCache = { fetchedAtMs: nowMs, payload };
    return payload;
  }

  const baseUrl = /^https?:\/\//i.test(lsAddr) ? lsAddr.replace(/\/+$/, '') : `http://${lsAddr}`;
  const url = `${baseUrl}/exa.language_server_pb.LanguageServerService/GetUserStatus`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-codeium-csrf-token': csrfToken,
      },
      body: '{}',
      signal: AbortSignal.timeout(QUOTA_TIMEOUT_MS),
    });

    if (!res.ok) {
      const payload = emptyUnavailable(`Language Server returned HTTP ${res.status}`);
      quotaCache = { fetchedAtMs: nowMs, payload };
      return payload;
    }

    const data = await res.json();
    const userStatus = data?.userStatus || {};
    const planTier =
      (typeof userStatus?.userTier?.name === 'string' && userStatus.userTier.name.trim()) ||
      (typeof userStatus?.planStatus?.planInfo?.planName === 'string' &&
        userStatus.planStatus.planInfo.planName.trim()) ||
      null;
    const credits = extractCredits(userStatus?.planStatus);

    const rawConfigs =
      userStatus?.cascadeModelConfigData?.clientModelConfigs ||
      data?.cascadeModelConfigData?.clientModelConfigs ||
      data?.clientModelConfigs ||
      [];

    const items = [];
    const seen = new Set();
    for (const cfg of Array.isArray(rawConfigs) ? rawConfigs : []) {
      const qi = cfg?.quotaInfo;
      if (!qi || typeof qi !== 'object') continue;

      const rawModel =
        cfg?.modelOrAlias?.model ||
        cfg?.modelOrAlias?.alias ||
        cfg?.model ||
        cfg?.label ||
        '';
      const label = String(cfg?.label || formatModelLabel(rawModel) || rawModel || 'Model').trim();
      const id = String(rawModel || label).toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
      if (!id || seen.has(id)) continue;
      seen.add(id);

      const resetTime = toIso(qi.resetTime);
      const resetMs = toMs(resetTime);
      const resetInSec = resetMs > nowMs ? Math.max(0, Math.round((resetMs - nowMs) / 1000)) : null;

      // Proto3 omits float 0.0 in JSON serialization: when quotaInfo has resetTime
      // but omits remainingFraction, the pool is exhausted (0%), NOT 100%.
      const hasFrac =
        qi.remainingFraction !== undefined &&
        qi.remainingFraction !== null &&
        Number.isFinite(Number(qi.remainingFraction));
      const remainingFrac = hasFrac
        ? Math.max(0, Math.min(1, Number(qi.remainingFraction)))
        : resetTime
          ? 0
          : 1;

      const remainingPercent = roundPercent(remainingFrac * 100);
      const usedPercent = roundPercent(100 - remainingPercent);
      const pool = classifyQuotaPool(label, rawModel);
      const windowKind = windowKindFromReset(resetInSec);

      let status = 'ok';
      if (remainingPercent <= 0) status = 'exhausted';
      else if (remainingPercent <= 20) status = 'low';

      items.push({
        id,
        label,
        model: String(rawModel || id),
        pool,
        remainingPercent,
        usedPercent,
        resetTime,
        resetInSec,
        windowKind,
        status,
      });
    }

    const pools = buildQuotaPools(items);
    const payload =
      items.length > 0
        ? {
            available: true,
            source: 'ls_rpc',
            reason: null,
            fetchedAt,
            planTier,
            credits,
            pools,
            items,
          }
        : {
            ...emptyUnavailable('Language Server did not return model quota entries'),
            planTier,
            credits,
          };
    quotaCache = { fetchedAtMs: nowMs, payload };
    return payload;
  } catch (err) {
    const payload = emptyUnavailable(
      err?.name === 'TimeoutError' ? 'Language Server RPC timed out' : 'Language Server RPC unreachable'
    );
    quotaCache = { fetchedAtMs: nowMs, payload };
    return payload;
  }
}

/**
 * Resolve which swarm & member a conversationId belongs to.
 */
function resolveConversation(swarmsById, orderedIds, conversationId) {
  if (!conversationId || !ID_RE.test(conversationId)) {
    return { activeSwarmId: null, activeMemberName: null };
  }
  const needle = conversationId.toLowerCase();
  for (const id of orderedIds) {
    const sw = swarmsById.get(id);
    if (!sw) continue;
    if (sw.id.toLowerCase() === needle) {
      const coord = sw.workers.find((w) => w.conversationId.toLowerCase() === needle);
      return { activeSwarmId: sw.id, activeMemberName: coord?.name || 'coordinator' };
    }
    const member = sw.workers.find((w) => w.conversationId.toLowerCase() === needle);
    if (member) {
      return { activeSwarmId: sw.id, activeMemberName: member.name };
    }
  }
  return { activeSwarmId: null, activeMemberName: null };
}

/**
 * Build the `GET /api/overview` payload.
 */
export async function getOverview({ conversationId = null, force = false } = {}) {
  const scan = scanSwarms({ force });
  const rawQuotas = await probeQuotas({ force });
  const quotas = {
    ...rawQuotas,
    weeklyLocalUsage: scan.weeklyLocalUsage,
  };

  const resolvedConv = conversationId && ID_RE.test(conversationId) ? conversationId : null;
  const { activeSwarmId, activeMemberName } = resolveConversation(
    scan.swarmsById,
    scan.orderedIds,
    resolvedConv
  );

  let activeSwarmCount = 0;
  let workerCount = 0;
  let activeWorkerCount = 0;
  let steps = 0;
  let plannerSteps = 0;
  let toolCalls = 0;
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let thinkingTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let totalRawCostUsd = 0;

  const list = scan.orderedIds.map((id) => scan.swarmsById.get(id)).filter(Boolean);
  for (const sw of list) {
    if (sw.status === 'active') activeSwarmCount++;
    workerCount += sw.totals.workerCount;
    activeWorkerCount += sw.totals.activeWorkerCount;
    steps += sw.totals.steps;
    plannerSteps += sw.totals.plannerSteps;
    toolCalls += sw.totals.toolCalls;
    inputTokens += sw.totals.inputTokens;
    cacheReadTokens += sw.totals.cacheReadTokens;
    thinkingTokens += sw.totals.thinkingTokens;
    outputTokens += sw.totals.outputTokens;
    totalTokens += sw.totals.totalTokens;
    totalRawCostUsd += sw.totals._rawCostUsd;
  }

  const swarms = list.map((sw) => ({
    id: sw.id,
    title: sw.title,
    kind: sw.kind,
    isActiveConversation: Boolean(activeSwarmId && sw.id === activeSwarmId),
    status: sw.status,
    workerCount: sw.totals.workerCount,
    activeWorkerCount: sw.totals.activeWorkerCount,
    killedWorkerCount: sw.totals.killedWorkerCount,
    steps: sw.totals.steps,
    plannerSteps: sw.totals.plannerSteps,
    toolCalls: sw.totals.toolCalls,
    inputTokens: sw.totals.inputTokens,
    cacheReadTokens: sw.totals.cacheReadTokens,
    thinkingTokens: sw.totals.thinkingTokens,
    outputTokens: sw.totals.outputTokens,
    totalTokens: sw.totals.totalTokens,
    estimatedCostUsd: sw.totals.estimatedCostUsd,
    costSharePercent: totalRawCostUsd > 0 ? roundPercent((sw.totals._rawCostUsd / totalRawCostUsd) * 100) : 0,
    tokenSharePercent: totalTokens > 0 ? roundPercent((sw.totals.totalTokens / totalTokens) * 100) : 0,
    tokenSource: sw.tokenSource,
    primaryModel: sw.primaryModel,
    primaryModelLabel: sw.primaryModelLabel,
    models: sw.modelIds,
    startedAt: sw.startedAt,
    lastActiveAt: sw.lastActiveAt,
    boardMessages: sw.boardMessages,
  }));

  return {
    generatedAt: new Date().toISOString(),
    cached: scan.cached,
    activeConversationId: resolvedConv,
    activeSwarmId,
    activeMemberName,
    totals: {
      swarmCount: swarms.length,
      activeSwarmCount,
      workerCount,
      activeWorkerCount,
      steps,
      plannerSteps,
      toolCalls,
      inputTokens,
      cacheReadTokens,
      thinkingTokens,
      outputTokens,
      totalTokens,
      estimatedCostUsd: roundUsd(totalRawCostUsd),
    },
    swarms,
    quotas,
  };
}

/**
 * Build the `GET /api/swarm?id=...` and `GET /api/swarms/:id` payload.
 */
export function getSwarmDetail({ id = '', conversationId = '', force = false } = {}) {
  const scan = scanSwarms({ force });
  let targetId = typeof id === 'string' ? id.trim() : '';

  if (!targetId && conversationId) {
    const resolved = resolveConversation(scan.swarmsById, scan.orderedIds, conversationId);
    targetId = resolved.activeSwarmId || '';
  }

  let sw = targetId ? scan.swarmsById.get(targetId) : null;
  if (!sw && targetId) {
    // Allow resolving by a worker conversationId passed as id.
    const resolved = resolveConversation(scan.swarmsById, scan.orderedIds, targetId);
    if (resolved.activeSwarmId) {
      sw = scan.swarmsById.get(resolved.activeSwarmId) || null;
    }
  }

  if (!sw) return null;

  return {
    generatedAt: new Date().toISOString(),
    id: sw.id,
    title: sw.title,
    kind: sw.kind,
    status: sw.status,
    startedAt: sw.startedAt,
    lastActiveAt: sw.lastActiveAt,
    boardMessages: sw.boardMessages,
    tokenSource: sw.tokenSource,
    totals: {
      workerCount: sw.totals.workerCount,
      activeWorkerCount: sw.totals.activeWorkerCount,
      steps: sw.totals.steps,
      plannerSteps: sw.totals.plannerSteps,
      toolCalls: sw.totals.toolCalls,
      inputTokens: sw.totals.inputTokens,
      cacheReadTokens: sw.totals.cacheReadTokens,
      thinkingTokens: sw.totals.thinkingTokens,
      outputTokens: sw.totals.outputTokens,
      totalTokens: sw.totals.totalTokens,
      estimatedCostUsd: sw.totals.estimatedCostUsd,
    },
    workers: sw.workers,
    models: sw.models,
    timeline: sw.timeline,
  };
}

function cleanSnippet(text, maxLen = 60) {
  if (typeof text !== 'string' || !text.trim()) return '';
  let s = text
    .replace(/<USER_REQUEST>[\s\S]*$/i, (m) => m.replace(/<\/?USER_REQUEST>/gi, ''))
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > maxLen) s = s.slice(0, maxLen - 1) + '…';
  return s;
}

function summarizeStepForContext(step, idx) {
  if (step.type === 'USER_INPUT') {
    const snippet = extractUserPromptSnippet(step.content) || cleanSnippet(step.content, 56);
    return { category: 'user', label: snippet || `User #${idx + 1}` };
  }
  if (step.type === 'SYSTEM_MESSAGE') {
    const snippet = cleanSnippet(step.content, 56);
    return { category: 'system_msg', label: snippet || `System #${idx + 1}` };
  }
  if (step.type === 'GENERIC') {
    const snippet = cleanSnippet(step.content, 56);
    return { category: 'tool_outputs', label: snippet || `Tool output #${idx + 1}` };
  }
  if (step.type === 'PLANNER_RESPONSE') {
    const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
    const callNames = calls.map((c) => c?.name).filter(Boolean);
    if (callNames.length) {
      const uniq = [...new Set(callNames)];
      const head = uniq.slice(0, 3).join(', ') + (uniq.length > 3 ? ` +${uniq.length - 3}` : '');
      return { category: 'tool_outputs', label: `Calls: ${head}` };
    }
    const snippet = cleanSnippet(step.content, 56);
    return { category: 'assistant', label: snippet || `Assistant #${idx + 1}` };
  }
  return { category: 'system_msg', label: step.type || `Step #${idx + 1}` };
}

const BUILTIN_TOOL_DEFS = [
  { name: 'swarm', tokens: 780, description: 'Manage multi-agent swarm board, workers, models, and workspaces' },
  { name: 'update_steps', tokens: 450, description: 'Live task checklist tracker shown to the user' },
  { name: 'search_marketplace', tokens: 380, description: 'Search Agent Marketplace catalog for plugins and skills' },
  { name: 'run_command', tokens: 330, description: 'Execute terminal commands in the workspace shell' },
  { name: 'schedule', tokens: 310, description: 'Schedule one-shot timers or recurring cron jobs' },
  { name: 'invoke_subagent', tokens: 300, description: 'Launch an isolated background subagent with its own prompt' },
  { name: 'write_file', tokens: 260, description: 'Create, overwrite, or append files and artifacts' },
  { name: 'edit_file', tokens: 250, description: 'Perform targeted single-block replacements in existing files' },
  { name: 'run_workflow', tokens: 220, description: 'Execute Python multi-agent orchestration workflow scripts' },
  { name: 'swarm_wait', tokens: 185, description: 'Sleep until another swarm member posts to the message board' },
  { name: 'read_board', tokens: 170, description: 'Read messages and roster status from the swarm board' },
  { name: 'list_plugin_accounts', tokens: 165, description: 'List authenticated accounts for installed plugins' },
  { name: 'update_focus', tokens: 155, description: 'Update the live high-level status summary in the UI' },
  { name: 'manage_task', tokens: 150, description: 'List, inspect, send input to, or kill background tasks' },
  { name: 'read_file', tokens: 145, description: 'Read text, image, PDF, video, or audio files with line bounds' },
  { name: 'ask_question', tokens: 140, description: 'Ask the user structured multiple-choice clarification questions' },
  { name: 'exit_plan_mode', tokens: 140, description: 'Submit finalized plan and switch to execution turn' },
  { name: 'define_subagent', tokens: 125, description: 'Define a reusable custom subagent type with tool permissions' },
  { name: 'manage_subagents', tokens: 120, description: 'List or terminate active direct subagents' },
  { name: 'search_web', tokens: 85, description: 'Search the web for documentation, APIs, and facts' },
  { name: 'send_message', tokens: 80, description: 'Send a direct message to another agent or subagent' },
  { name: 'post_message', tokens: 70, description: 'Post a message onto the shared swarm board' },
];

function sanitizeDefDescription(text, maxLen = 100) {
  if (typeof text !== 'string' || !text.trim()) return '';
  let s = text
    .replace(/[A-Za-z]:\\[^\s)'"`]+/g, '<path>')
    .replace(/\/(?:Users|home)\/[^\s)'"`]+/g, '<path>')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > maxLen) s = s.slice(0, maxLen - 1) + '…';
  return s;
}

function parseFrontmatterMeta(mdText) {
  if (typeof mdText !== 'string') return { name: '', description: '' };
  const m = mdText.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return { name: '', description: '' };
  const yaml = m[1];
  let name = '';
  let description = '';
  const nameMatch = yaml.match(/^name:\s*(.+)$/m);
  if (nameMatch) name = nameMatch[1].trim().replace(/^["']|["']$/g, '');
  const lines = yaml.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const dm = lines[i].match(/^description:\s*(.*)$/);
    if (!dm) continue;
    const first = dm[1].trim();
    if (first === '>' || first === '>-' || first === '|' || first === '|-') {
      const acc = [];
      for (let j = i + 1; j < lines.length; j++) {
        if (/^\s+/.test(lines[j])) acc.push(lines[j].trim());
        else break;
      }
      description = acc.join(' ');
    } else {
      description = first.replace(/^["']|["']$/g, '');
    }
    break;
  }
  return { name, description };
}

function scanSkillsInDir(skillsDir, group, seenNames, out) {
  for (const dirName of safeReaddir(skillsDir)) {
    const mdPath = join(skillsDir, dirName, 'SKILL.md');
    const txt = safeReadUtf8(mdPath);
    if (!txt) continue;
    const meta = parseFrontmatterMeta(txt);
    const name = meta.name || dirName;
    if (seenNames.has(name)) continue;
    seenNames.add(name);
    const headerLine = `- ${name} (${mdPath}): ${meta.description || ''}`;
    out.push({
      id: `skill:${group}:${name}`,
      name,
      kind: 'skill',
      group,
      tokens: estimateTokensFromText(headerLine),
      bodyTokens: estimateTokensFromText(txt),
      source: 'measured',
      description: sanitizeDefDescription(meta.description || ''),
      matchPaths: [mdPath.replace(/\\/g, '/').toLowerCase()],
    });
  }
}

async function collectToolDefinitions({ force = false } = {}) {
  const nowMs = Date.now();
  if (!force && toolDefsCache.items && nowMs - toolDefsCache.fetchedAtMs < TOOL_DEFS_TTL_MS) {
    return toolDefsCache.items;
  }

  const items = [];
  for (const t of BUILTIN_TOOL_DEFS) {
    items.push({
      id: `builtin:${t.name}`,
      name: t.name,
      kind: 'builtin_tool',
      group: 'builtin',
      tokens: t.tokens,
      bodyTokens: 0,
      source: 'builtin_ref',
      description: t.description,
      matchPaths: [],
    });
  }

  const seenSkillNames = new Set();
  const seenRulePaths = new Set();
  const seenMcpKeys = new Set();
  let gotPluginsFromLs = false;

  const lsAddr = process.env.ANTIGRAVITY_LS_ADDRESS;
  const csrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
  if (lsAddr && csrf) {
    try {
      const base = lsAddr.startsWith('http://') || lsAddr.startsWith('https://') ? lsAddr : `http://${lsAddr}`;
      const res = await fetch(`${base}/exa.language_server_pb.LanguageServerService/GetAllPlugins`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-codeium-csrf-token': csrf },
        body: '{}',
        signal: AbortSignal.timeout(QUOTA_TIMEOUT_MS),
      });
      if (res.ok) {
        const data = await res.json();
        const plugins = Array.isArray(data?.plugins) ? data.plugins : [];
        gotPluginsFromLs = true;
        for (const p of plugins) {
          if (!p || p.disabled) continue;
          const group = p.name || 'plugin';

          for (const s of Array.isArray(p.skills) ? p.skills : []) {
            if (!s?.name || seenSkillNames.has(s.name)) continue;
            seenSkillNames.add(s.name);
            const sPath = typeof s.path === 'string' ? s.path : '';
            const headerLine = `- ${s.name}${sPath ? ` (${sPath})` : ''}: ${s.description || ''}`;
            items.push({
              id: `skill:${group}:${s.name}`,
              name: s.name,
              kind: 'skill',
              group,
              tokens: estimateTokensFromText(headerLine),
              bodyTokens: estimateTokensFromText(typeof s.content === 'string' ? s.content : ''),
              source: 'measured',
              description: sanitizeDefDescription(s.description || ''),
              matchPaths: sPath ? [sPath.replace(/\\/g, '/').toLowerCase()] : [],
            });
          }

          for (const r of Array.isArray(p.rules) ? p.rules : []) {
            const abs = typeof r?.absolutePath === 'string' ? r.absolutePath : '';
            if (!abs || seenRulePaths.has(abs.toLowerCase())) continue;
            seenRulePaths.add(abs.toLowerCase());
            const content = safeReadUtf8(abs);
            if (!content) continue;
            const rName = basename(abs);
            items.push({
              id: `rule:${group}:${rName}`,
              name: rName,
              kind: 'rule',
              group,
              tokens: estimateTokensFromText(content),
              bodyTokens: 0,
              source: 'measured',
              description: sanitizeDefDescription(content.slice(0, 140)),
              matchPaths: [abs.replace(/\\/g, '/').toLowerCase()],
            });
          }

          for (const m of Array.isArray(p.mcpServers) ? p.mcpServers : []) {
            const mName = m?.serverName || m?.originalServerName || '';
            if (!mName || seenMcpKeys.has(mName.toLowerCase())) continue;
            seenMcpKeys.add(mName.toLowerCase());
            items.push({
              id: `mcp:${group}:${mName}`,
              name: m.originalServerName || mName,
              kind: 'mcp',
              group,
              tokens: 400,
              bodyTokens: 0,
              source: 'estimated',
              description: sanitizeDefDescription(`MCP server from plugin ${group}`),
              matchPaths: [],
              mcpServerPrefix: mName,
            });
          }
        }
      }
    } catch {
      // Fall back to disk discovery below.
    }
  }

  const configRoot = join(homedir(), '.gemini', 'config');
  if (!gotPluginsFromLs) {
    const pluginsDir = join(configRoot, 'plugins');
    for (const pDir of safeReaddir(pluginsDir)) {
      const pRoot = join(pluginsDir, pDir);
      const manifestRaw = safeReadUtf8(join(pRoot, 'plugin.json'));
      let pName = pDir;
      if (manifestRaw) {
        try {
          const pj = JSON.parse(manifestRaw);
          if (pj?.disabled) continue;
          if (typeof pj?.name === 'string' && pj.name.trim()) pName = pj.name.trim();
        } catch {
          // Ignore malformed JSONC/JSON.
        }
      }
      scanSkillsInDir(join(pRoot, 'skills'), pName, seenSkillNames, items);
      const ruleFile = join(pRoot, 'rules', 'AGENTS.md');
      if (!seenRulePaths.has(ruleFile.toLowerCase())) {
        const rTxt = safeReadUtf8(ruleFile);
        if (rTxt) {
          seenRulePaths.add(ruleFile.toLowerCase());
          items.push({
            id: `rule:${pName}:AGENTS.md`,
            name: 'AGENTS.md',
            kind: 'rule',
            group: pName,
            tokens: estimateTokensFromText(rTxt),
            bodyTokens: 0,
            source: 'measured',
            description: sanitizeDefDescription(rTxt.slice(0, 140)),
            matchPaths: [],
          });
        }
      }
    }
  }

  // Scan built-in skills and standalone user skills/rules/MCP on disk.
  for (const appData of findAppDataDirs()) {
    scanSkillsInDir(join(appData, 'builtin', 'skills'), 'builtin', seenSkillNames, items);
  }
  scanSkillsInDir(join(configRoot, 'skills'), 'user', seenSkillNames, items);

  for (const rName of ['GEMINI.md', 'AGENTS.md']) {
    const rp = join(configRoot, rName);
    if (seenRulePaths.has(rp.toLowerCase())) continue;
    const txt = safeReadUtf8(rp);
    if (txt && txt.trim()) {
      seenRulePaths.add(rp.toLowerCase());
      items.push({
        id: `rule:user:${rName}`,
        name: rName,
        kind: 'rule',
        group: 'user',
        tokens: estimateTokensFromText(txt),
        bodyTokens: 0,
        source: 'measured',
        description: sanitizeDefDescription(txt.slice(0, 140)),
        matchPaths: [],
      });
    }
  }

  const mcpCfgRaw = safeReadUtf8(join(configRoot, 'mcp_config.json'));
  if (mcpCfgRaw && mcpCfgRaw.trim()) {
    try {
      const cfg = JSON.parse(mcpCfgRaw);
      const servers = cfg?.mcpServers && typeof cfg.mcpServers === 'object' ? cfg.mcpServers : {};
      for (const [sName, sCfg] of Object.entries(servers)) {
        if (!sCfg || sCfg.disabled || seenMcpKeys.has(sName.toLowerCase())) continue;
        seenMcpKeys.add(sName.toLowerCase());
        items.push({
          id: `mcp:user:${sName}`,
          name: sName,
          kind: 'mcp',
          group: 'user',
          tokens: 400,
          bodyTokens: 0,
          source: 'estimated',
          description: 'User-configured MCP server',
          matchPaths: [],
          mcpServerPrefix: sName,
        });
      }
    } catch {
      // Ignore invalid mcp_config.json.
    }
  }

  toolDefsCache = { fetchedAtMs: nowMs, items };
  return items;
}

function buildToolDefinitionsSummary(baseItems, { toolCallCounts, loadedSkillPaths, usedTokens, contextWindow }) {
  const enriched = baseItems.map((it) => {
    let usedInSession = 0;
    let tokens = it.tokens;
    if (it.kind === 'builtin_tool') {
      usedInSession = toolCallCounts.get(it.name) || 0;
    } else if (it.kind === 'skill') {
      if (it.matchPaths?.some((p) => loadedSkillPaths.has(p))) {
        usedInSession = 1;
      }
    } else if (it.kind === 'mcp') {
      const prefix = (it.mcpServerPrefix || it.name || '').toLowerCase();
      let mcpTools = 0;
      for (const [tName, cnt] of toolCallCounts.entries()) {
        if (prefix && tName.toLowerCase().includes(prefix)) {
          usedInSession += cnt;
          mcpTools++;
        }
      }
      if (mcpTools > 0) tokens = Math.max(tokens, mcpTools * 220);
    }
    return {
      id: it.id,
      name: it.name,
      kind: it.kind,
      group: it.group,
      tokens,
      bodyTokens: it.bodyTokens || 0,
      usedInSession,
      source: it.source,
      description: it.description || '',
    };
  });

  const totalTokens = enriched.reduce((acc, x) => acc + x.tokens, 0);
  const counts = { total: enriched.length, builtin_tool: 0, skill: 0, rule: 0, mcp: 0 };
  const kindMap = new Map();
  const groupMap = new Map();

  for (const x of enriched) {
    if (counts[x.kind] !== undefined) counts[x.kind]++;
    const kEntry = kindMap.get(x.kind) || { kind: x.kind, count: 0, tokens: 0 };
    kEntry.count++;
    kEntry.tokens += x.tokens;
    kindMap.set(x.kind, kEntry);

    const gKey = `${x.kind}:${x.group}`;
    const gEntry = groupMap.get(gKey) || { group: x.group, kind: x.kind, count: 0, tokens: 0 };
    gEntry.count++;
    gEntry.tokens += x.tokens;
    groupMap.set(gKey, gEntry);
  }

  const byKind = [...kindMap.values()]
    .map((k) => ({
      ...k,
      percent: totalTokens > 0 ? roundPercent((k.tokens / totalTokens) * 100) : 0,
    }))
    .sort((a, b) => b.tokens - a.tokens);

  const byGroup = [...groupMap.values()]
    .map((g) => ({
      ...g,
      percent: totalTokens > 0 ? roundPercent((g.tokens / totalTokens) * 100) : 0,
    }))
    .sort((a, b) => b.tokens - a.tokens);

  const items = enriched
    .map((x) => ({
      ...x,
      shareOfDefsPercent: totalTokens > 0 ? roundPercent((x.tokens / totalTokens) * 100) : 0,
      shareOfContextPercent: usedTokens > 0 ? roundPercent((x.tokens / usedTokens) * 100) : 0,
    }))
    .sort((a, b) => b.tokens - a.tokens || b.usedInSession - a.usedInSession || a.name.localeCompare(b.name));

  return {
    totalTokens,
    shareOfContextPercent: usedTokens > 0 ? roundPercent((totalTokens / usedTokens) * 100) : 0,
    shareOfLimitPercent: contextWindow > 0 ? roundPercent((totalTokens / contextWindow) * 100) : 0,
    counts,
    byKind,
    byGroup,
    items,
  };
}

/**
 * Build the `GET /api/context?conversationId=...` payload strictly for one conversation.
 * Never falls back to another conversation if conversationId is missing or not found.
 */
export async function getConversationContext({ conversationId = '', force = false } = {}) {
  const convId = typeof conversationId === 'string' ? conversationId.trim() : '';
  const nowIso = new Date().toISOString();

  if (!convId || !ID_RE.test(convId)) {
    return {
      generatedAt: nowIso,
      available: false,
      reason: 'no_conversation',
      conversationId: null,
    };
  }

  let trPath = '';
  let st = null;
  for (const appData of findAppDataDirs()) {
    const candidate = join(appData, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');
    const stat = safeStat(candidate);
    if (stat && stat.isFile) {
      trPath = candidate;
      st = stat;
      break;
    }
  }

  if (!trPath || !st) {
    return {
      generatedAt: nowIso,
      available: false,
      reason: 'not_found',
      conversationId: convId,
    };
  }

  const statKey = `${st.mtimeMs}:${st.size}`;
  const cached = !force ? contextCache.get(trPath) : null;
  if (cached && cached.statKey === statKey) {
    return { ...cached.payload, generatedAt: nowIso, cached: true };
  }

  const text = safeReadUtf8(trPath);
  if (text === null) {
    return {
      generatedAt: nowIso,
      available: false,
      reason: 'not_found',
      conversationId: convId,
    };
  }

  const parsedSteps = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === 'object') parsedSteps.push(obj);
    } catch {
      // Skip partial trailing line while an agent is actively writing.
    }
  }

  const toolCallCounts = new Map();
  const loadedSkillPaths = new Set();

  let title = '';
  let startedMs = 0;
  let lastActiveMs = 0;
  let userTurns = 0;
  let plannerSteps = 0;
  let toolCalls = 0;
  let totalInputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalOutputTokens = 0;
  let totalCostUsd = 0;
  let lastModel = '';
  let runningContextEst = 0;

  let prevPromptTokens = 0;
  let compactionCount = 0;
  let lastCompactionStepArrIdx = -1;
  let lastCompactionAt = null;
  const history = [];
  const stepEstimates = [];

  for (let i = 0; i < parsedSteps.length; i++) {
    const step = parsedSteps[i];
    const tsMs = toMs(step.created_at);
    if (tsMs) {
      if (!startedMs || tsMs < startedMs) startedMs = tsMs;
      if (tsMs > lastActiveMs) lastActiveMs = tsMs;
    }

    const stepIdx = Number.isFinite(Number(step.step_index)) ? Number(step.step_index) : i;

    if (step.type === 'USER_INPUT') {
      userTurns++;
      if (!title && typeof step.content === 'string') {
        title = extractUserPromptSnippet(step.content) || '';
      }
      const uTok = estimateTokensFromText(step.content || '');
      runningContextEst += uTok;
      stepEstimates.push({
        arrIdx: i,
        stepIndex: stepIdx,
        type: step.type,
        timestamp: toIso(tsMs || st.mtimeMs),
        buckets: { user: uTok, assistant: 0, thinking: 0, tool_outputs: 0, system_msg: 0 },
        totalEst: uTok,
        summary: summarizeStepForContext(step, stepIdx),
      });
      continue;
    }

    if (step.type === 'SYSTEM_MESSAGE') {
      const sTok = estimateTokensFromText(step.content || '');
      runningContextEst += sTok;
      stepEstimates.push({
        arrIdx: i,
        stepIndex: stepIdx,
        type: step.type,
        timestamp: toIso(tsMs || st.mtimeMs),
        buckets: { user: 0, assistant: 0, thinking: 0, tool_outputs: 0, system_msg: sTok },
        totalEst: sTok,
        summary: summarizeStepForContext(step, stepIdx),
      });
      continue;
    }

    if (step.type === 'GENERIC') {
      const gTok = estimateTokensFromText(typeof step.content === 'string' ? step.content : '');
      runningContextEst += Math.min(25_000, gTok);
      stepEstimates.push({
        arrIdx: i,
        stepIndex: stepIdx,
        type: step.type,
        timestamp: toIso(tsMs || st.mtimeMs),
        buckets: { user: 0, assistant: 0, thinking: 0, tool_outputs: gTok, system_msg: 0 },
        totalEst: gTok,
        summary: summarizeStepForContext(step, stepIdx),
      });
      continue;
    }

    if (step.type !== 'PLANNER_RESPONSE') continue;

    plannerSteps++;
    const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
    toolCalls += calls.length;
    for (const tc of calls) {
      const tName = typeof tc?.name === 'string' ? tc.name.trim() : '';
      if (!tName) continue;
      toolCallCounts.set(tName, (toolCallCounts.get(tName) || 0) + 1);
      if (tName === 'read_file') {
        const pArg = tc?.args?.Path || tc?.arguments?.Path || tc?.input?.Path || '';
        if (typeof pArg === 'string' && pArg.toLowerCase().endsWith('skill.md')) {
          loadedSkillPaths.add(pArg.replace(/\\/g, '/').toLowerCase());
        }
      }
    }

    const stepModel =
      (typeof step.model === 'string' && step.model.trim()) ||
      lastModel ||
      'unknown';
    if (stepModel && stepModel !== 'unknown') lastModel = stepModel;
    const pricing = resolveModelPricing(stepModel);

    const hasExactInput =
      Number.isFinite(Number(step.input_tokens)) &&
      step.input_tokens !== null &&
      step.input_tokens !== undefined;
    const hasExactOutput =
      Number.isFinite(Number(step.output_tokens)) &&
      step.output_tokens !== null &&
      step.output_tokens !== undefined;
    const isExact = hasExactInput || hasExactOutput;

    const estThink = estimateTokensFromText(typeof step.thinking === 'string' ? step.thinking : '');
    const estAssistant = estimateTokensFromText(typeof step.content === 'string' ? step.content : '');
    const estToolCalls = estimateTokensFromText(serializeToolCalls(calls));

    let stepIn = 0;
    let stepCache = 0;
    let stepOut = 0;
    let stepThink = estThink;

    if (isExact) {
      stepIn = Math.max(0, Math.round(Number(step.input_tokens) || 0));
      stepCache = Math.max(0, Math.round(Number(step.cache_read_tokens) || 0));
      stepOut = Math.max(0, Math.round(Number(step.output_tokens) || 0));
      if (Number.isFinite(Number(step.thinking_tokens)) && step.thinking_tokens !== null && step.thinking_tokens !== undefined) {
        stepThink = Math.min(stepOut, Math.max(0, Math.round(Number(step.thinking_tokens))));
      } else {
        stepThink = Math.min(stepOut, estThink);
      }
      runningContextEst = stepIn + stepCache + stepOut;
    } else {
      stepOut = estThink + estAssistant + estToolCalls;
      stepIn = Math.max(500, Math.min(200_000, Math.round(runningContextEst)));
      stepCache = 0;
      runningContextEst += stepOut;
    }

    const promptTokens = stepIn + stepCache;
    const totalContextTokens = promptTokens + stepOut;
    const cacheHitPercent = promptTokens > 0 ? roundPercent((stepCache / promptTokens) * 100) : 0;
    const cost = computeStepCost(stepModel, {
      inputTokens: stepIn,
      cacheReadTokens: stepCache,
      outputTokens: stepOut,
      thinkingTokens: stepThink,
    });

    let compacted = false;
    if (prevPromptTokens > 8000 && promptTokens < prevPromptTokens * 0.7) {
      compacted = true;
      compactionCount++;
      lastCompactionStepArrIdx = i;
      lastCompactionAt = toIso(tsMs || st.mtimeMs);
    }
    prevPromptTokens = promptTokens;

    totalInputTokens += stepIn;
    totalCacheReadTokens += stepCache;
    totalOutputTokens += stepOut;
    totalCostUsd += cost.totalUsd;

    history.push({
      turn: history.length + 1,
      stepIndex: stepIdx,
      timestamp: toIso(tsMs || st.mtimeMs),
      model: stepModel,
      modelLabel: formatModelLabel(stepModel),
      modelFamily: pricing.family,
      freshInputTokens: stepIn,
      cacheReadTokens: stepCache,
      promptTokens,
      outputTokens: stepOut,
      totalContextTokens,
      cacheHitPercent,
      stepCostUsd: roundUsd(cost.totalUsd),
      compacted,
      tokenSource: isExact ? 'exact' : 'estimated',
    });

    stepEstimates.push({
      arrIdx: i,
      stepIndex: stepIdx,
      type: step.type,
      timestamp: toIso(tsMs || st.mtimeMs),
      buckets: { user: 0, assistant: estAssistant, thinking: estThink, tool_outputs: estToolCalls, system_msg: 0 },
      totalEst: estAssistant + estThink + estToolCalls,
      summary: summarizeStepForContext(step, stepIdx),
    });
  }

  if (!lastActiveMs && st.mtimeMs) lastActiveMs = st.mtimeMs;
  if (!startedMs && lastActiveMs) startedMs = lastActiveMs;

  const lastTurn = history[history.length - 1] || null;
  const activeModel = lastTurn?.model || lastModel || 'unknown';
  const activePricing = resolveModelPricing(activeModel);
  const contextWindow = activePricing.contextWindow || 200_000;

  const freshInputTokens = lastTurn ? lastTurn.freshInputTokens : Math.max(0, Math.round(runningContextEst));
  const cacheReadTokens = lastTurn ? lastTurn.cacheReadTokens : 0;
  const promptTokens = lastTurn ? lastTurn.promptTokens : freshInputTokens;
  const outputTokens = lastTurn ? lastTurn.outputTokens : 0;
  const usedTokens = promptTokens + outputTokens;
  const remainingTokens = Math.max(0, contextWindow - usedTokens);
  const usedPercent = contextWindow > 0 ? roundPercent((usedTokens / contextWindow) * 100) : 0;
  const sessionPromptTotal = totalInputTokens + totalCacheReadTokens;

  const current = {
    model: activeModel,
    modelLabel: formatModelLabel(activeModel),
    modelFamily: activePricing.family,
    contextWindow,
    promptTokens,
    outputTokens,
    usedTokens,
    remainingTokens,
    usedPercent,
    freshInputTokens,
    cacheReadTokens,
    cacheHitPercent: promptTokens > 0 ? roundPercent((cacheReadTokens / promptTokens) * 100) : 0,
    sessionCacheHitPercent: sessionPromptTotal > 0 ? roundPercent((totalCacheReadTokens / sessionPromptTotal) * 100) : 0,
    tokenSource: lastTurn ? lastTurn.tokenSource : 'estimated',
    status: usedPercent >= 80 ? 'high' : usedPercent >= 60 ? 'warn' : 'ok',
  };

  // Build active-window composition & top token consumers after the last compaction.
  const activeSteps = stepEstimates.filter((s) => s.arrIdx >= lastCompactionStepArrIdx);
  const rawBuckets = { user: 0, assistant: 0, thinking: 0, tool_outputs: 0, system_msg: 0 };
  for (const s of activeSteps) {
    rawBuckets.user += s.buckets.user;
    rawBuckets.assistant += s.buckets.assistant;
    rawBuckets.thinking += s.buckets.thinking;
    rawBuckets.tool_outputs += s.buckets.tool_outputs;
    rawBuckets.system_msg += s.buckets.system_msg;
  }

  const rawSum =
    rawBuckets.user +
    rawBuckets.assistant +
    rawBuckets.thinking +
    rawBuckets.tool_outputs +
    rawBuckets.system_msg;

  const compTotals = { ...rawBuckets, system: 0 };
  let scaleFactor = 1;
  if (usedTokens > 0) {
    if (usedTokens >= rawSum) {
      compTotals.system = usedTokens - rawSum;
    } else if (rawSum > 0) {
      scaleFactor = usedTokens / rawSum;
      for (const k of ['user', 'assistant', 'thinking', 'tool_outputs', 'system_msg']) {
        compTotals[k] = Math.round(compTotals[k] * scaleFactor);
      }
      // Adjust largest bucket by rounding delta so sum matches usedTokens cleanly.
      const scaledSum =
        compTotals.user +
        compTotals.assistant +
        compTotals.thinking +
        compTotals.tool_outputs +
        compTotals.system_msg;
      const diff = usedTokens - scaledSum;
      if (diff !== 0) {
        const biggest = ['tool_outputs', 'assistant', 'thinking', 'user', 'system_msg'].sort(
          (a, b) => compTotals[b] - compTotals[a]
        )[0];
        compTotals[biggest] = Math.max(0, compTotals[biggest] + diff);
      }
    }
  }

  const compDenom = usedTokens > 0 ? usedTokens : rawSum;
  const composition = ['system', 'tool_outputs', 'assistant', 'thinking', 'user', 'system_msg']
    .map((key) => ({
      key,
      tokens: compTotals[key],
      percent: compDenom > 0 ? roundPercent((compTotals[key] / compDenom) * 100) : 0,
    }))
    .filter((item) => item.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens);

  const heavySteps = activeSteps
    .filter((s) => s.totalEst > 0)
    .map((s) => {
      const est = Math.round(s.totalEst * scaleFactor);
      return {
        stepIndex: s.stepIndex,
        type: s.type,
        category: s.summary.category,
        label: s.summary.label,
        estimatedTokens: est,
        sharePercent: compDenom > 0 ? roundPercent((est / compDenom) * 100) : 0,
        timestamp: s.timestamp,
      };
    })
    .sort((a, b) => b.estimatedTokens - a.estimatedTokens)
    .slice(0, 8);

  const rawDefs = await collectToolDefinitions({ force });
  const toolDefinitions = buildToolDefinitionsSummary(rawDefs, {
    toolCallCounts,
    loadedSkillPaths,
    usedTokens,
    contextWindow,
  });

  const payload = {
    generatedAt: nowIso,
    cached: false,
    available: true,
    conversationId: convId,
    title: title || `Conversation ${convId.slice(0, 8)}`,
    current,
    sessionTotals: {
      steps: parsedSteps.length,
      plannerSteps,
      userTurns,
      toolCalls,
      compactionCount,
      lastCompactionAt,
      totalInputTokens,
      totalCacheReadTokens,
      totalOutputTokens,
      totalTokens: totalInputTokens + totalCacheReadTokens + totalOutputTokens,
      estimatedCostUsd: roundUsd(totalCostUsd),
      startedAt: toIso(startedMs),
      lastActiveAt: toIso(lastActiveMs),
      title: title || `Conversation ${convId.slice(0, 8)}`,
    },
    composition,
    history,
    heavySteps,
    toolDefinitions,
  };

  if (contextCache.size >= MAX_CONTEXT_CACHE) {
    contextCache.clear();
  }
  contextCache.set(trPath, { statKey, payload });
  return payload;
}
