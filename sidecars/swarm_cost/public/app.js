/*
 * Swarm Cost Monitor — aux-pane frontend (classic IIFE, zero deps).
 *
 * Data flow
 *   GET /api/overview?conversationId=<conv>[&force=1]   -> KPIs, swarm list, quotas
 *   GET /api/swarm?id=<swarmId>[&force=1]               -> worker / model / timeline breakdown
 *   GET /api/pricing                                    -> estimation drawer (lazy)
 *
 * Rendering is plain string templates + delegated events. Every refresh
 * re-renders, while UI state (selection, metric, sort, expanded rows, hover)
 * lives in `state` so nothing jumps under the user's pointer.
 */
(() => {
'use strict';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const currentConv = () => window.sidecar?.conversationId || params.get('conversationId') || '';

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */
const state = {
  overview: null,
  details: new Map(),      // swarmId -> detail payload
  detailErr: new Map(),    // swarmId -> error message
  selectedId: params.get('swarm') || null,
  userPicked: !!params.get('swarm'),
  metric: 'cost',          // cost | tokens | steps
  sort: 'share',           // share | cost | tokens | steps | name | recent
  swarmFilter: 'all',      // all | swarm | subagent_tree
  expanded: new Set(),
  hl: null,                // highlighted worker name
  hlSwarm: null,           // highlighted swarm id
  paused: false,
  intervalMs: 5000,
  timer: 0,
  inflight: false,
  reqSeq: 0,
  lastOk: 0,
  lastErr: null,
  fetchedAt: 0,            // performance clock of last overview (for countdowns)
  pricing: null,
  firstLoad: true,
  settings: { quotaWidgetSize: 'mini', showWeeklyQuota: false, language: 'zh', updatedAt: null },
  settingsOpen: false,
  modelsOpen: false,
  spTimer: 0,
  lastQuotaSig: '',
  quotaAnimateNext: false,
  tab: params.get('tab') === 'context' ? 'context' : 'swarm',
  context: null,
  contextErr: null,
  lastContextSig: '',
};

const VALID_QSIZES = ['mini', 'compact', 'expanded'];
const VALID_LANGS = ['zh', 'en'];
const isEn = () => state.settings.language === 'en';
const L = (zh, en) => (isEn() ? en : zh);
const QSIZE_HINTS = {
  mini: () => L('双 3/4 圆环仪表，紧贴设置上方', 'Twin 3/4 arc gauges docked above Settings'),
  compact: () => L('双列紧凑进度条，带倒计时', 'Two-column compact bars with reset timers'),
  expanded: () => L('完整多横条面板，支持周用量与明细', 'Full multi-bar panel with 7d usage & breakdown'),
};

try {
  const saved = JSON.parse(localStorage.getItem('swarm-cost-monitor:prefs') || '{}');
  if (['cost', 'tokens', 'steps'].includes(saved.metric)) state.metric = saved.metric;
  if (typeof saved.sort === 'string') state.sort = saved.sort;
  if (Number.isFinite(saved.intervalMs) && saved.intervalMs >= 1000) state.intervalMs = saved.intervalMs;
  if (typeof saved.paused === 'boolean') state.paused = saved.paused;
  if (!params.get('tab') && (saved.tab === 'swarm' || saved.tab === 'context')) state.tab = saved.tab;
} catch { /* storage unavailable */ }
try {
  const s = JSON.parse(localStorage.getItem('swarm-cost-monitor:settings') || '{}');
  if (VALID_QSIZES.includes(s.quotaWidgetSize)) state.settings.quotaWidgetSize = s.quotaWidgetSize;
  if (typeof s.showWeeklyQuota === 'boolean') state.settings.showWeeklyQuota = s.showWeeklyQuota;
  if (VALID_LANGS.includes(s.language)) state.settings.language = s.language;
} catch { /* storage unavailable */ }
function savePrefs() {
  try {
    localStorage.setItem('swarm-cost-monitor:prefs', JSON.stringify({
      metric: state.metric, sort: state.sort, intervalMs: state.intervalMs, paused: state.paused, tab: state.tab,
    }));
  } catch { /* ignore */ }
}
function saveSettingsLocal() {
  try {
    localStorage.setItem('swarm-cost-monitor:settings', JSON.stringify(state.settings));
  } catch { /* ignore */ }
}

/* ------------------------------------------------------------------ */
/* Theme (mirror the builtin Swarm board: luminance of --background)   */
/* ------------------------------------------------------------------ */
function syncScheme() {
  const probe = document.createElement('span');
  probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background, #f7f7f8)';
  document.documentElement.appendChild(probe);
  const c = getComputedStyle(probe).color;
  probe.remove();
  const nums = (c.match(/[\d.]+/g) || []).map(Number);
  if (nums.length < 3) return;
  const scale = c.startsWith('color(') ? 1 : 255;
  const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
  const theme = 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.5 ? 'dark' : 'light';
  if (document.documentElement.dataset.theme !== theme) document.documentElement.dataset.theme = theme;
}
syncScheme();
new MutationObserver(syncScheme).observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v) => (Number.isFinite(+v) ? +v : 0);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function fmtUsd(v) {
  v = num(v);
  if (v === 0) return '$0.00';
  const a = Math.abs(v);
  if (a < 0.01) return '$' + v.toFixed(4);
  if (a < 1) return '$' + v.toFixed(3);
  if (a < 1000) return '$' + v.toFixed(2);
  if (a < 100000) return '$' + Math.round(v).toLocaleString('en-US');
  return '$' + (v / 1000).toFixed(1) + 'K';
}
function fmtTok(v) {
  v = num(v);
  const a = Math.abs(v);
  if (a < 1000) return String(Math.round(v));
  if (a < 1e6) return (v / 1e3).toFixed(a < 1e4 ? 2 : a < 1e5 ? 1 : 0) + 'K';
  if (a < 1e9) return (v / 1e6).toFixed(a < 1e7 ? 2 : a < 1e8 ? 1 : 0) + 'M';
  return (v / 1e9).toFixed(2) + 'B';
}
const fmtInt = (v) => Math.round(num(v)).toLocaleString('en-US');
function fmtPct(v, digits = 1) {
  v = num(v);
  if (v > 0 && v < 0.1) return '<0.1';
  return v.toFixed(v >= 99.95 || v === 0 ? 0 : digits);
}
function parseTs(t) {
  if (!t) return NaN;
  if (typeof t === 'number') return t;
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms : Date.parse(String(t).replace(' ', 'T'));
}
function fmtAgo(t) {
  const ms = parseTs(t);
  if (!Number.isFinite(ms)) return '—';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 45) return L('刚刚', 'just now');
  if (s < 3600) { const m = Math.round(s / 60); return L(`${m} 分钟前`, `${m}m ago`); }
  if (s < 86400) { const h = Math.round(s / 3600); return L(`${h} 小时前`, `${h}h ago`); }
  if (s < 86400 * 30) { const d = Math.round(s / 86400); return L(`${d} 天前`, `${d}d ago`); }
  return new Date(ms).toLocaleDateString(isEn() ? 'en-US' : 'zh-CN');
}
function fmtClock(t) {
  const ms = parseTs(t);
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  const now = new Date();
  const same = d.toDateString() === now.toDateString();
  const hm = d.toLocaleTimeString(isEn() ? 'en-US' : 'zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  return same ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}
function fmtDuration(sec) {
  sec = Math.max(0, Math.round(num(sec)));
  if (sec < 60) return L(`${sec} 秒`, `${sec}s`);
  const m = Math.floor(sec / 60);
  if (m < 60) return L(`${m} 分钟`, `${m}m`);
  const h = Math.floor(m / 60);
  if (h < 48) return L(`${h} 小时 ${m % 60} 分`, `${h}h ${m % 60}m`);
  const d = Math.floor(h / 24);
  return L(`${d} 天 ${h % 24} 小时`, `${d}d ${h % 24}h`);
}
function fmtDurationShort(sec) {
  sec = Math.max(0, Math.round(num(sec)));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h}h${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d${h % 24}h` : `${d}d`;
}
function fmtSpan(a, b) {
  const s = parseTs(a), e = parseTs(b);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) return '';
  return fmtDuration((e - s) / 1000);
}
const icon = (id, cls = '') => `<svg class="icon ${cls}" aria-hidden="true"><use href="#${id}"/></svg>`;

/* Colours ------------------------------------------------------------ */
const PALETTE = ['#5b8def', '#e8875b', '#2fae8e', '#a774e0', '#d9a52b', '#e0607e', '#3fb2d6', '#8aa83a', '#c46bc0', '#7f8ea3', '#d2694a', '#4a9f6a'];
const FAMILY_COLOR = { claude: '#d97757', gemini: '#4c8df6', gpt: '#10a37f', other: '#8a94a6' };
const ROLE_COLOR = { coordinator: '#5b8def' };

function workerColors(workers) {
  // Stable per swarm: coordinator first, then by name (independent of sort / metric).
  const names = workers.map((w) => w.name).sort((a, b) => {
    if (a === 'coordinator') return -1;
    if (b === 'coordinator') return 1;
    return a.localeCompare(b);
  });
  const map = new Map();
  let i = 0;
  for (const n of names) {
    if (ROLE_COLOR[n]) { map.set(n, ROLE_COLOR[n]); continue; }
    let c = PALETTE[i % PALETTE.length];
    if (c === ROLE_COLOR.coordinator && names.includes('coordinator')) { i++; c = PALETTE[i % PALETTE.length]; }
    map.set(n, c);
    i++;
  }
  return map;
}
function modelColors(models) {
  const seen = {};
  const map = new Map();
  for (const m of models) {
    const fam = FAMILY_COLOR[m.modelFamily] ? m.modelFamily : 'other';
    const k = seen[fam] = (seen[fam] ?? -1) + 1;
    const base = FAMILY_COLOR[fam];
    map.set(m.model, k === 0 ? base : `color-mix(in srgb, ${base} ${Math.max(40, 100 - k * 22)}%, var(--c-fg))`);
  }
  return map;
}
const familyColor = (fam) => FAMILY_COLOR[fam] || FAMILY_COLOR.other;

/* Labels -------------------------------------------------------------- */
function srcInfo(s) {
  if (s === 'exact') return { cls: 'exact', label: L('精确', 'Exact'), tip: L('来自 transcript 的精确 usage 计数', 'Exact usage counts from transcript') };
  if (s === 'mixed') return { cls: 'mixed', label: L('混合', 'Mixed'), tip: L('部分步骤为精确计数，部分为字符估算', 'Mix of exact usage and estimated steps') };
  return { cls: 'est', label: L('估算', 'Est.'), tip: L('无 usage 字段，按字符数估算（CJK ≈1.5 字/Token，ASCII ≈4 字/Token）', 'Estimated from text length (CJK ~1.5 ch/tok, ASCII ~4 ch/tok)') };
}
const srcBadge = (s) => {
  const d = srcInfo(s);
  return `<span class="badge ${d.cls}" data-tip="${esc(d.label + '\n' + d.tip)}">${d.label}</span>`;
};
const swarmStatusLabel = (st) => ({ active: L('活跃', 'Active'), idle: L('空闲', 'Idle'), completed: L('已完成', 'Done') }[st] || st || '');
const workerStateLabel = (st) => ({ working: L('运行中', 'Working'), waiting: L('等待中', 'Waiting'), killed: L('已终止', 'Killed'), unknown: L('未知', 'Unknown') }[st] || L('未知', 'Unknown'));
const kindLabel = (k) => (k === 'subagent_tree' ? L('子代理树', 'Subagent Tree') : 'Swarm');
const metricInfo = (k) => ({
  cost: { label: L('费用占比', 'Cost Share'), short: L('费用', 'Cost'), unit: '$' },
  tokens: { label: L('Token 占比', 'Token Share'), short: 'Token', unit: 'tok' },
  steps: { label: L('步数与工具调用', 'Steps & Tools'), short: L('步数', 'Steps'), unit: L('步', 'steps') },
}[k] || { label: L('费用占比', 'Cost Share'), short: L('费用', 'Cost'), unit: '$' });

/** Value + share of a worker / swarm / model row under the current metric. */
function metricOf(row, metric, siblings) {
  if (metric === 'cost') return { v: num(row.estimatedCostUsd), pct: shareOf(row, 'costSharePercent', 'estimatedCostUsd', siblings) };
  if (metric === 'tokens') return { v: num(row.totalTokens), pct: shareOf(row, 'tokenSharePercent', 'totalTokens', siblings) };
  const stepKey = row.steps != null ? 'steps' : 'plannerSteps';
  return { v: num(row[stepKey]), pct: shareOf(row, 'stepSharePercent', stepKey, siblings) };
}
function shareOf(row, pctKey, valKey, siblings) {
  if (Number.isFinite(row[pctKey])) return row[pctKey];
  const tot = (siblings || []).reduce((a, r) => a + num(r[valKey]), 0);
  return tot > 0 ? (num(row[valKey]) / tot) * 100 : 0;
}
const fmtMetric = (metric, v) => (metric === 'cost' ? fmtUsd(v) : metric === 'tokens' ? fmtTok(v) : fmtInt(v) + L(' 步', ' steps'));

/** Split tokens into input / cache / thinking / visible-output segments (no double counting). */
function tokenParts(r) {
  const input = num(r.inputTokens), cache = num(r.cacheReadTokens), output = num(r.outputTokens), think = num(r.thinkingTokens);
  const total = num(r.totalTokens) || input + cache + output;
  // Thinking is normally contained in output (exact usage). If the total clearly
  // counts it separately, treat it as its own bucket.
  const separate = think > 0 && total >= input + cache + output + think - 1;
  const th = separate ? think : Math.min(think, output);
  const out = separate ? output : Math.max(0, output - th);
  return { input, cache, think: th, out, total: input + cache + th + out };
}
function splitBar(r) {
  const p = tokenParts(r);
  if (!p.total) return '<span class="split"></span>';
  const seg = (v, cls, name) => (v > 0 ? `<span class="${cls}" style="flex:${v} 1 0" data-tip="${esc(`${name}\n${fmtTok(v)} · ${fmtPct((v / p.total) * 100)}%`)}"></span>` : '');
  return `<span class="split">${seg(p.input, 'in', 'Input')}${seg(p.cache, 'cache', 'Cache Read')}${seg(p.think, 'th', 'Thinking')}${seg(p.out, 'out', 'Output')}</span>`;
}

/* ------------------------------------------------------------------ */
/* Networking                                                          */
/* ------------------------------------------------------------------ */
async function getJson(path, timeoutMs = 15000) {
  const f = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const t = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : 0;
  try {
    const res = await f(path, { method: 'GET', headers: { accept: 'application/json' }, cache: 'no-store', signal: ctl?.signal });
    let body = null;
    try { body = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok) {
      const err = new Error(body?.error || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    if (body == null) throw new Error('响应不是有效 JSON');
    return body;
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error('请求超时');
    throw e;
  } finally {
    if (t) clearTimeout(t);
  }
}

async function postJson(path, payload, timeoutMs = 10000) {
  const f = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const t = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : 0;
  try {
    const res = await f(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload),
      cache: 'no-store',
      signal: ctl?.signal,
    });
    let body = null;
    try { body = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok) {
      const err = new Error(body?.error || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return body;
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error('请求超时');
    throw e;
  } finally {
    if (t) clearTimeout(t);
  }
}

function flashSettingsStatus(msg) {
  const el = $('sp-status');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(state.spTimer);
  state.spTimer = setTimeout(() => el.classList.remove('show'), 1800);
}

function applyStaticI18n() {
  document.documentElement.lang = isEn() ? 'en' : 'zh-CN';
  document.title = L('Swarm 花费监控', 'Swarm Cost Monitor');
  const setText = (id, text) => { const el = $(id); if (el) el.textContent = text; };
  setText('brand-title', L('Swarm 花费监控', 'Swarm Cost Monitor'));
  setText('lbl-tab-swarm', L('Swarm 花费', 'Swarm Cost'));
  setText('lbl-tab-context', L('上下文窗口', 'Context Window'));
  setText('lbl-settings', L('设置', 'Settings'));
  setText('sp-title', L('监控设置', 'Monitor Settings'));
  setText('sp-size-label', L('额度显示大小', 'Quota Widget Size'));
  setText('btn-qsize-mini', L('最小', 'Mini'));
  setText('btn-qsize-compact', L('紧凑', 'Compact'));
  setText('btn-qsize-expanded', L('最大', 'Expanded'));
  setText('sp-weekly-title', L('显示周额度', 'Show Weekly Quota'));
  setText('sp-weekly-hint', L('展示官方周限状态与近 7 天本地用量', 'Official weekly window status & 7d local usage'));
  setText('sp-lang-label', L('界面语言 · Language', 'Language · 界面语言'));
  setText('drawer-title', L('估算说明 · 计价权重', 'Pricing & Estimation'));
  setText('banner-retry', L('重试', 'Retry'));
  const ref = $('btn-refresh');
  if (ref) { const lbl = L('立即刷新', 'Refresh now'); ref.title = lbl; ref.setAttribute('aria-label', lbl); }
  const info = $('btn-info');
  if (info) { const lbl = L('估算说明 / 计价权重', 'Pricing & Estimation'); info.title = lbl; info.setAttribute('aria-label', lbl); }
  if (!state.overview) setText('subtitle', L('每个 Swarm / Worker 的花费与 Token 占比', 'Per-Swarm & Worker cost, tokens, and live quotas'));
  syncPauseBtn();
}

function syncSettingsUI() {
  const { quotaWidgetSize, showWeeklyQuota, language } = state.settings;
  for (const btn of document.querySelectorAll('[data-qsize]')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.qsize === quotaWidgetSize));
  }
  for (const btn of document.querySelectorAll('[data-lang]')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.lang === language));
  }
  const hint = $('sp-size-hint');
  if (hint) hint.textContent = (QSIZE_HINTS[quotaWidgetSize] ? QSIZE_HINTS[quotaWidgetSize]() : '');
  const chk = $('opt-weekly');
  if (chk) chk.checked = !!showWeeklyQuota;
  applyStaticI18n();
}

async function loadSettings() {
  try {
    const s = await getJson('/api/settings');
    if (s && typeof s === 'object') {
      const langChanged = VALID_LANGS.includes(s.language) && s.language !== state.settings.language;
      if (VALID_QSIZES.includes(s.quotaWidgetSize)) state.settings.quotaWidgetSize = s.quotaWidgetSize;
      if (typeof s.showWeeklyQuota === 'boolean') state.settings.showWeeklyQuota = s.showWeeklyQuota;
      if (VALID_LANGS.includes(s.language)) state.settings.language = s.language;
      state.settings.updatedAt = s.updatedAt ?? null;
      saveSettingsLocal();
      syncSettingsUI();
      if (langChanged && state.overview) render();
      else renderQuota();
    }
  } catch { /* fallback to localStorage / defaults */ }
}

async function updateSettings(patch) {
  const next = { ...state.settings };
  const sizeChanged = Boolean(patch.quotaWidgetSize && VALID_QSIZES.includes(patch.quotaWidgetSize) && patch.quotaWidgetSize !== state.settings.quotaWidgetSize);
  const langChanged = Boolean(patch.language && VALID_LANGS.includes(patch.language) && patch.language !== state.settings.language);
  if (patch.quotaWidgetSize && VALID_QSIZES.includes(patch.quotaWidgetSize)) next.quotaWidgetSize = patch.quotaWidgetSize;
  if (typeof patch.showWeeklyQuota === 'boolean') next.showWeeklyQuota = patch.showWeeklyQuota;
  if (patch.language && VALID_LANGS.includes(patch.language)) next.language = patch.language;
  state.settings = next;
  if (sizeChanged) state.quotaAnimateNext = true;
  saveSettingsLocal();
  syncSettingsUI();
  if (langChanged) {
    render();
    if (!$('drawer').classList.contains('hidden')) renderDrawer();
  } else {
    renderQuota();
  }
  try {
    const saved = await postJson('/api/settings', patch);
    if (saved && typeof saved === 'object') {
      if (VALID_QSIZES.includes(saved.quotaWidgetSize)) state.settings.quotaWidgetSize = saved.quotaWidgetSize;
      if (typeof saved.showWeeklyQuota === 'boolean') state.settings.showWeeklyQuota = saved.showWeeklyQuota;
      if (VALID_LANGS.includes(saved.language)) state.settings.language = saved.language;
      state.settings.updatedAt = saved.updatedAt ?? null;
      saveSettingsLocal();
      syncSettingsUI();
    }
    flashSettingsStatus(L('已保存', 'Saved'));
  } catch {
    flashSettingsStatus(L('已存至本地', 'Saved locally'));
  }
}

async function loadContext(force = false) {
  const conv = currentConv();
  if (!conv && state.tab !== 'context') return;
  const q = new URLSearchParams();
  if (conv) q.set('conversationId', conv);
  if (force) q.set('force', '1');
  try {
    const ctx = await getJson('/api/context' + (q.toString() ? '?' + q : ''));
    state.context = ctx;
    state.contextErr = null;
  } catch (e) {
    state.contextErr = e?.message || String(e);
  }
}

async function refresh({ force = false } = {}) {
  if (state.inflight) return;
  state.inflight = true;
  clearTimeout(state.timer);
  const seq = ++state.reqSeq;
  setLive();
  $('btn-refresh').classList.add('spin');
  try {
    const q = new URLSearchParams();
    const conv = currentConv();
    if (conv) q.set('conversationId', conv);
    if (force) q.set('force', '1');
    const [ov] = await Promise.all([
      getJson('/api/overview' + (q.toString() ? '?' + q : '')),
      loadContext(force),
    ]);
    if (seq !== state.reqSeq) return;
    state.overview = ov;
    state.fetchedAt = performance.now();
    pickSelection();
    if (state.selectedId && state.tab === 'swarm') await loadDetail(state.selectedId, force);
    else if (state.selectedId && !state.details.has(state.selectedId)) await loadDetail(state.selectedId, force);
    state.lastOk = Date.now();
    state.lastErr = null;
  } catch (e) {
    state.lastErr = e?.message || String(e);
  } finally {
    state.inflight = false;
    $('btn-refresh').classList.remove('spin');
    state.firstLoad = false;
    render();
    schedule();
  }
}

async function loadDetail(id, force = false) {
  const q = new URLSearchParams({ id });
  if (force) q.set('force', '1');
  try {
    const d = await getJson('/api/swarm?' + q);
    state.details.set(id, d);
    state.detailErr.delete(id);
  } catch (e) {
    if (e?.status === 404) {
      state.details.delete(id);
      state.detailErr.set(id, '该 Swarm 已不存在');
    } else {
      state.detailErr.set(id, e?.message || String(e));
      if (!state.details.has(id)) throw e;
    }
  }
}

function isAnySessionWorking() {
  const ov = state.overview;
  if (!ov) return true;
  if (num(ov.totals?.activeWorkerCount) > 0) return true;
  return swarmsAll().some((s) => s.status === 'active');
}
function effectiveIntervalMs() {
  if (isAnySessionWorking()) return state.intervalMs;
  // Back off calmly when no session is actively working (e.g. 5s -> 30s, max 60s).
  return Math.min(60000, Math.max(state.intervalMs * 6, 30000));
}

function schedule() {
  clearTimeout(state.timer);
  if (state.paused) return;
  const baseMs = effectiveIntervalMs();
  state.timer = setTimeout(() => {
    if (document.hidden) { schedule(); return; }
    refresh();
  }, state.lastErr ? Math.min(baseMs * 2, 60000) : baseMs);
}

function swarmsAll() { return state.overview?.swarms || []; }
function pickSelection() {
  const list = swarmsAll();
  if (!list.length) { state.selectedId = null; return; }
  const has = (id) => id && list.some((s) => s.id === id);
  if (state.userPicked && has(state.selectedId)) return;
  const ov = state.overview;
  if (has(ov.activeSwarmId)) { state.selectedId = ov.activeSwarmId; return; }
  const act = list.find((s) => s.isActiveConversation);
  if (act) { state.selectedId = act.id; return; }
  if (has(state.selectedId)) return;
  const recent = [...list].sort((a, b) => (parseTs(b.lastActiveAt) || 0) - (parseTs(a.lastActiveAt) || 0));
  state.selectedId = recent[0].id;
}

async function selectSwarm(id) {
  if (!id || id === state.selectedId) return;
  state.selectedId = id;
  state.userPicked = true;
  state.expanded.clear();
  state.hl = null;
  render();
  if (!state.details.has(id)) {
    try { await loadDetail(id); } catch (e) { state.detailErr.set(id, e?.message || String(e)); }
    if (state.selectedId === id) render();
  }
}

/* ------------------------------------------------------------------ */
/* Live indicator + ticker                                             */
/* ------------------------------------------------------------------ */
function setLive() {
  const el = $('live'), lab = $('live-label');
  if (!el || !lab) return;
  el.classList.remove('paused', 'stale', 'error', 'busy');
  const active = isAnySessionWorking();
  const effMs = effectiveIntervalMs();
  const iv = Math.round(effMs / 1000) + 's';
  if (state.inflight && state.firstLoad) { el.classList.add('busy'); lab.textContent = L('加载中', 'Loading'); el.title = L('正在加载', 'Loading data'); return; }
  if (state.lastErr && !state.lastOk) { el.classList.add('error'); lab.textContent = L('连接失败', 'Offline'); el.title = state.lastErr; return; }
  const ago = state.lastOk ? Math.round((Date.now() - state.lastOk) / 1000) : 0;
  const when = state.lastOk ? new Date(state.lastOk).toLocaleTimeString(isEn() ? 'en-US' : 'zh-CN', { hour12: false }) : '';
  if (state.paused) { el.classList.add('paused'); lab.textContent = L('已暂停', 'Paused'); el.title = L(`自动刷新已暂停 · 上次更新 ${when}`, `Auto-refresh paused · Last updated ${when}`); return; }
  if (state.lastErr) { el.classList.add('stale'); lab.textContent = L(`${ago}s 前`, `${ago}s ago`); el.title = L(`刷新失败：${state.lastErr}（上次成功 ${when}）`, `Refresh failed: ${state.lastErr} (last ok ${when})`); return; }
  if (ago > Math.max(15, (effMs / 1000) * 3)) { el.classList.add('stale'); lab.textContent = L(`${ago}s 前`, `${ago}s ago`); }
  else if (!active) { el.classList.add('paused'); lab.textContent = L(`空闲 · ${iv}`, `Idle · ${iv}`); }
  else lab.textContent = L(`实时 · ${iv}`, `Live · ${iv}`);
  el.title = active
    ? L(`会话运行中，每 ${iv} 自动刷新 · 上次更新 ${when}`, `Session active, refreshing every ${iv} · Last updated ${when}`)
    : L(`当前无运行中会话，已自动降频至每 ${iv} 刷新 · 上次更新 ${when}`, `No active session — backed off to ${iv} polling · Last updated ${when}`);
}
function tick() {
  setLive();
  // Quota reset countdowns (supports full & compact short format).
  const base = state.fetchedAt;
  for (const el of document.querySelectorAll('[data-reset-sec]')) {
    const s0 = +el.dataset.resetSec;
    const left = s0 - (performance.now() - base) / 1000;
    const short = el.dataset.resetFmt === 'short';
    el.textContent = left > 0
      ? L(`${short ? fmtDurationShort(left) : fmtDuration(left)} 后重置`, `Resets in ${short ? fmtDurationShort(left) : fmtDuration(left)}`)
      : L('即将重置', 'Resetting');
  }
}
setInterval(tick, 1000);

/* ------------------------------------------------------------------ */
/* Render                                                              */
/* ------------------------------------------------------------------ */
function syncTabUI() {
  const isCtx = state.tab === 'context';
  const btnSwarm = $('tabbtn-swarm'), btnCtx = $('tabbtn-context');
  const pSwarm = $('panel-swarm'), pCtx = $('panel-context');
  if (btnSwarm) {
    btnSwarm.classList.toggle('active', !isCtx);
    btnSwarm.setAttribute('aria-selected', String(!isCtx));
    btnSwarm.tabIndex = isCtx ? -1 : 0;
  }
  if (btnCtx) {
    btnCtx.classList.toggle('active', isCtx);
    btnCtx.setAttribute('aria-selected', String(isCtx));
    btnCtx.tabIndex = isCtx ? 0 : -1;
  }
  if (pSwarm) pSwarm.classList.toggle('hidden', isCtx);
  if (pCtx) pCtx.classList.toggle('hidden', !isCtx);

  const badge = $('tab-ctx-badge');
  if (badge) {
    const cur = state.context?.available ? state.context.current : null;
    if (cur) {
      badge.className = `tab-badge num ${cur.status || 'ok'}`;
      badge.textContent = `${Math.round(num(cur.usedPercent))}%`;
    } else {
      badge.classList.add('hidden');
    }
  }
}

async function switchTab(nextTab) {
  if (nextTab !== 'swarm' && nextTab !== 'context') return;
  if (state.tab === nextTab) return;
  state.tab = nextTab;
  savePrefs();
  syncTabUI();
  if (nextTab === 'context') {
    if (!state.context && !state.contextErr) {
      renderContext();
      await loadContext(false);
    }
    renderContext();
  } else {
    render();
  }
}

function render() {
  setLive();
  renderBanner();
  syncTabUI();
  const ov = state.overview;
  if (!ov) {
    $('skeleton').classList.toggle('hidden', !!state.lastErr && !state.firstLoad);
    $('content').classList.add('hidden');
    if (state.lastErr && !state.firstLoad) renderFatal();
    return;
  }
  $('skeleton').classList.add('hidden');
  $('content').classList.remove('hidden');
  renderQuota();
  if (state.tab === 'context') {
    renderContext();
    return;
  }
  renderKpis();
  const list = swarmsAll();
  const empty = !list.length;
  $('empty').classList.toggle('hidden', !empty);
  $('layout').classList.toggle('hidden', empty);
  if (empty) { renderEmpty(); return; }
  renderSwarms();
  renderHero();
  renderModels();
  renderTimeline();
  applyHighlight();
  const sel = list.find((s) => s.id === state.selectedId);
  $('subtitle').textContent = L(
    `${list.length} 个 Swarm · 合计 ${fmtUsd(ov.totals?.estimatedCostUsd)}${sel ? ' · 当前 ' + (sel.title || sel.id) : ''}`,
    `${list.length} Swarm${list.length > 1 ? 's' : ''} · Total ${fmtUsd(ov.totals?.estimatedCostUsd)}${sel ? ' · ' + (sel.title || sel.id) : ''}`
  );
}

function renderBanner() {
  const b = $('banner');
  const detErr = state.selectedId && state.detailErr.get(state.selectedId);
  if (state.lastErr && state.overview) {
    b.className = 'banner warn';
    $('banner-text').textContent = L(`刷新失败，正在显示上次数据（${fmtAgo(state.lastOk)}）：${state.lastErr}`, `Refresh failed, showing cached data (${fmtAgo(state.lastOk)}): ${state.lastErr}`);
  } else if (detErr && state.details.has(state.selectedId)) {
    b.className = 'banner warn';
    $('banner-text').textContent = L(`Swarm 明细刷新失败：${detErr}`, `Failed to refresh Swarm detail: ${detErr}`);
  } else {
    b.className = 'banner hidden';
  }
}

function renderFatal() {
  $('skeleton').classList.add('hidden');
  $('content').classList.remove('hidden');
  $('kpis').innerHTML = '';
  $('quota-dock').innerHTML = '';
  state.lastQuotaSig = '';
  $('layout').classList.add('hidden');
  const e = $('empty');
  e.classList.remove('hidden');
  e.innerHTML = `<div class="empty">
    <div class="empty-icon" style="color:var(--c-error)">${icon('i-alert')}</div>
    <h3>${esc(L('无法连接到 Swarm Cost Monitor 服务', 'Cannot connect to Swarm Cost Monitor'))}</h3>
    <p>${esc(state.lastErr || L('未知错误', 'Unknown error'))} ${esc(L('Sidecar 可能仍在启动，稍后会自动重试。', 'Sidecar may still be starting; retrying automatically.'))}</p>
    <p style="margin-top:12px"><button type="button" class="ghost-btn" data-act="retry" style="background:var(--c-fill)">${icon('i-refresh', 'sm')} ${esc(L('立即重试', 'Retry now'))}</button></p>
  </div>`;
}

const CTX_CAT_META = {
  system: { color: '#8a94a6', zh: '系统提示与工具定义', en: 'System Prompt & Tool Schemas' },
  tool_outputs: { color: '#e8875b', zh: '工具调用与返回', en: 'Tool Calls & Outputs' },
  assistant: { color: '#2fae8e', zh: '助手回复', en: 'Assistant Responses' },
  thinking: { color: '#a774e0', zh: '思考过程', en: 'Thinking / Reasoning' },
  user: { color: '#4c8df6', zh: '用户输入', en: 'User Messages' },
  system_msg: { color: '#d9a52b', zh: '系统通知与注入', en: 'System Notices' },
};

function renderContextChart(history, limit, compactCount) {
  if (!Array.isArray(history) || history.length < 2) {
    return `<div class="empty sm">${esc(L('至少需要 2 次模型调用后才会绘制上下文增长曲线。', 'Context growth chart appears after 2+ model turns.'))}</div>`;
  }
  const W = 320, H = 96;
  const maxTurn = Math.max(...history.map((h) => num(h.totalContextTokens)), 1);
  const yMax = Math.max(maxTurn * 1.12, limit > 0 && maxTurn > limit * 0.45 ? limit * 1.04 : maxTurn * 1.15);
  const n = history.length;
  const xOf = (i) => (n === 1 ? W / 2 : (i / (n - 1)) * W);
  const yOf = (v) => H - clamp((num(v) / yMax) * (H - 8), 0, H - 8) - 3;

  const totPts = history.map((h, i) => `${xOf(i).toFixed(2)},${yOf(h.totalContextTokens).toFixed(2)}`);
  const cachePts = history.map((h, i) => `${xOf(i).toFixed(2)},${yOf(h.cacheReadTokens).toFixed(2)}`);
  const totArea = `0,${H} ${totPts.join(' ')} ${W},${H}`;
  const cacheArea = `0,${H} ${cachePts.join(' ')} ${W},${H}`;

  const limitLine = limit > 0 && limit <= yMax
    ? `<line class="ctx-chart-limit" x1="0" y1="${yOf(limit).toFixed(2)}" x2="${W}" y2="${yOf(limit).toFixed(2)}" vector-effect="non-scaling-stroke"></line>`
    : '';
  const compLines = history
    .map((h, i) => (h.compacted ? `<line class="ctx-chart-compact" x1="${xOf(i).toFixed(2)}" y1="0" x2="${xOf(i).toFixed(2)}" y2="${H}" vector-effect="non-scaling-stroke"></line>` : ''))
    .join('');

  const stepW = W / n;
  const hitRects = history.map((h, i) => {
    const tip = [
      `Turn #${h.turn} · ${h.modelLabel || h.model}`,
      L(`上下文 ${fmtTok(h.totalContextTokens)} tok（Prompt ${fmtTok(h.promptTokens)} + Output ${fmtTok(h.outputTokens)}）`, `Context ${fmtTok(h.totalContextTokens)} tok (Prompt ${fmtTok(h.promptTokens)} + Output ${fmtTok(h.outputTokens)})`),
      L(`Cache 命中 ${fmtPct(h.cacheHitPercent)}% (${fmtTok(h.cacheReadTokens)}) · 本步 ${fmtUsd(h.stepCostUsd)}`, `Cache hit ${fmtPct(h.cacheHitPercent)}% (${fmtTok(h.cacheReadTokens)}) · ${fmtUsd(h.stepCostUsd)}`),
      h.compacted ? L('⚡ 检测到上下文压缩 (Compaction)', '⚡ Context compaction detected') : '',
    ].filter(Boolean).join('\n');
    return `<rect x="${(i * stepW).toFixed(2)}" y="0" width="${stepW.toFixed(2)}" height="${H}" fill="transparent" data-tip="${esc(tip)}"></rect>`;
  }).join('');

  return `<svg class="ctx-chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(L('上下文增长趋势', 'Context window growth'))}">
      <line class="ctx-chart-grid" x1="0" y1="${H - 0.5}" x2="${W}" y2="${H - 0.5}" vector-effect="non-scaling-stroke"></line>
      <line class="ctx-chart-grid" x1="0" y1="${H / 2}" x2="${W}" y2="${H / 2}" vector-effect="non-scaling-stroke" stroke-dasharray="2 3"></line>
      ${limitLine}
      ${compLines}
      <polygon class="ctx-chart-area" points="${totArea}"></polygon>
      <polygon class="ctx-chart-cache" points="${cacheArea}"></polygon>
      <polyline class="ctx-chart-line" points="${totPts.join(' ')}" vector-effect="non-scaling-stroke"></polyline>
      ${hitRects}
    </svg>
    <div class="timeline-axis num">
      <span>Turn #1 (${esc(fmtClock(history[0].timestamp))})</span>
      <span>${compactCount ? esc(L(`${compactCount} 次压缩`, `${compactCount} compact${compactCount > 1 ? 's' : ''}`)) : esc(L(`峰值 ${fmtTok(maxTurn)}`, `Peak ${fmtTok(maxTurn)}`))}</span>
      <span>Turn #${history.length} (${esc(fmtClock(history[history.length - 1].timestamp))})</span>
    </div>`;
}

