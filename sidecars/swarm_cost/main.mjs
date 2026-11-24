/**
 * Swarm Cost Monitor sidecar HTTP server.
 *
 * Dual-mode zero-dependency server:
 * 1. Under Antigravity (when `sidecar_sdk` is injected by the sidecar launcher),
 *    mounts routes on `SidecarApp` so `/preload.js`, theme tokens, and sidecar
 *    port/auth wiring work natively in the Auxiliary Pane.
 * 2. Standalone (`node main.mjs`), runs a pure `node:http` server on 127.0.0.1
 *    serving `./public`, a lightweight `/preload.js` stub, and the identical
 *    REST JSON API (including both `/api/swarm?id=...` and `/api/swarms/:id`).
 */

import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPricingTable } from './pricing.mjs';
import { findAppDataDirs, getConversationContext, getOverview, getSwarmDetail, scanSwarms } from './scanner.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');
const SERVICE_NAME = 'swarm-cost-monitor';
const VERSION = '1.2.0';
const STARTED_AT_MS = Date.now();
const MAX_POST_BYTES = 16 * 1024;
const VALID_WIDGET_SIZES = new Set(['mini', 'compact', 'expanded']);
const VALID_LANGUAGES = new Set(['zh', 'en']);
const DEFAULT_SETTINGS = {
  quotaWidgetSize: 'mini',
  showWeeklyQuota: false,
  language: 'zh',
  updatedAt: null,
};

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const STANDALONE_PRELOAD_JS =
  'window.sidecar = window.sidecar || null;\n';

function mimeFor(filePath) {
  return MIME_TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function isTruthyFlag(val) {
  return val === '1' || val === 'true' || val === true;
}

function safePublicPath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  const rel = normalize(decoded).replace(/^([/\\])+/, '');
  if (!rel || rel.startsWith('..') || rel.includes('\0')) return null;
  const full = resolve(PUBLIC_DIR, rel);
  const root = resolve(PUBLIC_DIR);
  const rootCmp = process.platform === 'win32' ? root.toLowerCase() : root;
  const fullCmp = process.platform === 'win32' ? full.toLowerCase() : full;
  if (fullCmp !== rootCmp && !fullCmp.startsWith(rootCmp + (process.platform === 'win32' ? '\\' : '/'))) {
    return null;
  }
  return full;
}

function listPublicFiles(dir = PUBLIC_DIR, prefix = '') {
  const out = [];
  if (!existsSync(dir)) return out;
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (st.isDirectory()) {
      out.push(...listPublicFiles(full, rel));
    } else if (st.isFile()) {
      out.push({ route: `/${rel}`, filePath: full, mime: mimeFor(full) });
    }
  }
  return out;
}

function readIndexHtml() {
  const indexPath = join(PUBLIC_DIR, 'index.html');
  if (!existsSync(indexPath)) {
    return '<!doctype html><meta charset="utf-8"><title>Swarm Cost Monitor</title><body><p>UI assets not found in ./public/index.html</p></body>';
  }
  return readFileSync(indexPath, 'utf-8');
}

