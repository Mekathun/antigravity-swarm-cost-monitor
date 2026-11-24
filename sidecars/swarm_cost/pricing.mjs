/**
 * Model pricing weights and token estimation utilities for Swarm Cost Monitor.
 *
 * All rates are transparent reference weights in USD per 1,000,000 tokens.
 * Exact transcript token counts (input_tokens, cache_read_tokens, output_tokens)
 * are always preferred when recorded; CJK-aware text estimation is used only as
 * a fallback for steps without recorded token telemetry.
 */

export const ESTIMATION_RULES = {
  preferExactTranscriptUsage: true,
  cjkCharsPerToken: 1.5,
  latinCharsPerToken: 4.0,
  thinkingIncludedInExactOutput: true,
};

export const PRICING_MODELS = [
  {
    id: 'gemini-4-neon',
    label: 'Gemini 4 Neon',
    family: 'gemini',
    tier: 'flagship',
    contextWindow: 1_000_000,
    inputPer1M: 2.5,
    cacheReadPer1M: 0.25,
    outputPer1M: 15.0,
    thinkingPer1M: 15.0,
    aliases: [
      'gemini-4-neon-high',
      'gemini-4-neon-medium',
      'gemini-4-neon-low',
      'gemini-4-neon',
    ],
  },
  {
    id: 'gemini-4-argon',
    label: 'Gemini 4 Argon',
    family: 'gemini',
    tier: 'pro',
    contextWindow: 1_000_000,
    inputPer1M: 1.5,
    cacheReadPer1M: 0.15,
    outputPer1M: 10.0,
    thinkingPer1M: 10.0,
    aliases: [
      'gemini-4-argon-high',
      'gemini-4-argon-medium',
      'gemini-4-argon-low',
      'gemini-4-argon',
    ],
  },
  {
    id: 'gemini-4-carbon',
    label: 'Gemini 4 Carbon',
    family: 'gemini',
    tier: 'balanced',
    contextWindow: 1_000_000,
    inputPer1M: 1.0,
    cacheReadPer1M: 0.1,
    outputPer1M: 6.0,
    thinkingPer1M: 6.0,
    aliases: [
      'gemini-4-carbon-high',
      'gemini-4-carbon-medium',
      'gemini-4-carbon-low',
      'gemini-4-carbon',
    ],
  },
  {
    id: 'gemini-4-hydrogen',
    label: 'Gemini 4 Hydrogen',
    family: 'gemini',
    tier: 'fast',
    contextWindow: 1_000_000,
    inputPer1M: 0.3,
    cacheReadPer1M: 0.03,
    outputPer1M: 1.8,
    thinkingPer1M: 1.8,
    aliases: [
      'gemini-4-hydrogen-high',
      'gemini-4-hydrogen-medium',
      'gemini-4-hydrogen-low',
      'gemini-4-hydrogen',
    ],
  },
  {
    id: 'gemini-3-8-flash',
    label: 'Gemini 3.8 Flash',
    family: 'gemini',
    tier: 'flash',
    contextWindow: 1_000_000,
    inputPer1M: 0.15,
    cacheReadPer1M: 0.015,
    outputPer1M: 0.6,
    thinkingPer1M: 0.6,
    aliases: [
      'gemini-3.8-flash',
      'gemini-3-8-flash',
      'gemini-3-flash',
      'gemini-2.5-flash',
      'gemini-flash',
    ],
  },
  {
    id: 'gemini-pro',
    label: 'Gemini Pro',
    family: 'gemini',
    tier: 'pro',
    contextWindow: 1_000_000,
    inputPer1M: 1.25,
    cacheReadPer1M: 0.125,
    outputPer1M: 10.0,
    thinkingPer1M: 10.0,
    aliases: [
      'gemini-3-pro',
      'gemini-2.5-pro',
      'gemini-pro',
    ],
  },
  {
    id: 'claude-opus-5-5',
    label: 'Claude Opus 5.5',
    family: 'claude',
    tier: 'flagship',
    contextWindow: 200_000,
    inputPer1M: 15.0,
    cacheReadPer1M: 1.5,
    outputPer1M: 75.0,
    thinkingPer1M: 75.0,
    aliases: [
      'claude-opus-5-5-high',
      'claude-opus-5-5-medium',
      'claude-opus-5-5',
      'claude-opus-4-6',
      'claude-opus-4-5',
      'claude-opus-4',
      'claude-opus',
    ],
  },
  {
    id: 'claude-sonnet-5-5',
    label: 'Claude Sonnet 5.5',
    family: 'claude',
    tier: 'pro',
    contextWindow: 200_000,
    inputPer1M: 3.0,
    cacheReadPer1M: 0.3,
    outputPer1M: 15.0,
    thinkingPer1M: 15.0,
    aliases: [
      'claude-sonnet-5-5-high',
      'claude-sonnet-5-5-medium',
      'claude-sonnet-5-5',
      'claude-sonnet-4-6',
      'claude-sonnet-4-5',
      'claude-sonnet-4',
      'claude-sonnet',
    ],
  },
  {
    id: 'claude-haiku',
    label: 'Claude Haiku',
    family: 'claude',
    tier: 'fast',
    contextWindow: 200_000,
    inputPer1M: 0.8,
    cacheReadPer1M: 0.08,
    outputPer1M: 4.0,
    thinkingPer1M: 4.0,
    aliases: [
      'claude-haiku-4-5',
      'claude-haiku-4',
      'claude-haiku',
    ],
  },
  {
    id: 'gpt-oss',
    label: 'GPT-OSS',
    family: 'gpt',
    tier: 'open',
    contextWindow: 128_000,
    inputPer1M: 0.4,
    cacheReadPer1M: 0.04,
    outputPer1M: 1.6,
    thinkingPer1M: 1.6,
    aliases: [
      'gpt-oss-120b',
      'gpt-oss-20b',
      'gpt-oss',
    ],
  },
  {
    id: 'default',
    label: 'Default Model',
    family: 'other',
    tier: 'default',
    contextWindow: 200_000,
    inputPer1M: 1.5,
    cacheReadPer1M: 0.15,
    outputPer1M: 8.0,
    thinkingPer1M: 8.0,
    aliases: ['unknown', 'default'],
  },
];