function renderContext() {
  const panel = $('panel-context');
  if (!panel) return;
  const ctx = state.context;
  if (!ctx && state.contextErr) {
    panel.innerHTML = `<div class="card"><div class="empty sm">
      <div class="empty-icon" style="color:var(--c-error)">${icon('i-alert')}</div>
      <h3>${esc(L('无法加载当前会话上下文', 'Failed to load conversation context'))}</h3>
      <p>${esc(state.contextErr)}</p>
      <p style="margin-top:10px"><button type="button" class="ghost-btn" data-act="retry" style="background:var(--c-fill)">${esc(L('重试', 'Retry'))}</button></p>
    </div></div>`;
    return;
  }
  if (!ctx) {
    panel.innerHTML = `<div class="card">
      <span class="skel skel-line" style="width:42%;height:14px"></span>
      <span class="skel skel-line" style="width:100%;height:12px;margin-top:14px;border-radius:999px"></span>
      <span class="skel skel-line" style="width:70%;margin-top:12px"></span>
    </div>`;
    return;
  }

  if (!ctx.available) {
    const isNoConv = ctx.reason === 'no_conversation';
    panel.innerHTML = `<div class="card"><div class="empty">
      <div class="empty-icon">${icon('i-gauge')}</div>
      <h3>${esc(isNoConv ? L('未检测到当前会话 ID', 'No active conversation detected') : L('当前会话暂无上下文记录', 'No transcript found for this conversation'))}</h3>
      <p>${esc(isNoConv
        ? L('「上下文窗口」标签页仅统计当前所在会话。请在 Antigravity 对话中打开本面板，或在独立浏览器 URL 后附加 ?conversationId=<会话ID>。', 'The Context Window tab strictly tracks the current conversation. Open this pane inside a conversation or pass ?conversationId=<id>.')
        : L(`未找到会话 ${ctx.conversationId || ''} 的 transcript.jsonl。发送首条消息后这里会实时显示上下文窗口占用。`, `No transcript.jsonl found for ${ctx.conversationId || ''}. It will appear after the first turn.`))}</p>
    </div></div>`;
    return;
  }

  const sig = JSON.stringify([state.settings.language, ctx.conversationId, ctx.current?.usedTokens, ctx.current?.model, ctx.sessionTotals?.steps]);
  if (sig === state.lastContextSig && panel.firstElementChild) return;
  state.lastContextSig = sig;

  const cur = ctx.current || {};
  const tot = ctx.sessionTotals || {};
  const limit = num(cur.contextWindow) || 200_000;
  const used = num(cur.usedTokens);
  const rem = num(cur.remainingTokens);
  const usedPct = clamp(num(cur.usedPercent), 0, 100);
  const status = cur.status || (usedPct >= 80 ? 'high' : usedPct >= 60 ? 'warn' : 'ok');

  const cachePctBar = limit > 0 ? clamp((num(cur.cacheReadTokens) / limit) * 100, 0, 100) : 0;
  const freshPctBar = limit > 0 ? clamp((num(cur.freshInputTokens) / limit) * 100, 0, Math.max(0, 100 - cachePctBar)) : 0;
  const outPctBar = limit > 0 ? clamp((num(cur.outputTokens) / limit) * 100, 0, Math.max(0, 100 - cachePctBar - freshPctBar)) : 0;

  const comp = Array.isArray(ctx.composition) ? ctx.composition : [];
  const compSum = comp.reduce((a, c) => a + num(c.tokens), 0) || used || 1;
  const compBar = comp.map((c) => {
    const meta = CTX_CAT_META[c.key] || { color: '#8a94a6', zh: c.key, en: c.key };
    const lbl = isEn() ? meta.en : meta.zh;
    return `<span style="flex:${Math.max(0.01, c.tokens)} 1 0;background:${meta.color}" data-tip="${esc(`${lbl}\n${fmtTok(c.tokens)} tok · ${fmtPct(c.percent)}%`)}"></span>`;
  }).join('');

  const heavy = Array.isArray(ctx.heavySteps) ? ctx.heavySteps : [];
  const adviceHtml = usedPct >= 75
    ? `<div class="ctx-advice${status === 'high' ? ' high' : ''}">
        ${icon('i-alert', 'sm')}
        <span>${esc(usedPct >= 85
          ? L('当前上下文已接近上限，建议立即使用 /compact 压缩或新开会话，避免触发截断与推理质量下降。', 'Context window is nearly full — consider running /compact or starting a fresh thread soon.')
          : L('上下文已超过 75%，后续回合 Cache 成本与延迟会上升，可适时使用 /compact 释放空间。', 'Context is above 75% — running /compact soon will free headroom and keep latency low.'))}</span>
      </div>`
    : '';

  const span = fmtSpan(tot.startedAt, tot.lastActiveAt);

  panel.innerHTML = `
    <section class="card">
      <div class="ctx-hero-top">
        <div class="hero-title">
          <h2><span class="txt" title="${esc(ctx.title || ctx.conversationId)}">${esc(ctx.title || L('当前会话', 'Current Conversation'))}</span>
            <span class="badge active">${esc(L('当前会话', 'Current Session'))}</span>
            ${srcBadge(cur.tokenSource || 'exact')}
          </h2>
          <div class="hero-meta num">
            <span class="badge model" style="box-shadow:inset 0 0 0 1px color-mix(in srgb, ${familyColor(cur.modelFamily)} 40%, transparent)">${esc(cur.modelLabel || cur.model)}</span>
            <span>${esc(L('上限', 'Limit'))} ${fmtTok(limit)}</span>
            <span>${fmtInt(tot.plannerSteps)} ${esc(L('次调用', 'turns'))}</span>
            ${tot.compactionCount ? `<span class="badge">${fmtInt(tot.compactionCount)} ${esc(L('次压缩', 'compacted'))}</span>` : ''}
            ${span ? `<span>${esc(L('历时', 'Span'))} ${esc(span)}</span>` : ''}
          </div>
        </div>
        <div class="ctx-pct-wrap">
          <span class="ctx-pct num ${status}">${fmtPct(usedPct)}%</span>
          <span class="ctx-ratio num">${fmtTok(used)} / ${fmtTok(limit)}</span>
        </div>
      </div>

      <div class="ctx-meter-wrap" data-tip="${esc(L(`当前活跃上下文窗口\n已用 ${fmtInt(used)} / ${fmtInt(limit)} tok (${fmtPct(usedPct)}%)\n剩余 ${fmtInt(rem)} tok`, `Active context window\nUsed ${fmtInt(used)} / ${fmtInt(limit)} tok (${fmtPct(usedPct)}%)\nRemaining ${fmtInt(rem)} tok`))}">
        <div class="ctx-meter">
          ${cachePctBar > 0 ? `<span class="seg-cache" style="width:${cachePctBar}%"></span>` : ''}
          ${freshPctBar > 0 ? `<span class="seg-fresh" style="width:${freshPctBar}%"></span>` : ''}
          ${outPctBar > 0 ? `<span class="seg-out" style="width:${outPctBar}%"></span>` : ''}
        </div>
        <span class="ctx-meter-tick" style="left:60%" title="60%"></span>
        <span class="ctx-meter-tick" style="left:80%" title="80%"></span>
      </div>

      <div class="ctx-meter-legend num">
        <span><i class="swatch" style="background:var(--t-cache)"></i>Cache Read <b>${fmtTok(cur.cacheReadTokens)}</b></span>
        <span><i class="swatch" style="background:var(--t-input)"></i>Fresh Input <b>${fmtTok(cur.freshInputTokens)}</b></span>
        <span><i class="swatch" style="background:var(--t-output)"></i>Output <b>${fmtTok(cur.outputTokens)}</b></span>
        <span class="spacer"></span>
        <span>${esc(L('剩余可用', 'Headroom'))} <b>${fmtTok(rem)}</b></span>
      </div>

      <div class="ctx-kpis num">
        <div class="ctx-kpi">
          <span class="k">${esc(L('最近 Prompt', 'Latest Prompt'))}</span>
          <span class="v">${fmtTok(cur.promptTokens)}</span>
          <span class="s">${esc(L('Cache + Fresh Input', 'Cache + Fresh Input'))}</span>
        </div>
        <div class="ctx-kpi">
          <span class="k">${esc(L('剩余空间', 'Remaining'))}</span>
          <span class="v">${fmtTok(rem)}</span>
          <span class="s">${fmtPct(Math.max(0, 100 - usedPct))}% ${esc(L('空闲', 'free'))}</span>
        </div>
        <div class="ctx-kpi">
          <span class="k">${esc(L('Cache 命中率', 'Cache Hit Rate'))}</span>
          <span class="v">${fmtPct(cur.cacheHitPercent)}%</span>
          <span class="s">${esc(L('累计', 'Session'))} ${fmtPct(cur.sessionCacheHitPercent)}%</span>
        </div>
        <div class="ctx-kpi">
          <span class="k">${esc(L('本会话花费', 'Session Spend'))}</span>
          <span class="v">${fmtUsd(tot.estimatedCostUsd)}</span>
          <span class="s">${fmtTok(tot.totalTokens)} tok</span>
        </div>
      </div>
      ${adviceHtml}
    </section>

    <div class="ctx-grid">
      <section class="card">
        <div class="section-head">
          <h3 class="section-title">${esc(L('上下文构成拆解', 'Context Composition'))}</h3>
          <span class="spacer"></span>
          <span class="section-note num">${fmtTok(compSum)} tok</span>
        </div>
        <div class="stackbar">${compBar}</div>
        <div class="ctx-cat-list">
          ${comp.map((c) => {
            const meta = CTX_CAT_META[c.key] || { color: '#8a94a6', zh: c.key, en: c.key };
            const lbl = isEn() ? meta.en : meta.zh;
            return `<div class="ctx-cat-row">
              <span class="swatch round" style="background:${meta.color}"></span>
              <span class="cn">${esc(lbl)}</span>
              <span class="cv num">${fmtTok(c.tokens)}</span>
              <span class="cp num">${fmtPct(c.percent)}%</span>
              <span class="bar"><i style="width:${clamp(c.percent, 0, 100)}%;background:${meta.color}"></i></span>
            </div>`;
          }).join('') || `<div class="empty sm">${esc(L('暂无上下文构成数据', 'No composition data'))}</div>`}
        </div>
        <div class="metric-hint">${esc(L('说明：系统提示词、工具 Schema 与 Rules/Skills 体积由“精确 Prompt 总量 − 可见对话记录估算”推算得出。', 'System prompt, tool schemas, and rules/skills are inferred by subtracting visible transcript estimates from exact prompt tokens.'))}</div>
      </section>

      <section class="card">
        <div class="section-head">
          <h3 class="section-title">${esc(L('上下文增长趋势', 'Context Growth'))}</h3>
          <span class="spacer"></span>
          <span class="section-note num">${esc(L('蓝线：总上下文 · 灰底：Cache', 'Line: total · Shaded: cache'))}</span>
        </div>
        ${renderContextChart(ctx.history || [], limit, tot.compactionCount || 0)}
      </section>
    </div>

    <section class="card">
      <div class="section-head">
        <h3 class="section-title">${esc(L('高占用步骤 Top 8', 'Top Context Consumers'))} <span class="count num">${heavy.length}</span></h3>
        <span class="spacer"></span>
        <span class="section-note">${esc(L('当前活跃窗口内估算', 'Within active window'))}</span>
      </div>
      <div class="ctx-heavy-list">
        ${heavy.map((h) => {
          const meta = CTX_CAT_META[h.category] || { color: '#8a94a6', zh: h.type, en: h.type };
          const pct = clamp(num(h.sharePercent), 0, 100);
          return `<div class="ctx-heavy-row" data-tip="${esc(`#${h.stepIndex} · ${isEn() ? meta.en : meta.zh}\n${h.label}\n~${fmtInt(h.estimatedTokens)} tok (${fmtPct(pct)}%)`)}">
            <span class="badge" style="color:${meta.color};background:color-mix(in srgb,${meta.color} 14%,transparent)">#${fmtInt(h.stepIndex)}</span>
            <span class="ctx-heavy-lbl">${esc(h.label)}</span>
            <span class="ctx-heavy-val num">${fmtTok(h.estimatedTokens)} <span class="muted">(${fmtPct(pct)}%)</span></span>
            <span class="bar"><i style="width:${pct}%;background:${meta.color}"></i></span>
          </div>`;
        }).join('') || `<div class="empty sm">${esc(L('暂无高占用步骤', 'No heavy steps yet'))}</div>`}
      </div>
    </section>

    <div class="ctx-sess-foot num">
      <span>conversationId: <code class="mono">${esc(ctx.conversationId)}</code></span>
      <span>${esc(L(`共 ${fmtInt(tot.steps)} 步 · ${fmtInt(tot.userTurns)} 轮对话 · ${fmtInt(tot.toolCalls)} 次工具调用`, `${fmtInt(tot.steps)} steps · ${fmtInt(tot.userTurns)} user turns · ${fmtInt(tot.toolCalls)} tool calls`))}</span>
      ${tot.lastActiveAt ? `<span>${esc(L('最近更新', 'Updated'))} ${esc(fmtAgo(tot.lastActiveAt))}</span>` : ''}
    </div>
  `;
}