function buildHealth(mode) {
  const scan = scanSwarms({ force: false });
  return {
    ok: true,
    service: SERVICE_NAME,
    version: VERSION,
    mode,
    nodeVersion: process.version,
    appDataDirs: findAppDataDirs(),
    discoveredSwarms: scan.orderedIds.length,
    uptimeSec: Math.max(0, Math.round((Date.now() - STARTED_AT_MS) / 1000)),
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Persistent user settings (`GET /api/settings` & `POST /api/settings`)
// ---------------------------------------------------------------------------

function resolveSettingsPath() {
  if (process.env.SWARM_COST_SETTINGS_PATH) {
    return resolve(process.env.SWARM_COST_SETTINGS_PATH);
  }
  if (process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR) {
    return join(resolve(process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR), 'settings.json');
  }
  const appData = findAppDataDirs()[0] || join(homedir(), '.gemini', 'antigravity');
  return join(appData, 'sidecar_data', 'swarm-cost-monitor', 'swarm_cost', 'data', 'settings.json');
}

function sanitizeStoredSettings(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_SETTINGS };
  }
  return {
    quotaWidgetSize: VALID_WIDGET_SIZES.has(raw.quotaWidgetSize)
      ? raw.quotaWidgetSize
      : DEFAULT_SETTINGS.quotaWidgetSize,
    showWeeklyQuota:
      typeof raw.showWeeklyQuota === 'boolean'
        ? raw.showWeeklyQuota
        : DEFAULT_SETTINGS.showWeeklyQuota,
    language: VALID_LANGUAGES.has(raw.language)
      ? raw.language
      : DEFAULT_SETTINGS.language,
    updatedAt: typeof raw.updatedAt === 'string' && raw.updatedAt ? raw.updatedAt : null,
  };
}

function readSettings() {
  const filePath = resolveSettingsPath();
  if (!existsSync(filePath)) return { ...DEFAULT_SETTINGS };
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
    return sanitizeStoredSettings(parsed);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function updateSettings(input) {
  let body = input;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return { status: 400, error: 'Invalid JSON body' };
    }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 400, error: 'Settings payload must be a JSON object' };
  }

  if (body.quotaWidgetSize !== undefined && !VALID_WIDGET_SIZES.has(body.quotaWidgetSize)) {
    return {
      status: 400,
      error: 'Invalid quotaWidgetSize; expected "mini", "compact", or "expanded"',
    };
  }
  if (body.showWeeklyQuota !== undefined && typeof body.showWeeklyQuota !== 'boolean') {
    return {
      status: 400,
      error: 'Invalid showWeeklyQuota; expected boolean',
    };
  }
  if (body.language !== undefined && !VALID_LANGUAGES.has(body.language)) {
    return {
      status: 400,
      error: 'Invalid language; expected "zh" or "en"',
    };
  }

  const current = readSettings();
  const next = {
    quotaWidgetSize:
      body.quotaWidgetSize !== undefined ? body.quotaWidgetSize : current.quotaWidgetSize,
    showWeeklyQuota:
      body.showWeeklyQuota !== undefined ? body.showWeeklyQuota : current.showWeeklyQuota,
    language:
      body.language !== undefined ? body.language : current.language,
    updatedAt: new Date().toISOString(),
  };

  const filePath = resolveSettingsPath();
  const dir = dirname(filePath);
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(tmpPath, JSON.stringify(next, null, 2) + '\n', 'utf-8');
    renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup error.
    }
    return { status: 500, error: `Failed to persist settings: ${err?.message || err}` };
  }

  return { status: 200, settings: next };
}

function readJsonBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    let total = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_POST_BYTES) {
        rejectBody(Object.assign(new Error('Request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8').trim();
      if (!raw) {
        resolveBody({});
        return;
      }
      try {
        resolveBody(JSON.parse(raw));
      } catch {
        rejectBody(Object.assign(new Error('Invalid JSON body'), { status: 400 }));
      }
    });
    req.on('error', (err) => rejectBody(err));
  });
}

// ---------------------------------------------------------------------------
// Mode 1: Antigravity SidecarApp (`sidecar_sdk` injected by host launcher)
// ---------------------------------------------------------------------------