const DEFAULT_PRICING = PRICING_MODELS[PRICING_MODELS.length - 1];

// Matches CJK Unified Ideographs, Japanese Kana, Korean Hangul, and CJK/fullwidth punctuation.
const CJK_RE = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uff00-\uffef]/g;

function normalizeModelKey(rawModel) {
  return String(rawModel || '')
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-');
}

function safePositiveNumber(n) {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Resolve a raw model identifier (e.g. "claude-opus-5-5-high") to a pricing entry.
 */
export function resolveModelPricing(rawModel) {
  const key = normalizeModelKey(rawModel);
  if (!key) return DEFAULT_PRICING;

  // 1. Exact id or alias match.
  for (const entry of PRICING_MODELS) {
    if (entry.id === key || entry.aliases.includes(key)) {
      return entry;
    }
  }

  // 2. Prefix / substring match (longest match wins so specific variants beat generic ones).
  let best = null;
  let bestLen = 0;
  for (const entry of PRICING_MODELS) {
    if (entry.id === 'default') continue;
    const candidates = [entry.id, ...entry.aliases];
    for (const cand of candidates) {
      if (key.startsWith(cand) || key.includes(cand)) {
        if (cand.length > bestLen) {
          best = entry;
          bestLen = cand.length;
        }
      }
    }
  }
  if (best) return best;

  // 3. Family keyword heuristics.
  if (key.includes('neon')) return PRICING_MODELS.find((m) => m.id === 'gemini-4-neon') || DEFAULT_PRICING;
  if (key.includes('argon')) return PRICING_MODELS.find((m) => m.id === 'gemini-4-argon') || DEFAULT_PRICING;
  if (key.includes('carbon')) return PRICING_MODELS.find((m) => m.id === 'gemini-4-carbon') || DEFAULT_PRICING;
  if (key.includes('hydrogen')) return PRICING_MODELS.find((m) => m.id === 'gemini-4-hydrogen') || DEFAULT_PRICING;
  if (key.includes('flash')) return PRICING_MODELS.find((m) => m.id === 'gemini-3-8-flash') || DEFAULT_PRICING;
  if (key.includes('opus')) return PRICING_MODELS.find((m) => m.id === 'claude-opus-5-5') || DEFAULT_PRICING;
  if (key.includes('sonnet')) return PRICING_MODELS.find((m) => m.id === 'claude-sonnet-5-5') || DEFAULT_PRICING;
  if (key.includes('haiku')) return PRICING_MODELS.find((m) => m.id === 'claude-haiku') || DEFAULT_PRICING;
  if (key.includes('gpt')) return PRICING_MODELS.find((m) => m.id === 'gpt-oss') || DEFAULT_PRICING;
  if (key.includes('gemini')) return PRICING_MODELS.find((m) => m.id === 'gemini-pro') || DEFAULT_PRICING;

  return DEFAULT_PRICING;
}

/**
 * Format a raw model string into a concise human-readable label.
 * Example: "claude-opus-5-5-high" -> "Claude Opus 5.5 (High)"
 */
export function formatModelLabel(rawModel) {
  const key = normalizeModelKey(rawModel);
  if (!key || key === 'unknown') return 'Unknown Model';

  const pricing = resolveModelPricing(key);
  let effort = '';
  if (/(?:^|-)high$/.test(key)) effort = 'High';
  else if (/(?:^|-)medium$/.test(key) || /(?:^|-)med$/.test(key)) effort = 'Medium';
  else if (/(?:^|-)low$/.test(key)) effort = 'Low';

  if (pricing.id !== 'default') {
    return effort ? `${pricing.label} (${effort})` : pricing.label;
  }

  // Fallback title-case for unrecognized custom models.
  return String(rawModel)
    .trim()
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => (part.length <= 2 ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1)))
    .join(' ');
}