function renderEmpty() {
  $('empty').innerHTML = `<div class="empty">
    <div class="empty-icon">${icon('i-hive')}</div>
    <h3>${esc(L('还没有发现任何 Swarm', 'No Swarms discovered yet'))}</h3>
    <p>${esc(L('启动一个原生 Swarm（或使用子代理）后，这里会实时显示每个 Swarm 与 Worker 的花费、Token 与步数占比。', 'Launch a Swarm or subagent to inspect per-Swarm and per-Worker cost, token, and step shares here.'))}</p>
    <p style="margin-top:8px" class="faint">${esc(L(`每 ${Math.round(effectiveIntervalMs() / 1000)}s 自动重新扫描`, `Auto-scanning every ${Math.round(effectiveIntervalMs() / 1000)}s`))}</p>
  </div>`;
}

/* KPIs ----------------------------------------------------------------- */
function renderKpis() {
  const ov = state.overview, t = ov.totals || {};
  const list = swarmsAll();
  const sel = list.find((s) => s.id === state.selectedId);
  const srcs = new Set(list.map((s) => s.tokenSource));
  const src = srcs.size === 1 ? [...srcs][0] : srcs.size ? 'mixed' : 'estimated';
  const p = tokenParts(t);
  $('kpis').innerHTML = `
    <div class="kpi" data-tip="${esc(L('全部 Swarm 估算花费\n按 /api/pricing 中的模型单价计算', 'Total estimated spend across all Swarms\nCalculated using model rates in /api/pricing'))}">
      <span class="kpi-label">${esc(L('总花费估算', 'Est. Total Spend'))} ${srcBadge(src)}</span>
      <span class="kpi-value num">${fmtUsd(t.estimatedCostUsd)}</span>
      <span class="kpi-sub num">${esc(L(`${fmtInt(t.plannerSteps ?? t.steps)} 次模型调用 · ${fmtInt(t.toolCalls)} 工具`, `${fmtInt(t.plannerSteps ?? t.steps)} calls · ${fmtInt(t.toolCalls)} tools`))}</span>
    </div>
    <div class="kpi" data-tip="${esc(`${L('Token 构成', 'Token Breakdown')}\nInput ${fmtTok(p.input)} · Cache ${fmtTok(p.cache)}\nThinking ${fmtTok(p.think)} · Output ${fmtTok(p.out)}`)}">
      <span class="kpi-label">${esc(L('总 Token', 'Total Tokens'))}</span>
      <span class="kpi-value num">${fmtTok(t.totalTokens)}</span>
      <span class="kpi-sub" style="display:flex;align-items:center;gap:6px">${splitBar(t).replace('class="split"', 'class="split" style="flex:1;min-width:30px"')}<span class="num">${esc(L('输出', 'Out'))} ${fmtTok(t.outputTokens)}</span></span>
    </div>
    <div class="kpi">
      <span class="kpi-label">Swarm</span>
      <span class="kpi-value num">${fmtInt(t.activeSwarmCount)}<span class="unit">${esc(L('活跃', 'active'))}</span> <span class="muted" style="font-weight:500">/ ${fmtInt(t.swarmCount ?? list.length)}</span></span>
      <span class="kpi-sub num">${esc(L(`Worker ${fmtInt(t.workerCount)} · 运行中 ${fmtInt(t.activeWorkerCount)}`, `${fmtInt(t.workerCount)} workers · ${fmtInt(t.activeWorkerCount)} working`))}</span>
    </div>
    <div class="kpi accent">
      <span class="kpi-label">${esc(L('当前 Swarm', 'Selected Swarm'))}</span>
      <span class="kpi-value num">${sel ? fmtUsd(sel.estimatedCostUsd) : '—'}</span>
      <span class="kpi-sub num">${sel ? esc(L(`占全部 ${fmtPct(sel.costSharePercent)}% · ${fmtTok(sel.totalTokens)} tok`, `${fmtPct(sel.costSharePercent)}% of all · ${fmtTok(sel.totalTokens)} tok`)) : esc(L('未选择', 'None'))}</span>
    </div>`;
}