async function tryStartWithSidecarSdk() {
  if (
    !process.env.ANTIGRAVITY_SIDECAR_WEB_PORT ||
    !process.env.ANTIGRAVITY_LS_ADDRESS ||
    !process.env.ANTIGRAVITY_CSRF_TOKEN
  ) {
    return false;
  }

  let sdk = null;
  try {
    sdk = await import('sidecar_sdk');
  } catch {
    return false;
  }
  if (!sdk || typeof sdk.SidecarApp !== 'function') return false;

  const { SidecarApp, Response } = sdk;
  let app;
  try {
    app = new SidecarApp();
  } catch (err) {
    console.warn(`[swarm_cost] SidecarApp unavailable, falling back to standalone HTTP: ${err?.message || err}`);
    return false;
  }

  app.page('/', () => readIndexHtml());

  // Register static files discovered under ./public (re-read on request so live edits apply).
  const registeredStatic = new Set(['/']);
  for (const item of listPublicFiles()) {
    if (item.route === '/index.html' || registeredStatic.has(item.route)) continue;
    registeredStatic.add(item.route);
    app.api(
      item.route,
      () => {
        try {
          const isText = item.mime.startsWith('text/') || item.mime.includes('javascript') || item.mime.includes('json') || item.mime.includes('svg');
          const body = isText ? readFileSync(item.filePath, 'utf-8') : readFileSync(item.filePath);
          return new Response(body, { contentType: item.mime });
        } catch {
          return new Response('Not Found', { status: 404, contentType: 'text/plain; charset=utf-8' });
        }
      },
      'GET'
    );
  }

  app.api('/api/health', () => buildHealth('sidecar_sdk'), 'GET');

  app.api('/api/pricing', () => getPricingTable(), 'GET');

  app.api('/api/settings', () => readSettings(), 'GET');

  app.api(
    '/api/settings',
    (data) => {
      const result = updateSettings(data);
      if (result.error) {
        return new Response(JSON.stringify({ error: result.error }), {
          status: result.status || 400,
          contentType: 'application/json; charset=utf-8',
        });
      }
      return result.settings;
    },
    'POST'
  );

  app.api(
    '/api/overview',
    async (data) => {
      const conversationId =
        data?.conversationId ||
        app.config?.conversationId ||
        process.env.ANTIGRAVITY_CONVERSATION_ID ||
        null;
      const force = isTruthyFlag(data?.force);
      return getOverview({ conversationId, force });
    },
    'GET'
  );

  app.api(
    '/api/swarm',
    (data) => {
      const id = typeof data?.id === 'string' ? data.id : '';
      const conversationId =
        data?.conversationId ||
        app.config?.conversationId ||
        process.env.ANTIGRAVITY_CONVERSATION_ID ||
        '';
      const force = isTruthyFlag(data?.force);
      const detail = getSwarmDetail({ id, conversationId, force });
      if (!detail) {
        return new Response(JSON.stringify({ error: 'Swarm not found', id: id || null }), {
          status: 404,
          contentType: 'application/json; charset=utf-8',
        });
      }
      return detail;
    },
    'GET'
  );

  app.api(
    '/api/context',
    (data) => {
      const conversationId =
        data?.conversationId ||
        app.config?.conversationId ||
        process.env.ANTIGRAVITY_CONVERSATION_ID ||
        '';
      const force = isTruthyFlag(data?.force);
      return getConversationContext({ conversationId, force });
    },
    'GET'
  );

  console.log(`[swarm_cost] starting in sidecar_sdk mode (appData: ${findAppDataDirs().join(', ')})`);
  app.run();
  return true;
}

// ---------------------------------------------------------------------------
// Mode 2: Standalone zero-dependency `node:http` server
// ---------------------------------------------------------------------------

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendStatic(res, filePath) {
  try {
    const data = readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type': mimeFor(filePath),
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: 'File not found' });
  }
}