/**
 * CJK-aware token estimation (~1.5 chars/token for CJK, ~4 chars/token for Latin/ASCII).
 */
export function estimateTokensFromText(text) {
  if (typeof text !== 'string' || !text.length) return 0;
  const cjkMatches = text.match(CJK_RE);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  const otherCount = Math.max(0, text.length - cjkCount);
  const est =
    cjkCount / ESTIMATION_RULES.cjkCharsPerToken +
    otherCount / ESTIMATION_RULES.latinCharsPerToken;
  return Math.max(0, Math.ceil(est));
}

/**
 * Compute USD cost breakdown for one planner step.
 *
 * Invariant: outputTokens always includes thinkingTokens (when exact, transcript
 * output_tokens already includes thinking; when estimated, outputTokens =
 * visibleOutput + thinkingTokens). This guarantees totalTokens = inputTokens +
 * cacheReadTokens + outputTokens without double-counting.
 */
export function computeStepCost(rawModel, usage) {
  const pricing = resolveModelPricing(rawModel);
  const inputTokens = safePositiveNumber(usage?.inputTokens);
  const cacheReadTokens = safePositiveNumber(usage?.cacheReadTokens);
  const outputTokens = safePositiveNumber(usage?.outputTokens);
  const thinkingTokens = Math.min(outputTokens, safePositiveNumber(usage?.thinkingTokens));
  const visibleOutputTokens = Math.max(0, outputTokens - thinkingTokens);

  const inputUsd = (inputTokens / 1_000_000) * pricing.inputPer1M;
  const cacheReadUsd = (cacheReadTokens / 1_000_000) * pricing.cacheReadPer1M;
  const outputUsd =
    (visibleOutputTokens / 1_000_000) * pricing.outputPer1M +
    (thinkingTokens / 1_000_000) * pricing.thinkingPer1M;
  const totalUsd = inputUsd + cacheReadUsd + outputUsd;

  return {
    pricing,
    inputUsd,
    cacheReadUsd,
    outputUsd,
    totalUsd,
  };
}

/**
 * Round USD figures to 6 decimal places to keep JSON clean and free of float noise.
 */
export function roundUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 1_000_000) / 1_000_000;
}

/**
 * Round percentage figures to 2 decimal places, clamped to [0, 100].
 */
export function roundPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n >= 100) return 100;
  return Math.round(n * 100) / 100;
}

/**
 * Return the full `/api/pricing` payload.
 */
export function getPricingTable() {
  return {
    currency: 'USD',
    unit: 'per_1m_tokens',
    notes:
      'Reference USD per 1M token weights used for relative cost attribution across Swarm workers. ' +
      'Exact transcript input_tokens, cache_read_tokens, and output_tokens are used whenever present; ' +
      'cache_read_tokens are weighted at 10% of fresh input rates.',
    estimationRules: { ...ESTIMATION_RULES },
    models: PRICING_MODELS.map((m) => ({
      id: m.id,
      label: m.label,
      family: m.family,
      tier: m.tier,
      contextWindow: m.contextWindow || 200_000,
      inputPer1M: m.inputPer1M,
      cacheReadPer1M: m.cacheReadPer1M,
      outputPer1M: m.outputPer1M,
      thinkingPer1M: m.thinkingPer1M,
      aliases: [...m.aliases],
    })),
  };
}