/* Quota Dock (mini / compact / expanded + weekly 7d usage) ---------------- */
function quotaTone(p) {
  const rem = num(p?.remainingPercent);
  if (p?.status === 'exhausted' || rem < 15) return 'bad';
  if (p?.status === 'low' || rem <= 35) return 'warn';
  return 'ok';
}
function winTag(wk, full = false) {
  if (wk === 'weekly') return full ? L('周额度上限', 'Weekly Cap') : L('周', 'Wk');
  if (wk === '5h') return full ? L('5h 滚动', '5h Rolling') : '5h';
  return full ? L('实时窗口', 'Live Window') : '';
}
function resetSpan(p, short = false) {
  if (Number.isFinite(p?.resetInSec) && p.resetInSec != null) {
    const txt = short ? fmtDurationShort(p.resetInSec) : fmtDuration(p.resetInSec);
    return `<span class="num" data-reset-sec="${num(p.resetInSec)}" data-reset-fmt="${short ? 'short' : 'full'}">${esc(L(`${txt} 后重置`, `Resets in ${txt}`))}</span>`;
  }
  if (p?.resetTime) return `<span>${esc(L(`重置于 ${fmtClock(p.resetTime)}`, `Resets ${fmtClock(p.resetTime)}`))}</span>`;
  return '<span>—</span>';
}
function poolMark(p) {
  const id = String(p?.id || '').toLowerCase();
  if (id === 'gemini') return 'G';
  if (id === 'claude') return 'C';
  return (p?.label || '?').slice(0, 1).toUpperCase();
}
function poolTooltip(p, weekly) {
  const rem = clamp(num(p.remainingPercent), 0, 100);
  const stTag = p.status === 'exhausted' ? L('（已耗尽）', ' (Exhausted)') : p.status === 'low' ? L('（偏低）', ' (Low)') : '';
  const lines = [
    `${p.label || p.id} · ${winTag(p.windowKind, true)}`,
    L(`剩余 ${fmtPct(rem)}% · 已用 ${fmtPct(p.usedPercent)}%${stTag}`, `${fmtPct(rem)}% left · ${fmtPct(p.usedPercent)}% used${stTag}`),
  ];
  if (Number.isFinite(p.resetInSec) && p.resetInSec != null) {
    lines.push(L(`${fmtDuration(p.resetInSec)} 后重置${p.resetTime ? ' (' + fmtClock(p.resetTime) + ')' : ''}`, `Resets in ${fmtDuration(p.resetInSec)}${p.resetTime ? ' (' + fmtClock(p.resetTime) + ')' : ''}`));
  } else if (p.resetTime) {
    lines.push(L(`重置时间 ${fmtClock(p.resetTime)}`, `Reset at ${fmtClock(p.resetTime)}`));
  }
  if ((p.sampleModels || []).length) lines.push(L(`含 ${p.modelCount || p.sampleModels.length} 配置：${p.sampleModels.join(' / ')}`, `${p.modelCount || p.sampleModels.length} configs: ${p.sampleModels.join(' / ')}`));
  if (state.settings.showWeeklyQuota && weekly?.byPool) {
    const bp = weekly.byPool[p.id];
    if (bp) lines.push(L(`近 7 天本地：${fmtUsd(bp.estimatedCostUsd)} · ${fmtTok(bp.tokens)} tok (${fmtPct(bp.sharePercent, 0)}%)`, `7d local: ${fmtUsd(bp.estimatedCostUsd)} · ${fmtTok(bp.tokens)} tok (${fmtPct(bp.sharePercent, 0)}%)`));
  }
  if (state.settings.quotaWidgetSize === 'mini') lines.push(L('点击展开完整额度面板', 'Click to expand quota panel'));
  return lines.join('\n');
}
function arcGaugeSvg(p) {
  const rem = clamp(num(p.remainingPercent), 0, 100);
  const tone = quotaTone(p);
  const R = 14.5;
  const C = 2 * Math.PI * R;
  const ARC = C * 0.72; // ~260deg open-bottom arc (140deg -> 400deg) for clean bottom label clearance
  const fill = rem > 0 ? Math.max(1.2, (rem / 100) * ARC) : 0;
  const pctStr = Math.round(rem) + '%';
  return `<svg class="qd-gauge" viewBox="0 0 40 40" aria-hidden="true">
    <g transform="rotate(140 20 20)">
      <circle class="qd-gauge-track" cx="20" cy="20" r="${R}" stroke-dasharray="${ARC.toFixed(2)} ${C.toFixed(2)}"></circle>
      ${fill > 0 ? `<circle class="qd-gauge-arc ${tone}" cx="20" cy="20" r="${R}" stroke-dasharray="${fill.toFixed(2)} ${C.toFixed(2)}"></circle>` : ''}
    </g>
    <text class="qd-gauge-letter" x="20" y="18.5">${esc(poolMark(p))}</text>
    <text class="qd-gauge-pct ${tone === 'ok' ? '' : tone}" x="20" y="36">${esc(pctStr)}</text>
  </svg>`;
}
function getPools(q) {
  if (Array.isArray(q?.pools) && q.pools.length) return q.pools;
  // Backward fallback if an older backend response only has items.
  const items = q?.items || [];
  if (!items.length) return [];
  const by = new Map();
  for (const it of items) {
    const id = it.pool || (/claude|gpt/i.test(it.label || it.model) ? 'claude' : 'gemini');
    if (!by.has(id)) by.set(id, { id, label: id === 'claude' ? 'Claude' : 'Gemini', remainingPercent: it.remainingPercent, usedPercent: it.usedPercent, resetTime: it.resetTime, resetInSec: it.resetInSec, windowKind: it.windowKind || '5h', status: it.status, modelCount: 1, sampleModels: [shortLabel(it.label || it.model)] });
  }
  return [...by.values()];
}
function quotaSignature(q, allPools, size, showWeekly) {
  const w = q.weeklyLocalUsage;
  return JSON.stringify([
    size,
    showWeekly,
    state.settings.language,
    !!q.available,
    q.reason || '',
    q.planTier || '',
    q.credits || null,
    allPools.map((p) => [p.id, num(p.remainingPercent), p.status, p.windowKind, p.resetTime || '', p.modelCount || 0]),
    showWeekly && w ? [w.total?.estimatedCostUsd, w.total?.tokens, w.total?.steps, w.byPool?.gemini?.sharePercent, w.byPool?.claude?.sharePercent] : null,
    size === 'expanded' ? (q.items || []).map((it) => [it.id, num(it.remainingPercent), it.status]) : null,
  ]);
}
function renderQuota() {
  const dock = $('quota-dock');
  const meta = $('dock-meta');
  if (!dock) return;
  const q = state.overview?.quotas;
  const { quotaWidgetSize: size, showWeeklyQuota: showWeekly } = state.settings;
  dock.dataset.size = size;

  if (!q) {
    dock.innerHTML = '';
    state.lastQuotaSig = '';
    if (meta) meta.textContent = '';
    return;
  }

  const pools = getPools(q);
  const weekly = q.weeklyLocalUsage || null;
  const gPool = pools.find((p) => p.id === 'gemini');
  const cPool = pools.find((p) => p.id === 'claude');
  const primaryPools = [gPool, cPool].filter(Boolean);
  const allPools = primaryPools.length ? [...primaryPools, ...pools.filter((p) => p.id !== 'gemini' && p.id !== 'claude')] : pools;
  const avail = !!(q.available && allPools.length);

  if (meta) {
    const parts = [];
    if (q.planTier) parts.push(q.planTier);
    if (q.fetchedAt && avail) parts.push(`${L('额度', 'Quota')} ${fmtClock(q.fetchedAt)}`);
    meta.textContent = parts.join(' · ');
  }

  // Skip DOM replacement if quota data & view settings did not change (prevents 5s flicker/re-animation).
  const sig = quotaSignature(q, allPools, size, showWeekly);
  if (sig === state.lastQuotaSig && dock.firstElementChild && !state.quotaAnimateNext) {
    return;
  }
  const prevScroll = dock.querySelector('.qd-expanded')?.scrollTop || 0;
  const animCls = state.quotaAnimateNext ? ' qd-animate' : '';
  state.lastQuotaSig = sig;
  state.quotaAnimateNext = false;

  /* ---- Size 1: MINI (Codex-style twin 3/4-circle gauges) ---- */
  if (size === 'mini') {
    const twin = avail ? allPools.slice(0, 2) : [];
    const gauges = twin.length
      ? `<div class="qd-mini-pill">${twin.map((p, idx) =>
          `${idx > 0 ? '<span class="qd-mini-sep" aria-hidden="true"></span>' : ''}<button type="button" class="qd-gauge-btn" data-dock-expand="1" aria-label="${esc(L(`${p.label} 剩余 ${Math.round(num(p.remainingPercent))}%`, `${p.label} ${Math.round(num(p.remainingPercent))}% left`))}" data-tip="${esc(poolTooltip(p, weekly))}">${arcGaugeSvg(p)}</button>`
        ).join('')}</div>`
      : `<span class="qd-unavail" data-tip="${esc(q.reason || L('未能从本地 Language Server 读取额度', 'Unable to read quota from local Language Server'))}">${icon('i-gauge', 'sm')} ${esc(L('额度暂不可用', 'Quota unavailable'))}</span>`;

    let wPill = '';
    if (showWeekly && weekly?.total) {
      const g = weekly.byPool?.gemini || { tokens: 0, estimatedCostUsd: 0, sharePercent: 0 };
      const c = weekly.byPool?.claude || { tokens: 0, estimatedCostUsd: 0, sharePercent: 0 };
      const tip = L(
        `近 ${weekly.windowDays || 7} 天本地用量（brain/ 统计）\n合计 ${fmtUsd(weekly.total.estimatedCostUsd)} · ${fmtTok(weekly.total.tokens)} tok · ${fmtInt(weekly.total.steps)} 步\nGemini ${fmtUsd(g.estimatedCostUsd)} (${fmtPct(g.sharePercent, 0)}%) · Claude ${fmtUsd(c.estimatedCostUsd)} (${fmtPct(c.sharePercent, 0)}%)\n点击展开详情`,
        `Last ${weekly.windowDays || 7}d local usage (from brain/)\nTotal ${fmtUsd(weekly.total.estimatedCostUsd)} · ${fmtTok(weekly.total.tokens)} tok · ${fmtInt(weekly.total.steps)} steps\nGemini ${fmtUsd(g.estimatedCostUsd)} (${fmtPct(g.sharePercent, 0)}%) · Claude ${fmtUsd(c.estimatedCostUsd)} (${fmtPct(c.sharePercent, 0)}%)\nClick to expand`
      );
      wPill = `<button type="button" class="qd-mini-7d num" data-dock-expand="1" data-tip="${esc(tip)}"><span>7d</span><b>${fmtUsd(weekly.total.estimatedCostUsd)}</b><span class="faint">G ${fmtPct(g.sharePercent, 0)}% · C ${fmtPct(c.sharePercent, 0)}%</span></button>`;
    }
    dock.innerHTML = `<div class="qd-mini-row${animCls}">${gauges}${wPill}</div>`;
    return;
  }

  /* ---- Size 2: COMPACT (two-column horizontal mini-bars) ---- */
  if (size === 'compact') {
    const cells = avail ? allPools.map((p) => {
      const rem = clamp(num(p.remainingPercent), 0, 100);
      const tone = quotaTone(p);
      const wt = winTag(p.windowKind, false);
      return `<div class="qd-c-cell" data-dock-expand="1" role="button" tabindex="0" data-tip="${esc(poolTooltip(p, weekly))}">
        <div class="qd-c-top">
          <span class="qd-c-name">${esc(p.label)}</span>
          ${wt ? `<span class="qd-win${p.windowKind === 'weekly' ? ' weekly' : ''}">${esc(wt)}</span>` : ''}
          <span class="qd-c-pct num ${tone}">${fmtPct(rem, 0)}%</span>
        </div>
        <span class="bar sm ${tone}"><i style="width:${rem}%"></i></span>
        <span class="qd-c-sub">${p.status === 'exhausted' ? esc(L('已耗尽 · ', 'Exhausted · ')) : ''}${resetSpan(p, true)}</span>
      </div>`;
    }).join('') : `<div class="qd-c-sub" style="grid-column:1/-1;padding:2px 0">${esc(L('实时额度暂不可用', 'Live quota unavailable'))}${q.reason ? ': ' + esc(q.reason) : ''}</div>`;

    let wRow = '';
    if (showWeekly && weekly?.total) {
      const g = weekly.byPool?.gemini || { tokens: 0, estimatedCostUsd: 0, sharePercent: 0 };
      const c = weekly.byPool?.claude || { tokens: 0, estimatedCostUsd: 0, sharePercent: 0 };
      const hasWeeklyCap = allPools.some((p) => p.windowKind === 'weekly');
      const tip = L(
        `近 ${weekly.windowDays || 7} 天本地统计\n合计 ${fmtUsd(weekly.total.estimatedCostUsd)} · ${fmtTok(weekly.total.tokens)} tok · ${fmtInt(weekly.total.steps)} 步\nGemini ${fmtUsd(g.estimatedCostUsd)} (${fmtPct(g.sharePercent, 0)}%) · Claude ${fmtUsd(c.estimatedCostUsd)} (${fmtPct(c.sharePercent, 0)}%)`,
        `Last ${weekly.windowDays || 7}d local rollup\nTotal ${fmtUsd(weekly.total.estimatedCostUsd)} · ${fmtTok(weekly.total.tokens)} tok · ${fmtInt(weekly.total.steps)} steps\nGemini ${fmtUsd(g.estimatedCostUsd)} (${fmtPct(g.sharePercent, 0)}%) · Claude ${fmtUsd(c.estimatedCostUsd)} (${fmtPct(c.sharePercent, 0)}%)`
      );
      wRow = `<div class="qd-c-7d num" data-tip="${esc(tip)}">
        <span>${esc(hasWeeklyCap ? L('周限已触发', 'Weekly Cap') : L('7d 本地', '7d Local'))}</span>
        <span class="qd-7d-bar"><span class="g" style="flex:${Math.max(0.01, num(g.sharePercent))} 1 0"></span><span class="c" style="flex:${Math.max(0.01, num(c.sharePercent))} 1 0"></span></span>
        <b>${fmtUsd(weekly.total.estimatedCostUsd)}</b>
        <span class="faint">G ${fmtPct(g.sharePercent, 0)}% / C ${fmtPct(c.sharePercent, 0)}%</span>
      </div>`;
    }
    dock.innerHTML = `<div class="qd-compact${animCls}"><div class="qd-compact-grid">${cells}</div>${wRow}</div>`;
    return;
  }

  /* ---- Size 3: EXPANDED (full multi-bar panel + credits + weekly section) ---- */
  const poolRows = avail ? allPools.map((p) => {
    const rem = clamp(num(p.remainingPercent), 0, 100);
    const tone = quotaTone(p);
    const wt = winTag(p.windowKind, true);
    const st = p.status === 'exhausted' ? `<span class="badge" style="color:var(--q-bad);background:color-mix(in srgb,var(--q-bad) 14%,transparent)">${esc(L('已耗尽', 'Exhausted'))}</span>`
      : p.status === 'low' ? `<span class="badge" style="color:var(--q-warn);background:color-mix(in srgb,var(--q-warn) 16%,transparent)">${esc(L('偏低', 'Low'))}</span>` : '';
    return `<div class="qd-pool-row" data-tip="${esc(poolTooltip(p, weekly))}">
      <div class="qd-pool-top">
        <span class="qd-pool-label">${esc(p.label)}</span>
        ${wt ? `<span class="qd-win${p.windowKind === 'weekly' ? ' weekly' : ''}">${esc(wt)}</span>` : ''}
        ${st}
        <span class="qd-pool-pct num ${tone}">${fmtPct(rem)}%</span>
      </div>
      <span class="bar ${tone}"><i style="width:${rem}%"></i></span>
      <div class="qd-pool-meta">
        <span>${resetSpan(p, false)}</span>
        <span class="qd-pool-models">${esc((p.sampleModels || []).join(' · '))}${p.modelCount ? ` (${p.modelCount})` : ''}</span>
      </div>
    </div>`;
  }).join('') : `<div class="section-note">${esc(L('未能获取实时账户额度', 'Unable to fetch live account quota'))}${q.reason ? ': ' + esc(q.reason) : ''}</div>`;

  // AI Credits bars (if monthly credits present)
  let credHtml = '';
  const cr = q.credits;
  if (cr && (cr.monthlyPromptCredits > 0 || cr.monthlyFlowCredits > 0)) {
    const credItem = (label, availC, totalC) => {
      if (!(totalC > 0) || availC == null) return '';
      const pct = clamp((num(availC) / num(totalC)) * 100, 0, 100);
      const tone = pct < 15 ? 'bad' : pct <= 35 ? 'warn' : 'ok';
      return `<div class="qd-cred">
        <div class="qd-cred-top"><span>${esc(label)}</span><b class="num">${fmtInt(availC)} / ${fmtInt(totalC)} (${fmtPct(pct, 0)}%)</b></div>
        <span class="bar sm ${tone}"><i style="width:${pct}%"></i></span>
      </div>`;
    };
    const items = [
      credItem('Prompt Credits', cr.availablePromptCredits, cr.monthlyPromptCredits),
      credItem('Flow Credits', cr.availableFlowCredits, cr.monthlyFlowCredits),
    ].filter(Boolean).join('');
    if (items) credHtml = `<div class="qd-credits">${items}</div>`;
  }

  // Weekly / 7-day section (shown when showWeeklyQuota is checked)
  let weeklyHtml = '';
  if (showWeekly) {
    const winPills = allPools.map((p) => {
      const isW = p.windowKind === 'weekly';
      return `<span class="badge${isW ? ' est' : ''}">${esc(p.label)}: ${esc(isW ? L('已触发周额度上限', 'Weekly cap active') : p.windowKind === '5h' ? L('5h 滚动窗口（未触及周限）', '5h rolling (under weekly cap)') : L('窗口未知', 'Unknown'))}</span>`;
    }).join('');
    const wTot = weekly?.total || { tokens: 0, steps: 0, estimatedCostUsd: 0 };
    const bp = weekly?.byPool || {};
    const wPools = [
      { id: 'gemini', label: 'Gemini', color: '#4c8df6', ...(bp.gemini || { tokens: 0, steps: 0, estimatedCostUsd: 0, sharePercent: 0 }) },
      { id: 'claude', label: 'Claude', color: '#d97757', ...(bp.claude || { tokens: 0, steps: 0, estimatedCostUsd: 0, sharePercent: 0 }) },
    ];
    weeklyHtml = `<div class="qd-weekly">
      <div class="qd-weekly-head">
        <strong>${esc(L(`周额度 · 近 ${weekly?.windowDays || 7} 天用量`, `Weekly · Last ${weekly?.windowDays || 7}d Usage`))}</strong>
        <span class="badge active">${esc(L('近 7 天本地统计', '7d Local Stats'))}</span>
        <span class="spacer"></span>
        <span class="num muted">${fmtUsd(wTot.estimatedCostUsd)} · ${fmtTok(wTot.tokens)} tok</span>
      </div>
      ${winPills ? `<div class="qd-win-pills">${winPills}</div>` : ''}
      ${wPools.map((wp) => `<div class="qd-w-row">
        <div class="qd-w-top">
          <span class="swatch round" style="background:${wp.color}"></span>
          <span style="font-weight:500">${esc(wp.label)}</span>
          <span class="muted num">${fmtUsd(wp.estimatedCostUsd)}</span>
          <span class="pct num">${fmtPct(wp.sharePercent)}%</span>
        </div>
        <span class="bar sm"><i style="width:${clamp(num(wp.sharePercent), 0, 100)}%;background:${wp.color}"></i></span>
        <div class="qd-w-sub num"><span>${fmtTok(wp.tokens)} tok</span><span>${fmtInt(wp.steps)} ${esc(L('步', 'steps'))}</span></div>
      </div>`).join('')}
    </div>`;
  }

  // Optional per-model breakdown disclosure
  const items = q.items || [];
  const modelsDet = avail && items.length ? `<details class="qd-models-det" id="qd-models-det"${state.modelsOpen ? ' open' : ''}>
    <summary>${icon('i-chev', 'sm chev')}<span>${esc(L(`全部模型明细 (${items.length})`, `All Model Quotas (${items.length})`))}</span></summary>
    <div class="qd-models-grid">${[...items].sort((a, b) => num(a.remainingPercent) - num(b.remainingPercent) || String(a.label).localeCompare(String(b.label))).map((it) => {
      const rem = clamp(num(it.remainingPercent), 0, 100);
      const tone = quotaTone(it);
      return `<div class="qd-m-row">
        <span class="qd-m-name" title="${esc(it.label || it.model)}">${esc(it.label || it.model)}</span>
        <span class="num ${tone === 'ok' ? 'muted' : ''}" style="${tone === 'bad' ? 'color:var(--q-bad)' : tone === 'warn' ? 'color:var(--q-warn)' : ''}">${fmtPct(rem, 0)}%</span>
        <span class="bar ${tone}"><i style="width:${rem}%"></i></span>
      </div>`;
    }).join('')}</div>
  </details>` : '';

  dock.innerHTML = `<div class="qd-expanded${animCls}">
    <div class="qd-exp-head">
      <span class="qd-exp-title">${icon('i-gauge', 'sm')} ${esc(L('实时额度监控', 'Live Quota Monitor'))}</span>
      ${q.planTier ? `<span class="badge">${esc(q.planTier)}</span>` : ''}
      <span class="spacer"></span>
      <button type="button" class="ghost-btn" data-dock-collapse="1" style="height:22px;padding:0 6px;font-size:11px" title="${esc(L('收起为双圆环', 'Collapse to mini gauges'))}">${icon('i-chev-down', 'sm')} ${esc(L('收起', 'Collapse'))}</button>
    </div>
    <div class="qd-pool-list">${poolRows}</div>
    ${credHtml}
    ${weeklyHtml}
    ${modelsDet}
  </div>`;
  if (prevScroll > 0) {
    const exp = dock.querySelector('.qd-expanded');
    if (exp) exp.scrollTop = prevScroll;
  }
}
function shortLabel(s) {
  return String(s || '').replace(/^(Claude|Gemini|GPT)[\s-]*/i, '').slice(0, 18) || String(s || '');
}