function startStandaloneServer() {
  const rawPort =
    process.env.ANTIGRAVITY_SIDECAR_WEB_PORT ??
    process.env.SIDECAR_PORT ??
    process.env.PORT ??
    '43123';
  const port = Number.isFinite(Number(rawPort)) ? Number(rawPort) : 43123;
  const host = process.env.HOST || '127.0.0.1';

  const server = createServer(async (req, res) => {
    try {
      const method = (req.method || 'GET').toUpperCase();
      const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
      const pathname = url.pathname;
      const params = url.searchParams;

      if (pathname === '/api/settings') {
        if (method === 'GET' || method === 'HEAD') {
          sendJson(res, 200, readSettings());
          return;
        }
        if (method === 'POST') {
          let body;
          try {
            body = await readJsonBody(req);
          } catch (err) {
            sendJson(res, err?.status || 400, { error: String(err?.message || 'Invalid JSON body') });
            return;
          }
          const result = updateSettings(body);
          if (result.error) {
            sendJson(res, result.status || 400, { error: result.error });
            return;
          }
          sendJson(res, 200, result.settings);
          return;
        }
        sendJson(res, 405, { error: 'Method not allowed' });
        return;
      }

      if (method !== 'GET' && method !== 'HEAD') {
        sendJson(res, 405, { error: 'Method not allowed' });
        return;
      }

      if (pathname === '/api/health') {
        sendJson(res, 200, buildHealth('standalone'));
        return;
      }

      if (pathname === '/api/pricing') {
        sendJson(res, 200, getPricingTable());
        return;
      }

      if (pathname === '/api/overview') {
        const conversationId =
          params.get('conversationId') || process.env.ANTIGRAVITY_CONVERSATION_ID || null;
        const force = isTruthyFlag(params.get('force'));
        const overview = await getOverview({ conversationId, force });
        sendJson(res, 200, overview);
        return;
      }

      if (pathname === '/api/swarm') {
        const id = params.get('id') || '';
        const conversationId =
          params.get('conversationId') || process.env.ANTIGRAVITY_CONVERSATION_ID || '';
        const force = isTruthyFlag(params.get('force'));
        const detail = getSwarmDetail({ id, conversationId, force });
        if (!detail) {
          sendJson(res, 404, { error: 'Swarm not found', id: id || null });
          return;
        }
        sendJson(res, 200, detail);
        return;
      }

      if (pathname === '/api/context') {
        const conversationId =
          params.get('conversationId') || process.env.ANTIGRAVITY_CONVERSATION_ID || '';
        const force = isTruthyFlag(params.get('force'));
        sendJson(res, 200, getConversationContext({ conversationId, force }));
        return;
      }

      if (pathname.startsWith('/api/swarms/')) {
        const rawId = pathname.slice('/api/swarms/'.length).replace(/\/+$/, '');
        let id = '';
        try {
          id = decodeURIComponent(rawId);
        } catch {
          sendJson(res, 400, { error: 'Invalid swarm id encoding' });
          return;
        }
        const force = isTruthyFlag(params.get('force'));
        const detail = getSwarmDetail({ id, force });
        if (!detail) {
          sendJson(res, 404, { error: 'Swarm not found', id });
          return;
        }
        sendJson(res, 200, detail);
        return;
      }

      if (pathname.startsWith('/api/')) {
        sendJson(res, 404, { error: 'Unknown API endpoint', path: pathname });
        return;
      }

      if (pathname === '/preload.js') {
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-cache',
        });
        res.end(STANDALONE_PRELOAD_JS);
        return;
      }

      if (pathname === '/' || pathname === '/index.html') {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache',
        });
        res.end(readIndexHtml());
        return;
      }

      const candidate = safePublicPath(pathname);
      if (candidate && existsSync(candidate)) {
        try {
          if (statSync(candidate).isFile()) {
            sendStatic(res, candidate);
            return;
          }
        } catch {
          // Fall through to 404 / SPA fallback.
        }
      }

      // SPA fallback for extensionless non-API routes.
      if (!extname(pathname)) {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache',
        });
        res.end(readIndexHtml());
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
    } catch (err) {
      sendJson(res, 500, { error: 'Internal server error', detail: String(err?.message || err) });
    }
  });

  server.listen(port, host, () => {
    const addr = server.address();
    const actualPort = typeof addr === 'object' && addr ? addr.port : port;
    console.log(
      `[swarm_cost] standalone listening on http://${host}:${actualPort} (appData: ${findAppDataDirs().join(', ')})`
    );
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const startedSdk = await tryStartWithSidecarSdk();
if (!startedSdk) {
  startStandaloneServer();
}