/* Swarm list ---------------------------------------------------------------- */
function renderSwarms() {
  const all = swarmsAll();
  const hasTrees = all.some((s) => s.kind === 'subagent_tree');
  const hasSwarms = all.some((s) => s.kind !== 'subagent_tree');
  if (!hasTrees || !hasSwarms) state.swarmFilter = 'all';
  const list = all.filter((s) => state.swarmFilter === 'all' || (state.swarmFilter === 'swarm' ? s.kind !== 'subagent_tree' : s.kind === 'subagent_tree'));
  const m = state.metric;
  const rows = list.map((s) => ({ s, ...metricOf(s, m, all) }))
    .sort((a, b) => b.v - a.v || (parseTs(b.s.lastActiveAt) || 0) - (parseTs(a.s.lastActiveAt) || 0));
  const colors = new Map(rows.map((r, i) => [r.s.id, PALETTE[i % PALETTE.length]]));
  state.swarmColors = colors;
  const totalV = rows.reduce((a, r) => a + r.v, 0);

  // Stacked bar: top 7 + "其他".
  const TOP = 7;
  const top = rows.slice(0, TOP), rest = rows.slice(TOP);
  const restV = rest.reduce((a, r) => a + r.v, 0);
  const segs = top.filter((r) => r.v > 0).map((r) =>
    `<span data-swarm="${esc(r.s.id)}" style="flex:${r.v} 1 0;background:${colors.get(r.s.id)}" data-tip="${esc(`${r.s.title || r.s.id}\n${fmtMetric(m, r.v)} · ${fmtPct(r.pct)}%`)}"></span>`).join('')
    + (restV > 0 ? `<span style="flex:${restV} 1 0;background:var(--c-fg-faint)" data-tip="${esc(L(`其他 ${rest.length} 个`, `${rest.length} others`) + `\n${fmtMetric(m, restV)} · ${fmtPct(totalV ? (restV / totalV) * 100 : 0)}%`)}"></span>` : '');

  const filt = hasTrees && hasSwarms ? `<div class="segmented" role="group" aria-label="${esc(L('类型筛选', 'Filter kind'))}">
      ${[['all', L('全部', 'All')], ['swarm', 'Swarm'], ['subagent_tree', L('子代理', 'Subagent')]].map(([k, l]) => `<button type="button" data-swarm-filter="${k}" aria-pressed="${state.swarmFilter === k}">${l}</button>`).join('')}
    </div>` : '';

  $('swarms').innerHTML = `
    <div class="section-head">
      <h3 class="section-title">${esc(L(`Swarm ${metricInfo(m).short}占比`, `Swarm ${metricInfo(m).short} Share`))} <span class="count num">${list.length}</span></h3>
      <span class="spacer"></span>${filt}
    </div>
    <div class="stackbar" id="swarm-stack">${segs || ''}</div>
    <div class="axis num"><span>0</span><span>${fmtMetric(m, totalV)}</span></div>
    <div class="swarm-list" role="listbox" aria-label="${esc(L('选择 Swarm', 'Select Swarm'))}">
      ${rows.map((r) => swarmRow(r, colors.get(r.s.id), m)).join('') || `<div class="empty sm">${esc(L('该分类下没有 Swarm', 'No Swarms in this category'))}</div>`}
    </div>`;
}
function swarmRow({ s, v, pct }, color, m) {
  const sel = s.id === state.selectedId;
  const st = s.status === 'active' ? 'working' : s.status === 'idle' ? 'waiting' : 'stopped';
  return `<button type="button" class="swarm-row" role="option" aria-selected="${sel}" data-swarm="${esc(s.id)}" data-select-swarm="${esc(s.id)}">
    <span class="swatch" style="background:${color}"></span>
    <span class="swarm-name">
      <span class="status-dot ${st}" title="${esc(swarmStatusLabel(s.status))}"></span>
      <span class="txt">${esc(s.title || s.id)}</span>
      ${s.isActiveConversation ? `<span class="badge active">${esc(L('当前会话', 'Current'))}</span>` : ''}
      ${s.kind === 'subagent_tree' ? `<span class="badge">${esc(L('子代理', 'Subagent'))}</span>` : ''}
    </span>
    <span class="swarm-pct num">${fmtPct(pct)}%</span>
    <span class="swarm-meta num">
      <span class="bar"><i style="width:${clamp(pct, 0, 100)}%;background:${color}"></i></span>
      <span class="m">${fmtMetric(m, v)}</span>
      <span class="m">${fmtInt(s.workerCount)} ${esc(L('Worker', 'workers'))}</span>
      <span class="m">${esc(fmtAgo(s.lastActiveAt))}</span>
    </span>
  </button>`;
}

/* Hero ------------------------------------------------------------------- */
function renderHero() {
  const hero = $('hero');
  const id = state.selectedId;
  const sum = swarmsAll().find((s) => s.id === id);
  const d = state.details.get(id);
  const err = state.detailErr.get(id);
  const metricSeg = `<div class="segmented" role="group" aria-label="${esc(L('占比指标', 'Metric'))}">
      ${['cost', 'tokens', 'steps'].map((k) => `<button type="button" data-metric="${k}" aria-pressed="${state.metric === k}">${esc(k === 'cost' ? L('费用 $', 'Cost $') : k === 'tokens' ? 'Token' : L('步数·工具', 'Steps'))}</button>`).join('')}
    </div>`;
  const picker = swarmPicker();

  if (!d) {
    hero.innerHTML = `${heroHead(sum, null, metricSeg, picker)}
      ${err ? `<div class="empty sm"><div class="empty-icon" style="color:var(--c-error)">${icon('i-alert')}</div><h3>${esc(L('无法加载 Swarm 明细', 'Failed to load Swarm detail'))}</h3><p>${esc(err)}</p><p style="margin-top:10px"><button type="button" class="ghost-btn" data-act="retry" style="background:var(--c-fill)">${esc(L('重试', 'Retry'))}</button></p></div>`
        : `<div class="viz"><span class="skel skel-circle" style="width:132px;height:132px;margin:auto"></span><div style="display:flex;flex-direction:column;gap:9px"><span class="skel skel-line" style="width:90%"></span><span class="skel skel-line" style="width:72%"></span><span class="skel skel-line" style="width:84%"></span><span class="skel skel-line" style="width:60%"></span></div></div>
           <div style="margin-top:14px;display:flex;flex-direction:column;gap:6px"><span class="skel skel-card" style="height:58px"></span><span class="skel skel-card" style="height:58px"></span></div>`}`;
    return;
  }

  const workers = d.workers || [];
  const colors = workerColors(workers);
  state.workerColors = colors;
  // Unified model color map so multi-model worker bars match the Model Distribution card.
  const allModelObjs = [...(d.models || [])];
  const seenModels = new Set(allModelObjs.map((x) => x.model));
  for (const w of workers) {
    for (const mb of w.modelBreakdown || []) {
      if (mb.model && !seenModels.has(mb.model)) {
        seenModels.add(mb.model);
        allModelObjs.push({ model: mb.model, modelFamily: mb.modelFamily });
      }
    }
  }
  const mColors = modelColors(allModelObjs);
  state.modelColorMap = mColors;

  const m = state.metric;
  const rows = workers.map((w) => ({ w, ...metricOf(w, m, workers) }));
  const totalV = rows.reduce((a, r) => a + r.v, 0);
  const byShare = [...rows].sort((a, b) => b.v - a.v);

  const donut = donutSvg(byShare.map((r) => ({ key: r.w.name, v: r.v, color: colors.get(r.w.name), tip: `${r.w.name}\n${fmtMetric(m, r.v)} · ${fmtPct(r.pct)}%` })), totalV);
  const centerSub = m === 'cost' ? `${fmtTok(d.totals?.totalTokens)} tok` : m === 'tokens' ? fmtUsd(d.totals?.estimatedCostUsd) : L(`${fmtInt(d.totals?.toolCalls)} 工具调用`, `${fmtInt(d.totals?.toolCalls)} tools`);
  const legend = byShare.map((r) => `<div class="legend-item" data-w="${esc(r.w.name)}">
      <span class="swatch round" style="background:${colors.get(r.w.name)}"></span>
      <span class="ln">${esc(r.w.name)}</span>
      <span class="lv num">${fmtMetric(m, r.v)}</span>
      <span class="lp num">${fmtPct(r.pct)}%</span>
    </div>`).join('');
  const stack = byShare.filter((r) => r.v > 0).map((r) =>
    `<span data-w="${esc(r.w.name)}" style="flex:${r.v} 1 0;background:${colors.get(r.w.name)}" data-tip="${esc(`${r.w.name}\n${fmtMetric(m, r.v)} · ${fmtPct(r.pct)}%`)}"></span>`).join('');

  const sorters = {
    share: L('按占比', 'By share'),
    cost: L('按费用', 'By cost'),
    tokens: L('按 Token', 'By tokens'),
    steps: L('按步数', 'By steps'),
    recent: L('按最近活跃', 'Most recent'),
    name: L('按名称', 'By name'),
  };
  const list = sortWorkers(rows);

  const hint = m === 'steps'
    ? L(`步数 = Worker 的 transcript 步骤数；共 ${fmtInt(d.totals?.steps)} 步、${fmtInt(d.totals?.plannerSteps)} 次模型调用、${fmtInt(d.totals?.toolCalls)} 次工具调用。`, `Steps from transcripts: ${fmtInt(d.totals?.steps)} steps, ${fmtInt(d.totals?.plannerSteps)} LLM calls, ${fmtInt(d.totals?.toolCalls)} tool calls.`)
    : m === 'tokens'
      ? L('Token = Input + Cache Read + Output（Thinking 已包含在 Output 内，不重复计）；多模型 Worker 的条形按模型颜色分段叠加。', 'Tokens = Input + Cache Read + Output (Thinking is inside Output). Multi-model workers stack model colors.')
      : L('费用为按模型单价的估算值（USD）；同一 Worker 使用多个模型时，横条按各模型颜色分段叠加，点击可展开拆解。', 'Estimated USD by model rates. Workers using multiple models show stacked model-colored bar segments.');

  hero.innerHTML = `${heroHead(sum, d, metricSeg, picker)}
    <div class="viz">
      <div class="donut-wrap">${donut}
        <div class="donut-center" id="donut-center">${donutCenter(null, m, totalV, centerSub)}</div>
      </div>
      <div class="legend" id="legend">${legend || `<div class="empty sm">${esc(L('没有 Worker', 'No workers'))}</div>`}</div>
    </div>
    <div class="share-bar-wrap">
      <div class="stackbar lg" id="worker-stack">${stack}</div>
      <div class="axis num"><span>0%</span><span>50%</span><span>100%</span></div>
    </div>
    <div class="metric-hint">${esc(hint)}</div>
    <div class="wl-head">
      <h3 class="section-title">${esc(L('Worker 明细', 'Workers'))} <span class="count num">${workers.length}</span></h3>
      <span class="select"><select id="sort" aria-label="${esc(L('排序', 'Sort'))}">${Object.entries(sorters).map(([k, l]) => `<option value="${k}"${state.sort === k ? ' selected' : ''}>${l}</option>`).join('')}</select></span>
    </div>
    <div class="workers" id="workers">${list.map((r) => workerCard(r, colors.get(r.w.name), m, d, mColors)).join('')}</div>`;
  state.donutCtx = { m, totalV, centerSub, rows };
}

function swarmPicker() {
  const list = swarmsAll();
  if (list.length < 2) return '';
  const sorted = [...list].sort((a, b) => num(b.estimatedCostUsd) - num(a.estimatedCostUsd));
  return `<span class="select" title="${esc(L('切换 Swarm', 'Switch Swarm'))}"><select id="swarm-pick" aria-label="${esc(L('切换 Swarm', 'Switch Swarm'))}">${sorted.map((s) =>
    `<option value="${esc(s.id)}"${s.id === state.selectedId ? ' selected' : ''}>${esc((s.isActiveConversation ? '● ' : '') + (s.title || s.id))} · ${fmtUsd(s.estimatedCostUsd)}</option>`).join('')}</select></span>`;
}

function heroHead(sum, d, metricSeg, picker) {
  const s = d || sum || {};
  const t = d?.totals || sum || {};
  const status = s.status;
  const span = fmtSpan(s.startedAt, s.lastActiveAt);
  return `<div class="hero-head">
      <div class="hero-title">
        <h2><span class="txt" title="${esc(s.title || s.id || '')}">${esc(s.title || s.id || '—')}</span>
          ${status ? `<span class="badge${status === 'active' ? ' exact' : ''}">${esc(swarmStatusLabel(status))}</span>` : ''}
          ${s.tokenSource ? srcBadge(s.tokenSource) : ''}
          ${sum?.isActiveConversation ? `<span class="badge active">${esc(L('当前会话', 'Current'))}</span>` : ''}
        </h2>
        <div class="hero-meta num">
          <span>${esc(kindLabel(s.kind))}</span>
          <span>${fmtUsd(t.estimatedCostUsd)}</span>
          <span>${fmtTok(t.totalTokens)} tok</span>
          <span>${fmtInt(t.workerCount)} ${esc(L('Worker', 'workers'))}${t.activeWorkerCount ? esc(L(` · ${fmtInt(t.activeWorkerCount)} 运行中`, ` · ${fmtInt(t.activeWorkerCount)} working`)) : ''}</span>
          ${s.boardMessages != null ? `<span>${fmtInt(s.boardMessages)} ${esc(L('条消息', 'posts'))}</span>` : ''}
          ${span ? `<span>${esc(L('历时', 'Span'))} ${esc(span)}</span>` : ''}
          ${s.lastActiveAt ? `<span>${esc(L('活跃于', 'Active'))} ${esc(fmtAgo(s.lastActiveAt))}</span>` : ''}
        </div>
      </div>
      ${picker}
    </div>
    <div style="margin-bottom:12px">${metricSeg}</div>`;
}

function donutCenter(name, m, totalV, sub) {
  const ctx = state.donutCtx;
  if (name && ctx) {
    const r = ctx.rows.find((x) => x.w.name === name);
    if (r) {
      const alt = m === 'cost' ? `${fmtUsd(r.v)}` : m === 'tokens' ? `${fmtTok(r.v)} tok` : L(`${fmtInt(r.v)} 步 · ${fmtInt(r.w.toolCalls)} 工具`, `${fmtInt(r.v)} steps · ${fmtInt(r.w.toolCalls)} tools`);
      return `<span class="dc-label">${esc(name)}</span><span class="dc-value num">${fmtPct(r.pct)}%</span><span class="dc-sub num">${esc(alt)}</span>`;
    }
  }
  return `<span class="dc-label">${esc(L(`${metricInfo(m).short}合计`, `Total ${metricInfo(m).short}`))}</span><span class="dc-value num">${esc(m === 'steps' ? fmtInt(totalV) : fmtMetric(m, totalV))}</span><span class="dc-sub num">${esc(sub)}</span>`;
}

function donutSvg(items, total) {
  const R = 40, SW = 14, C = 2 * Math.PI * R;
  const live = items.filter((i) => i.v > 0);
  const gap = live.length > 1 ? 0.9 : 0;
  let acc = 0;
  const segs = total > 0 ? live.map((it) => {
    const len = (it.v / total) * C;
    const dash = Math.max(0.6, len - gap);
    const s = `<circle class="seg" data-w="${esc(it.key)}" cx="50" cy="50" r="${R}" fill="none" stroke="${it.color}" stroke-width="${SW}"
      stroke-dasharray="${dash.toFixed(3)} ${(C - dash).toFixed(3)}" stroke-dashoffset="${(-acc).toFixed(3)}" data-tip="${esc(it.tip)}"></circle>`;
    acc += len;
    return s;
  }).join('') : '';
  return `<svg class="donut" id="donut" viewBox="0 0 100 100" role="img" aria-label="Worker 占比环形图">
    <g transform="rotate(-90 50 50)">
      <circle cx="50" cy="50" r="${R}" fill="none" stroke="var(--c-track)" stroke-width="${SW}"></circle>
      ${segs}
    </g>
  </svg>`;
}

function sortWorkers(rows) {
  const k = state.sort;
  const by = {
    share: (a, b) => b.v - a.v,
    cost: (a, b) => num(b.w.estimatedCostUsd) - num(a.w.estimatedCostUsd),
    tokens: (a, b) => num(b.w.totalTokens) - num(a.w.totalTokens),
    steps: (a, b) => num(b.w.steps) - num(a.w.steps),
    recent: (a, b) => (parseTs(b.w.lastActiveAt) || 0) - (parseTs(a.w.lastActiveAt) || 0),
    name: (a, b) => a.w.name.localeCompare(b.w.name),
  }[k] || ((a, b) => b.v - a.v);
  return [...rows].sort((a, b) => by(a, b) || a.w.name.localeCompare(b.w.name));
}

function workerBarHtml(w, pct, m, d, mColors) {
  const widthPct = clamp(pct, 0, 100);
  const mb = Array.isArray(w.modelBreakdown) ? w.modelBreakdown : [];
  if (!mb.length || widthPct <= 0) {
    return `<span class="bar w-bar"><i style="width:${widthPct}%"></i></span>`;
  }
  const valKey = m === 'cost' ? 'estimatedCostUsd' : m === 'tokens' ? 'totalTokens' : 'plannerSteps';
  const shareKey = m === 'cost' ? 'costSharePercent' : m === 'tokens' ? 'tokenSharePercent' : 'stepSharePercent';
  const swarmTotCost = num(d?.totals?.estimatedCostUsd);
  const swarmTotTok = num(d?.totals?.totalTokens);
  const segs = mb
    .map((x) => ({ x, v: num(x[valKey]) }))
    .filter((it) => it.v > 0)
    .sort((a, b) => b.v - a.v);
  if (!segs.length) {
    return `<span class="bar w-bar"><i style="width:${widthPct}%"></i></span>`;
  }
  const segHtml = segs.map(({ x, v }) => {
    const col = mColors?.get(x.model) || familyColor(x.modelFamily);
    const swCostPct = swarmTotCost > 0 ? (num(x.estimatedCostUsd) / swarmTotCost) * 100 : 0;
    const swTokPct = swarmTotTok > 0 ? (num(x.totalTokens) / swarmTotTok) * 100 : 0;
    const tip = [
      `${x.modelLabel || x.model}`,
      L(
        `费用 ${fmtUsd(x.estimatedCostUsd)}（占本 Worker ${fmtPct(x.costSharePercent)}% · 占 Swarm ${fmtPct(swCostPct)}%）`,
        `Cost ${fmtUsd(x.estimatedCostUsd)} (${fmtPct(x.costSharePercent)}% of worker · ${fmtPct(swCostPct)}% of swarm)`
      ),
      L(
        `Token ${fmtTok(x.totalTokens)}（占本 Worker ${fmtPct(x.tokenSharePercent)}% · 占 Swarm ${fmtPct(swTokPct)}%）`,
        `Tokens ${fmtTok(x.totalTokens)} (${fmtPct(x.tokenSharePercent)}% of worker · ${fmtPct(swTokPct)}% of swarm)`
      ),
      L(`${fmtInt(x.plannerSteps)} 次模型调用（${fmtPct(x.stepSharePercent)}%）`, `${fmtInt(x.plannerSteps)} LLM calls (${fmtPct(x.stepSharePercent)}%)`),
    ].join('\n');
    return `<span class="w-bar-seg" style="flex:${Math.max(0.0001, v)} 1 0;background:${col}" data-tip="${esc(tip)}"></span>`;
  }).join('');
  return `<span class="bar w-bar"><span class="w-bar-stack" style="width:${widthPct}%">${segHtml}</span></span>`;
}

function workerCard({ w, v, pct }, color, m, d, mColors) {
  const open = state.expanded.has(w.name);
  const st = ['working', 'waiting', 'killed', 'unknown'].includes(w.state) ? w.state : 'unknown';
  const p = tokenParts(w);
  const role = w.role && w.role !== w.name ? `<span class="w-role">${esc(w.role)}</span>` : '';
  const model = w.modelLabel || w.model;
  const mb = Array.isArray(w.modelBreakdown) ? w.modelBreakdown : [];
  const multiModel = mb.length > 1
    ? `<span class="badge" data-tip="${esc(L('该 Worker 使用过的模型（横条按模型颜色叠加）', 'Models used by this worker (stacked in bar)') + '\n' + mb.map((x) => `${x.modelLabel || x.model}: ${fmtUsd(x.estimatedCostUsd)} (${fmtPct(x.costSharePercent)}%) · ${fmtTok(x.totalTokens)} tok (${fmtPct(x.tokenSharePercent)}%)`).join('\n'))}"><span class="w-model-dots">${mb.map((x) => `<i style="background:${mColors?.get(x.model) || familyColor(x.modelFamily)}"></i>`).join('')}</span>+${mb.length - 1}</span>`
    : (w.modelsUsed || []).length > 1
      ? `<span class="badge" data-tip="${esc(L('使用过的模型', 'Models used') + '\n' + w.modelsUsed.join('\n'))}">+${w.modelsUsed.length - 1}</span>`
      : '';
  const modelBreakdownHtml = mb.length > 0 ? `<div class="w-mb-wrap">
      <div class="w-mb-head">
        <span>${esc(L('模型消耗拆解', 'Per-Model Breakdown'))} (${mb.length})</span>
        <span class="faint" style="font-weight:400">${esc(L('费用占比 / Token 占比 / 调用', 'Cost % · Token % · Calls'))}</span>
      </div>
      ${mb.map((x) => {
        const col = mColors?.get(x.model) || familyColor(x.modelFamily);
        return `<div class="w-mb-row num">
          <span class="swatch round" style="background:${col}"></span>
          <span class="w-mb-name" title="${esc(x.model)}">${esc(x.modelLabel || x.model)}</span>
          <span class="w-mb-val">${fmtUsd(x.estimatedCostUsd)}</span>
          <span class="w-mb-pct">${fmtPct(x.costSharePercent)}%</span>
          <span class="w-mb-val muted">${fmtTok(x.totalTokens)} (${fmtPct(x.tokenSharePercent)}%)</span>
          <div class="w-mb-sub"><span>${esc(L('调用', 'Calls'))} ${fmtInt(x.plannerSteps)} (${fmtPct(x.stepSharePercent)}%)</span><span>In ${fmtTok(x.inputTokens)}</span><span>Cache ${fmtTok(x.cacheReadTokens)}</span><span>Out ${fmtTok(x.outputTokens)}</span></div>
        </div>`;
      }).join('')}
    </div>` : '';
  const detail = open ? `<div class="worker-detail">
      ${modelBreakdownHtml}
      <div class="kv num">
        <div><span class="k"><span class="swatch" style="background:var(--t-input)"></span>Input</span><span class="v">${fmtInt(p.input)}</span></div>
        <div><span class="k"><span class="swatch" style="background:var(--t-cache)"></span>Cache Read</span><span class="v">${fmtInt(p.cache)}</span></div>
        <div><span class="k"><span class="swatch" style="background:var(--t-think)"></span>Thinking</span><span class="v">${fmtInt(w.thinkingTokens)}</span></div>
        <div><span class="k"><span class="swatch" style="background:var(--t-output)"></span>Output</span><span class="v">${fmtInt(w.outputTokens)}</span></div>
        <div><span class="k">${esc(L('Input 费用', 'Input Cost'))}</span><span class="v">${fmtUsd(w.costBreakdown?.inputUsd)}</span></div>
        <div><span class="k">${esc(L('Cache 费用', 'Cache Cost'))}</span><span class="v">${fmtUsd(w.costBreakdown?.cacheReadUsd)}</span></div>
        <div><span class="k">${esc(L('Output 费用', 'Output Cost'))}</span><span class="v">${fmtUsd(w.costBreakdown?.outputUsd)}</span></div>
        <div><span class="k">${esc(L('合计费用', 'Total Cost'))}</span><span class="v">${fmtUsd(w.estimatedCostUsd)}</span></div>
        <div><span class="k">${esc(L('费用占比', 'Cost Share'))}</span><span class="v">${fmtPct(w.costSharePercent)}%</span></div>
        <div><span class="k">${esc(L('Token 占比', 'Token Share'))}</span><span class="v">${fmtPct(w.tokenSharePercent)}%</span></div>
        <div><span class="k">${esc(L('步数占比', 'Step Share'))}</span><span class="v">${fmtPct(w.stepSharePercent)}%</span></div>
        <div><span class="k">${esc(L('模型调用', 'LLM Calls'))}</span><span class="v">${fmtInt(w.plannerSteps)}</span></div>
        <div><span class="k">${esc(L('精确 / 估算步', 'Exact / Est.'))}</span><span class="v">${fmtInt(w.exactSteps)} / ${fmtInt(w.estimatedSteps)}</span></div>
        <div><span class="k">${esc(L('看板发帖', 'Board Posts'))}</span><span class="v">${fmtInt(w.boardPosts)}</span></div>
        <div><span class="k">${esc(L('最近活跃', 'Last Active'))}</span><span class="v">${esc(fmtClock(w.lastActiveAt))}</span></div>
        <div style="grid-column:1/-1"><span class="k">conversationId</span><span class="v mono" title="${esc(w.conversationId)}">${esc(w.conversationId || '—')}</span></div>
      </div>
      <div class="detail-note">${srcBadge(w.tokenSource)} ${esc(srcInfo(w.tokenSource).tip)}${w.thinkingTokens && w.tokenSource !== 'estimated' ? esc(L('；Thinking 为 Output 内的估算部分。', '; Thinking is estimated inside Output.')) : '.'}</div>
    </div>` : '';
  return `<div class="worker${open ? ' open' : ''}" data-w="${esc(w.name)}" style="--wc:${color}">
    <button type="button" class="worker-main" data-toggle-worker="${esc(w.name)}" aria-expanded="${open}">
      <span class="w-id">
        <span class="status-dot ${st}" data-tip="${esc(workerStateLabel(st))}"></span>
        <span class="w-name">${esc(w.name)}</span>
        ${role}
        <span class="badge model" style="box-shadow:inset 0 0 0 1px color-mix(in srgb, ${familyColor(w.modelFamily)} 40%, transparent)" data-tip="${esc(w.model || '')}">${esc(model || L('未知模型', 'Unknown'))}</span>
        ${multiModel}
        ${w.tokenSource && w.tokenSource !== 'exact' ? srcBadge(w.tokenSource) : ''}
        ${w.hasQuotaError ? `<span class="badge" style="color:var(--c-error);background:color-mix(in srgb,var(--c-error) 12%,transparent)" data-tip="${esc(L('该 Worker 的 transcript 中出现过 Quota / 容量错误', 'Quota/capacity error seen in transcript'))}">${esc(L('Quota 错误', 'Quota Err'))}</span>` : ''}
      </span>
      <span class="w-share" style="display:flex;align-items:center;gap:6px">
        <span class="w-pct num">${fmtPct(pct)}<small>%</small></span>
        ${icon('i-chev', 'sm w-chevron')}
      </span>
      ${workerBarHtml(w, pct, m, d, mColors)}
      <span class="w-stats num">
        <span><b>${fmtUsd(w.estimatedCostUsd)}</b> <span class="faint">(${fmtPct(w.costSharePercent)}%)</span></span>
        <span style="display:inline-flex;align-items:center;gap:6px"><b>${fmtTok(w.totalTokens)}</b> tok <span class="faint">(${fmtPct(w.tokenSharePercent)}%)</span> ${splitBar(w)}</span>
        <span><b>${fmtInt(w.steps)}</b> ${esc(L('步', 'steps'))}</span>
        <span><b>${fmtInt(w.toolCalls)}</b> ${esc(L('工具', 'tools'))}</span>
        <span>${esc(fmtAgo(w.lastActiveAt))}</span>
      </span>
    </button>
    ${detail}
  </div>`;
}

/* Models ------------------------------------------------------------------- */
function renderModels() {
  const box = $('models');
  const d = state.details.get(state.selectedId);
  if (!d) { box.innerHTML = `<div class="section-head"><h3 class="section-title">${esc(L('模型分布', 'Model Distribution'))}</h3></div><span class="skel skel-line" style="width:80%"></span><span class="skel skel-line" style="width:60%;margin-top:10px"></span>`; return; }
  const models = [...(d.models || [])];
  const m = state.metric;
  const rows = models.map((x) => {
    if (m === 'steps') {
      const tot = models.reduce((a, y) => a + num(y.plannerSteps), 0);
      return { x, v: num(x.plannerSteps), pct: tot ? (num(x.plannerSteps) / tot) * 100 : 0 };
    }
    return { x, ...metricOf(x, m, models) };
  }).sort((a, b) => b.v - a.v);
  const colors = state.modelColorMap || modelColors(rows.map((r) => r.x));
  const t = d.totals || {};
  const p = tokenParts(t);
  const tokLegend = [['--t-input', 'Input', p.input], ['--t-cache', 'Cache', p.cache], ['--t-think', 'Thinking', p.think], ['--t-output', 'Output', p.out]]
    .map(([c, l, v]) => `<span><span class="swatch" style="background:var(${c})"></span>${l} <b class="num">${fmtTok(v)}</b> <span class="faint num">${p.total ? fmtPct((v / p.total) * 100) : 0}%</span></span>`).join('');
  box.innerHTML = `
    <div class="section-head">
      <h3 class="section-title">${esc(L('模型分布', 'Model Distribution'))} <span class="count num">${rows.length}</span></h3>
      <span class="spacer"></span><span class="section-note">${esc(m === 'steps' ? L('按模型调用次数', 'By LLM calls') : metricInfo(m).label)}</span>
    </div>
    ${rows.length ? `<div class="stackbar" style="margin-bottom:12px">${rows.filter((r) => r.v > 0).map((r) => `<span style="flex:${r.v} 1 0;background:${colors.get(r.x.model) || familyColor(r.x.modelFamily)}" data-tip="${esc(`${r.x.modelLabel || r.x.model}\n${m === 'steps' ? fmtInt(r.v) + L(' 次调用', ' calls') : fmtMetric(m, r.v)} · ${fmtPct(r.pct)}%`)}"></span>`).join('')}</div>` : ''}
    <div class="models">
      ${rows.map((r) => `<div class="model-row" data-tip="${esc(`${r.x.model}\n${fmtUsd(r.x.estimatedCostUsd)} (${fmtPct(r.x.costSharePercent)}%) · ${fmtTok(r.x.totalTokens)} tok (${fmtPct(r.x.tokenSharePercent)}%)\n${fmtInt(r.x.plannerSteps)} ${L('次模型调用', 'LLM calls')}`)}">
        <span class="swatch round" style="background:${colors.get(r.x.model) || familyColor(r.x.modelFamily)}"></span>
        <span class="mn">${esc(r.x.modelLabel || r.x.model)}</span>
        <span class="mp num">${fmtPct(r.pct)}%</span>
        <span class="bar"><i style="width:${clamp(r.pct, 0, 100)}%;background:${colors.get(r.x.model) || familyColor(r.x.modelFamily)}"></i></span>
        <span class="ms num"><span>${fmtUsd(r.x.estimatedCostUsd)} (${fmtPct(r.x.costSharePercent)}%)</span><span>${fmtTok(r.x.totalTokens)} tok (${fmtPct(r.x.tokenSharePercent)}%)</span><span>${fmtInt(r.x.workerCount)} ${esc(L('Worker', 'workers'))}</span><span>${fmtInt(r.x.plannerSteps)} ${esc(L('调用', 'calls'))}</span></span>
      </div>`).join('') || `<div class="empty sm">${esc(L('暂无模型数据', 'No model data'))}</div>`}
    </div>
    <div class="section-head" style="margin:14px 0 6px"><h3 class="section-title">${esc(L('Token 构成', 'Token Composition'))}</h3><span class="spacer"></span><span class="section-note num">${fmtTok(t.totalTokens)} tok</span></div>
    ${splitBar(t).replace('class="split"', 'class="split" style="height:8px"')}
    <div class="tok-legend">${tokLegend}</div>`;
}

/* Timeline ------------------------------------------------------------------ */
function renderTimeline() {
  const box = $('timeline');
  const d = state.details.get(state.selectedId);
  const tl = (d?.timeline || []).map((e) => ({ ...e, ms: parseTs(e.timestamp) })).filter((e) => Number.isFinite(e.ms)).sort((a, b) => a.ms - b.ms);
  if (tl.length < 2) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const t0 = tl[0].ms, t1 = tl[tl.length - 1].ms, span = Math.max(1, t1 - t0);
  const N = Math.min(40, Math.max(8, Math.ceil(tl.length / 2)));
  const buckets = Array.from({ length: N }, (_, i) => ({ cost: 0, tokens: 0, steps: 0, from: t0 + (span * i) / N, to: t0 + (span * (i + 1)) / N, workers: new Map() }));
  for (const e of tl) {
    const i = Math.min(N - 1, Math.floor(((e.ms - t0) / span) * N));
    const b = buckets[i];
    b.cost += num(e.stepCostUsd); b.tokens += num(e.stepTokens); b.steps++;
    b.workers.set(e.worker, (b.workers.get(e.worker) || 0) + num(e.stepCostUsd));
  }
  const max = Math.max(...buckets.map((b) => b.cost), 1e-9);
  const W = 300, H = 80, bw = W / N;
  const finalCum = num(tl[tl.length - 1].cumulativeCostUsd) || buckets.reduce((a, b) => a + b.cost, 0) || 1e-9;
  let cum = 0;
  const pts = [`0,${H}`];
  const bars = buckets.map((b, i) => {
    cum += b.cost;
    pts.push(`${((i + 1) * bw).toFixed(2)},${(H - (cum / finalCum) * (H - 4)).toFixed(2)}`);
    const h = b.cost > 0 ? Math.max(1.5, (b.cost / max) * (H - 8)) : 0;
    const top = [...b.workers.entries()].sort((a, c) => c[1] - a[1]).slice(0, 3).map(([n, c]) => `${n} ${fmtUsd(c)}`).join('\n');
    return `<rect class="tb" x="${(i * bw + 0.6).toFixed(2)}" y="${(H - h).toFixed(2)}" width="${Math.max(0.5, bw - 1.2).toFixed(2)}" height="${h.toFixed(2)}"
      data-tip="${esc(`${fmtClock(b.from)} – ${fmtClock(b.to)}\n${fmtUsd(b.cost)} · ${fmtTok(b.tokens)} tok · ${b.steps} 步${top ? '\n' + top : ''}`)}"></rect>
      <rect x="${(i * bw).toFixed(2)}" y="0" width="${bw.toFixed(2)}" height="${H}" fill="transparent" data-tip="${esc(`${fmtClock(b.from)} – ${fmtClock(b.to)}\n${fmtUsd(b.cost)} · ${fmtTok(b.tokens)} tok · ${b.steps} 步${top ? '\n' + top : ''}`)}"></rect>`;
  }).join('');
  box.innerHTML = `
    <div class="section-head">
      <h3 class="section-title">${esc(L('花费时间线', 'Spend Timeline'))}</h3><span class="spacer"></span>
      <span class="section-note num">${esc(L(`柱：区间花费 · 线：累计 ${fmtUsd(finalCum)}`, `Bars: bucket spend · Line: cumulative ${fmtUsd(finalCum)}`))}</span>
    </div>
    <svg class="timeline" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="花费时间线">
      <line class="grid" x1="0" y1="${H - 0.5}" x2="${W}" y2="${H - 0.5}" vector-effect="non-scaling-stroke"></line>
      <line class="grid" x1="0" y1="${H / 2}" x2="${W}" y2="${H / 2}" vector-effect="non-scaling-stroke" stroke-dasharray="2 3"></line>
      ${bars}
      <polyline class="cum" points="${pts.join(' ')}" vector-effect="non-scaling-stroke"></polyline>
    </svg>
    <div class="timeline-axis num"><span>${esc(fmtClock(t0))}</span><span>${esc(fmtDuration(span / 1000))}</span><span>${esc(fmtClock(t1))}</span></div>`;
}

/* ------------------------------------------------------------------ */
/* Highlight sync (donut <-> legend <-> stack bar <-> worker cards)     */
/* ------------------------------------------------------------------ */
function applyHighlight() {
  const name = state.hl;
  const hero = $('hero');
  for (const sel of ['#donut', '#legend', '#worker-stack', '#workers']) {
    const el = hero.querySelector(sel);
    if (el) el.classList.toggle('dimming', !!name);
  }
  for (const el of hero.querySelectorAll('[data-w]')) el.classList.toggle('hl', !!name && el.dataset.w === name);
  const c = $('donut-center');
  const ctx = state.donutCtx;
  if (c && ctx) c.innerHTML = donutCenter(name, ctx.m, ctx.totalV, ctx.centerSub);
  const sid = state.hlSwarm;
  const ss = $('swarm-stack');
  if (ss) ss.classList.toggle('dimming', !!sid);
  for (const el of document.querySelectorAll('#swarms [data-swarm]')) el.classList.toggle('hl', !!sid && el.dataset.swarm === sid);
}

/* ------------------------------------------------------------------ */
/* Tooltip                                                             */
/* ------------------------------------------------------------------ */
const tip = $('tip');
let tipTarget = null;
function showTip(target, x, y) {
  const text = target.getAttribute('data-tip');
  if (!text) return hideTip();
  if (tipTarget !== target) {
    const [head, ...rest] = text.split('\n');
    tip.innerHTML = `<b>${esc(head)}</b>${rest.length ? '<br>' + rest.map(esc).join('<br>') : ''}`;
    tipTarget = target;
  }
  tip.classList.add('show');
  const r = tip.getBoundingClientRect();
  let left = x + 12, top = y + 14;
  if (left + r.width > innerWidth - 6) left = Math.max(6, x - r.width - 10);
  if (top + r.height > innerHeight - 6) top = Math.max(6, y - r.height - 10);
  tip.style.left = left + 'px';
  tip.style.top = top + 'px';
}
function hideTip() { tip.classList.remove('show'); tipTarget = null; }
document.addEventListener('pointermove', (e) => {
  const t = e.target.closest?.('[data-tip]');
  if (t && e.pointerType !== 'touch') showTip(t, e.clientX, e.clientY); else if (tipTarget) hideTip();
}, { passive: true });
document.addEventListener('pointerleave', hideTip);
addEventListener('scroll', hideTip, { passive: true, capture: true });

/* ------------------------------------------------------------------ */
/* Pricing drawer                                                      */
/* ------------------------------------------------------------------ */
async function openDrawer() {
  $('scrim').classList.remove('hidden');
  $('drawer').classList.remove('hidden');
  $('drawer-close').focus();
  renderDrawer();
  if (!state.pricing) {
    try { state.pricing = await getJson('/api/pricing'); } catch (e) { state.pricing = { error: e?.message || String(e) }; }
    if (!$('drawer').classList.contains('hidden')) renderDrawer();
  }
}
function closeDrawer() {
  $('scrim').classList.add('hidden');
  $('drawer').classList.add('hidden');
  $('btn-info').focus();
}
function renderDrawer() {
  const p = state.pricing;
  const body = $('drawer-body');
  const d = state.details.get(state.selectedId);
  const used = new Set();
  for (const w of d?.workers || []) { if (w.model) used.add(w.model.toLowerCase()); for (const mm of w.modelsUsed || []) used.add(String(mm).toLowerCase()); }
  for (const s of swarmsAll()) for (const mm of s.models || []) used.add(String(mm).toLowerCase());
  const isUsed = (m) => [m.id, m.label, ...(m.aliases || [])].some((x) => x && used.has(String(x).toLowerCase()));
  const rules = p?.estimationRules || {};
  const legend = `<section>
      <h3>${esc(L('数据来源标记', 'Data Source Badges'))}</h3>
      <ul style="list-style:none;padding:0;display:flex;flex-direction:column;gap:6px">
        <li>${srcBadge('exact')} ${esc(L('来自 transcript 中 PLANNER_RESPONSE 的精确 usage（input / cache_read / output）。', 'Exact usage fields (input / cache_read / output) from PLANNER_RESPONSE transcripts.'))}</li>
        <li>${srcBadge('mixed')} ${esc(L('同一 Worker / Swarm 中精确计数与估算步骤并存。', 'Mix of exact usage and estimated steps in the same Worker/Swarm.'))}</li>
        <li>${srcBadge('estimated')} ${esc(L(`无 usage 字段时按字符估算：CJK ≈ ${rules.cjkCharsPerToken ?? 1.5} 字/Token，拉丁字符 ≈ ${rules.latinCharsPerToken ?? 4} 字/Token。`, `Fallback character estimate: CJK ~${rules.cjkCharsPerToken ?? 1.5} ch/tok, Latin ~${rules.latinCharsPerToken ?? 4} ch/tok.`))}</li>
      </ul>
    </section>
    <section>
      <h3>${esc(L('计算口径', 'Methodology'))}</h3>
      <ul>
        <li>${esc(L(`费用 = Input × 输入单价 + Cache Read × 缓存单价 + Output × 输出单价（每 1M Token，${p?.currency || 'USD'}）。`, `Cost = Input × input rate + Cache Read × cache rate + Output × output rate (per 1M tokens, ${p?.currency || 'USD'}).`))}</li>
        <li>${esc(L(`Total Token = Input + Cache Read + Output。${rules.thinkingIncludedInExactOutput !== false ? 'Thinking 已包含在精确 Output 中，单独展示时仅为估算拆分，不重复计费。' : ''}`, `Total Tokens = Input + Cache Read + Output.${rules.thinkingIncludedInExactOutput !== false ? ' Thinking is already included in exact Output (not double-counted).' : ''}`))}</li>
        <li>${esc(L('占比 = Worker（或 Swarm）数值 ÷ 所在 Swarm（或全部 Swarm）合计。', 'Share % = Worker (or Swarm) metric divided by Swarm (or global) total.'))}</li>
        <li>${L('所有金额均为<strong>估算</strong>，与实际账单可能存在差异。', 'All dollar figures are <strong>estimates</strong> and may differ from official billing.')}</li>
      </ul>
    </section>`;
  if (!p) { body.innerHTML = legend + `<section><h3>${esc(L('模型单价', 'Model Rates'))}</h3><span class="skel skel-line" style="width:100%;height:120px"></span></section>`; return; }
  if (p.error) { body.innerHTML = legend + `<section><h3>${esc(L('模型单价', 'Model Rates'))}</h3><div class="banner"><span class="banner-text">${esc(L('无法加载 /api/pricing：', 'Failed to load /api/pricing: '))}${esc(p.error)}</span><button type="button" class="ghost-btn" data-act="reload-pricing">${esc(L('重试', 'Retry'))}</button></div></section>`; return; }
  const models = [...(p.models || [])].sort((a, b) => (isUsed(b) - isUsed(a)) || String(a.family).localeCompare(String(b.family)) || num(b.outputPer1M) - num(a.outputPer1M));
  const n2 = (v) => (Number.isFinite(+v) ? '$' + (+v).toFixed(+v < 1 ? 3 : 2) : '—');
  body.innerHTML = legend + `<section>
      <h3>${esc(L('模型单价', 'Model Rates'))} <span class="faint" style="font-weight:400">USD / 1M Token</span></h3>
      ${p.notes ? `<p>${esc(p.notes)}</p>` : ''}
      <div class="ptable-wrap"><table class="ptable num">
        <thead><tr><th>${esc(L('模型', 'Model'))}</th><th>Input</th><th>Cache</th><th>Output</th><th>Thinking</th></tr></thead>
        <tbody>${models.map((m) => `<tr class="${isUsed(m) ? 'used' : ''}${/default|fallback/i.test(m.id) ? ' default' : ''}" title="${esc([m.id, ...(m.aliases || [])].join(', '))}">
          <td><span style="display:inline-flex;align-items:center;gap:6px"><span class="swatch round" style="background:${familyColor(m.family)}"></span>${esc(m.label || m.id)}${isUsed(m) ? ` <span class="badge active">${esc(L('使用中', 'In use'))}</span>` : ''}</span>${m.tier ? `<div class="faint" style="font-size:10px">${esc(m.tier)}</div>` : ''}</td>
          <td>${n2(m.inputPer1M)}</td><td>${n2(m.cacheReadPer1M)}</td><td>${n2(m.outputPer1M)}</td><td>${n2(m.thinkingPer1M)}</td>
        </tr>`).join('')}</tbody>
      </table></div>
    </section>`;
}

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */
document.addEventListener('click', (e) => {
  const t = e.target;
  const tabBtn = t.closest('[data-tab]');
  if (tabBtn) { switchTab(tabBtn.dataset.tab); return; }
  const sw = t.closest('[data-select-swarm]');
  if (sw) { selectSwarm(sw.dataset.selectSwarm); return; }
  const seg = t.closest('[data-swarm]');
  if (seg && seg.parentElement?.id === 'swarm-stack') { selectSwarm(seg.dataset.swarm); return; }
  const met = t.closest('[data-metric]');
  if (met) { state.metric = met.dataset.metric; savePrefs(); render(); return; }
  const sf = t.closest('[data-swarm-filter]');
  if (sf) { state.swarmFilter = sf.dataset.swarmFilter; render(); return; }
  const tw = t.closest('[data-toggle-worker]');
  if (tw) {
    const n = tw.dataset.toggleWorker;
    if (state.expanded.has(n)) state.expanded.delete(n); else state.expanded.add(n);
    renderHero(); applyHighlight(); return;
  }
  const leg = t.closest('.legend-item[data-w], #worker-stack [data-w], #donut [data-w]');
  if (leg) {
    const n = leg.dataset.w;
    state.expanded.add(n);
    renderHero(); applyHighlight();
    const card = [...document.querySelectorAll('#workers .worker')].find((el) => el.dataset.w === n);
    card?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    return;
  }
  const act = t.closest('[data-act]');
  if (act?.dataset.act === 'retry') { refresh({ force: true }); return; }
  if (act?.dataset.act === 'reload-pricing') { state.pricing = null; openDrawer(); return; }
  const qsz = t.closest('[data-qsize]');
  if (qsz) { updateSettings({ quotaWidgetSize: qsz.dataset.qsize }); return; }
  const lg = t.closest('[data-lang]');
  if (lg) { updateSettings({ language: lg.dataset.lang }); return; }
  if (t.closest('[data-dock-expand]')) { updateSettings({ quotaWidgetSize: 'expanded' }); return; }
  if (t.closest('[data-dock-collapse]')) { updateSettings({ quotaWidgetSize: 'mini' }); return; }
  // Close settings popover when clicking outside the popover and its trigger button.
  if (state.settingsOpen && !t.closest('#settings-pop') && !t.closest('#btn-settings')) {
    setSettingsOpen(false);
  }
});
document.addEventListener('toggle', (e) => {
  if (e.target.id === 'qd-models-det') state.modelsOpen = e.target.open;
}, true);
document.addEventListener('change', (e) => {
  if (e.target.id === 'sort') { state.sort = e.target.value; savePrefs(); renderHero(); applyHighlight(); }
  else if (e.target.id === 'swarm-pick') selectSwarm(e.target.value);
  else if (e.target.id === 'opt-weekly') updateSettings({ showWeeklyQuota: !!e.target.checked });
});
function setSettingsOpen(open) {
  state.settingsOpen = !!open;
  $('settings-pop').classList.toggle('hidden', !state.settingsOpen);
  $('btn-settings').setAttribute('aria-expanded', String(state.settingsOpen));
  if (state.settingsOpen) syncSettingsUI();
}
$('btn-settings').addEventListener('click', (e) => {
  e.stopPropagation();
  setSettingsOpen(!state.settingsOpen);
});
$('sp-close').addEventListener('click', () => { setSettingsOpen(false); $('btn-settings').focus(); });
$('hero').addEventListener('pointerover', (e) => {
  const el = e.target.closest('[data-w]');
  const n = el ? el.dataset.w : null;
  if (n !== state.hl) { state.hl = n; applyHighlight(); }
});
$('hero').addEventListener('pointerleave', () => { if (state.hl) { state.hl = null; applyHighlight(); } });
$('swarms').addEventListener('pointerover', (e) => {
  const el = e.target.closest('[data-swarm]');
  const n = el ? el.dataset.swarm : null;
  if (n !== state.hlSwarm) { state.hlSwarm = n; applyHighlight(); }
});
$('swarms').addEventListener('pointerleave', () => { if (state.hlSwarm) { state.hlSwarm = null; applyHighlight(); } });

$('btn-refresh').addEventListener('click', () => refresh({ force: true }));
$('banner-retry').addEventListener('click', () => refresh({ force: true }));
$('btn-pause').addEventListener('click', () => {
  state.paused = !state.paused;
  savePrefs();
  syncPauseBtn();
  if (state.paused) clearTimeout(state.timer); else refresh();
  setLive();
});
function syncPauseBtn() {
  const b = $('btn-pause');
  if (!b) return;
  b.setAttribute('aria-pressed', String(state.paused));
  const label = state.paused ? L('恢复自动刷新', 'Resume auto-refresh') : L('暂停自动刷新', 'Pause auto-refresh');
  b.title = label; b.setAttribute('aria-label', label);
  b.innerHTML = icon(state.paused ? 'i-play' : 'i-pause');
}
const iv = $('interval');
if (![...iv.options].some((o) => +o.value === state.intervalMs)) state.intervalMs = 5000;
iv.value = String(state.intervalMs);
iv.addEventListener('change', () => { state.intervalMs = +iv.value; savePrefs(); setLive(); schedule(); });
$('btn-info').addEventListener('click', openDrawer);
$('drawer-close').addEventListener('click', closeDrawer);
$('scrim').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (state.settingsOpen) { setSettingsOpen(false); $('btn-settings').focus(); return; }
    if (!$('drawer').classList.contains('hidden')) { closeDrawer(); return; }
  } else if ((e.key === 'r' || e.key === 'R') && !e.ctrlKey && !e.metaKey && !e.altKey && !/input|select|textarea/i.test(e.target.tagName)) {
    refresh({ force: true });
  }
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !state.paused && Date.now() - state.lastOk > state.intervalMs) refresh();
});

function showFatalError(msg) {
  try {
    const sk = $('skeleton');
    if (sk) sk.classList.add('hidden');
    const b = $('banner');
    const bt = $('banner-text');
    if (b && bt) {
      bt.textContent = `前端加载异常：${msg}`;
      b.classList.remove('hidden');
    }
    const lab = $('live-label');
    if (lab) lab.textContent = '错误';
  } catch { /* ignore */ }
}
window.addEventListener('error', (e) => {
  if (state.firstLoad) showFatalError(e?.message || '脚本错误');
});
window.addEventListener('unhandledrejection', (e) => {
  if (state.firstLoad) showFatalError(e?.reason?.message || String(e?.reason || '未处理的异步错误'));
});

try {
  syncPauseBtn();
  syncSettingsUI();
  loadSettings();
  refresh();
} catch (err) {
  showFatalError(err?.message || String(err));
}
})();
