// @pipeworx/mcp-<slug> -- library half of the gateway bridge (lib/index.js).
//
// Copied VERBATIM into every gateway-mode pack package by scripts/publish-pack.sh
// (fleet #3759, docs/standalone-via-gateway-plan.md section 1). There is no
// per-pack templating: the slug and version are read from this package's own
// package.json (`pipeworx.slug`, `version`) at load time, so the same bytes
// ship in every package and the source hash can cover them once. Edit this
// file in the monorepo (scripts/templates/standalone-gateway-lib.js), never a
// per-pack copy.
//
// What it is: a relay. Every JSON-RPC message goes to
// ${PIPEWORX_GATEWAY_URL:-https://gateway.pipeworx.io}/<slug>/mcp, the same
// endpoint a hosted MCP client uses, so tiers, rate limits and credits apply
// exactly as they do there. There is no local mode: the pack's code is not in
// this package.
//
// Zero dependencies, plain ESM, Node 18+ (global fetch). Nothing here writes
// to stdout -- bin/cli.js owns stdout and it carries JSON-RPC only.
//
// Environment:
//   PIPEWORX_API_KEY      sent as `Authorization: Bearer <key>`. Never as
//                         X-API-Key: the gateway reads a pwx_ key sent that way
//                         as an unvalidated BYO string with no account.
//   PIPEWORX_GATEWAY_URL  gateway base URL (no path), default the public gateway.
//   PIPEWORX_META_TOOLS=1 list the gateway-wide tools (ask_pipeworx, ...) too.
//   PIPEWORX_TIMEOUT_MS   per-request timeout, default 120000.

import { readFileSync } from 'node:fs';

const readJson = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));

const PKG = readJson('../package.json');
export const SLUG = PKG.pipeworx && PKG.pipeworx.slug;
if (typeof SLUG !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/.test(SLUG)) {
  throw new Error(`${PKG.name}: package.json carries no valid pipeworx.slug -- this package was built wrong`);
}
/**
 * The pack's slug on the GATEWAY: the /<slug>/mcp route and the `_meta.pack`
 * every listed tool carries. Usually the same as `slug` (the npm/directory
 * name), but 14 packs differ -- `hex-pm` is `hex_pm` on the gateway -- and
 * filtering tools/list on the npm slug would match none of their tools
 * (fleet #3761). publish-pack.sh stamps it from the gateway manifest.
 */
export const GATEWAY_SLUG = (PKG.pipeworx && PKG.pipeworx.gatewaySlug) || SLUG;
if (typeof GATEWAY_SLUG !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/.test(GATEWAY_SLUG)) {
  throw new Error(`${PKG.name}: package.json carries an invalid pipeworx.gatewaySlug -- this package was built wrong`);
}
export const PACKAGE_NAME = PKG.name;
export const VERSION = PKG.version;

/** The pack's own tool definitions at publish time (the offline tools/list answer). */
export const tools = readJson('../tools.json');

const DEFAULT_GATEWAY = 'https://gateway.pipeworx.io';
const DEFAULT_TIMEOUT_MS = 120_000;
const SIGNUP_URL = 'https://pipeworx.io/signup';
const VIA = '(via pipeworx-standalone)';

/** Resolve the bridge's settings. Exported for the tests and for callTool. */
export function bridgeConfig(env = process.env, overrides = {}) {
  const base = String(overrides.gatewayUrl || env.PIPEWORX_GATEWAY_URL || DEFAULT_GATEWAY).trim().replace(/\/+$/, '');
  const apiKey = String(overrides.apiKey ?? env.PIPEWORX_API_KEY ?? '').trim();
  const t = Number(overrides.timeoutMs ?? env.PIPEWORX_TIMEOUT_MS);
  return {
    endpoint: `${base}/${GATEWAY_SLUG}/mcp`,
    apiKey,
    timeoutMs: Number.isFinite(t) && t > 0 ? t : DEFAULT_TIMEOUT_MS,
    metaTools: (overrides.metaTools ?? env.PIPEWORX_META_TOOLS) === '1' || overrides.metaTools === true,
  };
}

function requestHeaders(cfg) {
  const h = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    // Stable per package version: the gateway remembers a client's name by
    // identifier + User-Agent (workers/gateway/src/client-identity.ts).
    'User-Agent': `pipeworx-standalone/${VERSION} (${PACKAGE_NAME})`,
    // Analytics label only (blob11 = 'standalone'). It never changes tier,
    // limits or price -- anyone can send it.
    'X-Pipeworx-Surface': 'standalone',
  };
  if (cfg.apiKey) h.Authorization = `Bearer ${cfg.apiKey}`;
  return h;
}

/** Parse a gateway body: JSON, or the last JSON `data:` frame of an SSE stream. */
function parseBody(text, contentType) {
  if (/text\/event-stream/i.test(contentType || '')) {
    let last = null;
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      try { last = JSON.parse(line.slice(5).trim()); } catch { /* keep-alive or partial frame */ }
    }
    return last;
  }
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * POST one JSON-RPC message. Never throws: the outcome is one of
 *   { kind: 'http', status, headers, body, text }   the gateway answered
 *   { kind: 'network', detail }                      DNS, TLS, refused, reset
 *   { kind: 'timeout' }                              no answer in cfg.timeoutMs
 */
export async function postToGateway(message, cfg) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), cfg.timeoutMs);
  try {
    const res = await fetch(cfg.endpoint, {
      method: 'POST',
      headers: requestHeaders(cfg),
      body: JSON.stringify(message),
      signal: ac.signal,
    });
    const text = await res.text();
    return { kind: 'http', status: res.status, headers: res.headers, body: parseBody(text, res.headers.get('content-type')), text };
  } catch (err) {
    if (ac.signal.aborted || (err && (err.name === 'AbortError' || err.name === 'TimeoutError'))) return { kind: 'timeout' };
    const cause = err && err.cause;
    const detail = (cause && (cause.code || cause.message)) || (err && err.message) || String(err);
    return { kind: 'network', detail };
  } finally {
    clearTimeout(timer);
  }
}

// ── The key-not-accepted warning (one per process) ──────────────────

let warnedKeyIgnored = false;
const KEY_IGNORED = 'PIPEWORX_API_KEY was not accepted, calling anonymously.';

/** True when a key was sent but the gateway still served the call as anonymous. */
function keyIgnored(out, cfg) {
  return !!cfg.apiKey && out.kind === 'http' && (out.headers.get('x-ratelimit-tier') || '').toLowerCase() === 'anonymous';
}

function noteTier(out, cfg, warn) {
  if (!keyIgnored(out, cfg) || warnedKeyIgnored) return;
  warnedKeyIgnored = true;
  warn(`${PACKAGE_NAME}: ${KEY_IGNORED} Check the key at ${SIGNUP_URL}.`);
}

/** Test hook: forget that the warning was printed. */
export function _resetWarnings() { warnedKeyIgnored = false; }

// ── Results the host shows to the model ─────────────────────────────

function errorResult(text, detail) {
  const result = { content: [{ type: 'text', text }], isError: true };
  if (detail) result._meta = { pipeworx_standalone: detail };
  return result;
}

const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

function firstLine(text) {
  const line = String(text || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '(empty body)';
  return line.length > 200 ? `${line.slice(0, 200)}...` : line;
}

function unreachableText(cfg, out) {
  if (out.kind === 'timeout') {
    return `The Pipeworx gateway at ${cfg.endpoint} did not answer within ${Math.round(cfg.timeoutMs / 1000)}s, so this call timed out. `
      + `${PACKAGE_NAME} forwards every call to the Pipeworx gateway and has no local mode. Try again; a call that keeps timing out is worth reporting.`;
  }
  return `Could not reach the Pipeworx gateway at ${cfg.endpoint} (${out.detail}). `
    + `${PACKAGE_NAME} forwards every call to the Pipeworx gateway and has no local mode, so it needs network access.`;
}

function isAuthRequired(body) {
  return !!body && (body.error_code === 'authentication_required'
    || (body.error && body.error.data && body.error.data.reason === 'authentication_required'));
}

/** Map a tools/call outcome to the JSON-RPC response the host gets. */
function toolsCallResponse(id, out, cfg) {
  if (out.kind !== 'http') return rpcResult(id, errorResult(unreachableText(cfg, out), { reason: out.kind }));
  const { status, body } = out;

  // Anonymous daily cap: the gateway answers 401 with a JSON-RPC error whose
  // message is the offer. Hosts often swallow protocol errors, so hand it over
  // as a tool result the model actually reads.
  if (status === 401 && isAuthRequired(body)) {
    const data = (body.error && body.error.data) || {};
    const parts = [body.error && body.error.message ? body.error.message : 'The anonymous daily allowance is used up.'];
    if (data.resets_at) parts.push(`The anonymous allowance resets at ${data.resets_at}.`);
    parts.push(cfg.apiKey
      ? `${KEY_IGNORED} Check the key, or get a free one at ${SIGNUP_URL}.`
      : `To keep going now, set PIPEWORX_API_KEY in this MCP server's environment; a free key is at ${SIGNUP_URL}.`);
    return rpcResult(id, errorResult(parts.join('\n\n'), { status, reason: 'authentication_required', resets_at: data.resets_at ?? null }));
  }

  // A keyed tier over its cap: today the gateway answers 429 with a RESULT
  // that has no isError, which reads as a success (fleet #3760). Mark it.
  if (status === 429 && body && body.result && typeof body.result === 'object') {
    const result = { ...body.result, isError: true };
    if (cfg.apiKey && keyIgnored(out, cfg)) {
      result.content = [...(Array.isArray(result.content) ? result.content : []), { type: 'text', text: KEY_IGNORED }];
    }
    return rpcResult(id, result);
  }
  if ((status === 401 || status === 429) && body && body.error) {
    const extra = keyIgnored(out, cfg) ? ` ${KEY_IGNORED}` : '';
    return rpcResult(id, errorResult(`${body.error.message || `HTTP ${status}`}${extra}`, { status }));
  }

  // A real JSON-RPC answer (result or protocol error): relay it verbatim,
  // structuredContent and _meta (cost, tier, provenance) included.
  if (body && body.jsonrpc === '2.0' && (body.result !== undefined || body.error !== undefined) && status < 500) {
    return { ...body, id };
  }

  // 5xx, an HTML edge page, or anything else that is not JSON-RPC.
  return rpcResult(id, errorResult(`The Pipeworx gateway returned HTTP ${status}: ${firstLine(out.text)}`, { status }));
}

function localInitialize(params) {
  return {
    protocolVersion: (params && params.protocolVersion) || '2025-06-18',
    capabilities: { tools: {} },
    serverInfo: { name: PACKAGE_NAME, version: VERSION },
  };
}

const scopedInstructions = () =>
  `${PACKAGE_NAME} forwards to the Pipeworx gateway and lists only the ${SLUG} pack's tools. `
  + 'Set PIPEWORX_META_TOOLS=1 to also list ask_pipeworx and the other gateway-wide tools.';

/** `<host name> (via pipeworx-standalone)`. The slug stays OUT of the name: the
 *  gateway's scanner-name check substring-matches words like poll/watch/index. */
export function bridgedClientName(name) {
  const n = typeof name === 'string' && name.trim() ? name.trim() : 'unknown';
  return n.includes(VIA) ? n : `${n} ${VIA}`;
}

/**
 * Relay one JSON-RPC message to the gateway and return the response to write
 * back, or null for a notification. Never throws.
 *
 * @param {object} message  a parsed JSON-RPC request or notification
 * @param {{cfg?: object, warn?: (line: string) => void}} [opts]
 */
export async function relay(message, opts = {}) {
  const cfg = opts.cfg || bridgeConfig();
  const warn = opts.warn || ((line) => process.stderr.write(`${line}\n`));
  if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    const id = message && typeof message === 'object' && 'id' in message ? message.id : null;
    return rpcError(id ?? null, -32600, 'Invalid Request');
  }
  const isNotification = !('id' in message) || message.id === undefined;
  const id = message.id;

  if (isNotification) {
    const out = await postToGateway(message, cfg);
    if (out.kind !== 'http') warn(`${PACKAGE_NAME}: notification ${message.method} not delivered: ${unreachableText(cfg, out)}`);
    return null;
  }

  if (message.method === 'initialize') {
    const params = { ...(message.params || {}) };
    params.clientInfo = { ...(params.clientInfo || {}), name: bridgedClientName(params.clientInfo && params.clientInfo.name) };
    if (!params.clientInfo.version) params.clientInfo.version = '0';
    const out = await postToGateway({ ...message, params }, cfg);
    noteTier(out, cfg, warn);
    if (out.kind === 'http' && out.body && out.body.result && typeof out.body.result === 'object') {
      const result = { ...out.body.result, serverInfo: { name: PACKAGE_NAME, version: VERSION } };
      if (!cfg.metaTools) result.instructions = scopedInstructions();
      return rpcResult(id, result);
    }
    // The host must still start: answer locally and let the calls report the
    // gateway problem when they happen.
    warn(`${PACKAGE_NAME}: initialize answered locally -- ${out.kind === 'http' ? `gateway HTTP ${out.status}` : unreachableText(cfg, out)}`);
    return rpcResult(id, { ...localInitialize(message.params), instructions: scopedInstructions() });
  }

  if (message.method === 'tools/list') {
    const out = await postToGateway(message, cfg);
    noteTier(out, cfg, warn);
    const listed = out.kind === 'http' && out.body && out.body.result && Array.isArray(out.body.result.tools)
      ? out.body.result : null;
    if (listed) {
      if (cfg.metaTools) return rpcResult(id, listed);
      const own = listed.tools.filter((t) => t && t._meta && (t._meta.pack === GATEWAY_SLUG || t._meta.pack === SLUG));
      if (own.length > 0) return rpcResult(id, { ...listed, tools: own });
      warn(`${PACKAGE_NAME}: the gateway listed no ${SLUG} tools; serving the tool list bundled with this package`);
    } else {
      warn(`${PACKAGE_NAME}: tools/list served from the snapshot bundled with this package -- ${out.kind === 'http' ? `gateway HTTP ${out.status}` : unreachableText(cfg, out)}`);
    }
    return rpcResult(id, { tools });
  }

  if (message.method === 'tools/call') {
    const out = await postToGateway(message, cfg);
    noteTier(out, cfg, warn);
    return toolsCallResponse(id, out, cfg);
  }

  // Everything else (ping, resources/*, prompts/*, ...): relay as-is.
  const out = await postToGateway(message, cfg);
  noteTier(out, cfg, warn);
  if (out.kind === 'http' && out.body && out.body.jsonrpc === '2.0') return { ...out.body, id };
  if (message.method === 'ping') return rpcResult(id, {});
  return rpcError(id, -32603, out.kind === 'http'
    ? `The Pipeworx gateway returned HTTP ${out.status}: ${firstLine(out.text)}`
    : unreachableText(cfg, out));
}

/**
 * Call one of this pack's tools through the gateway -- the `{tools, callTool}`
 * shape earlier versions of this package exported. Resolves with the tool's
 * structured result; rejects with the gateway's message on any error.
 *
 * @param {string} name
 * @param {Record<string, unknown>} [args]
 * @param {{apiKey?: string, gatewayUrl?: string, timeoutMs?: number}} [opts]
 *        apiKey defaults to process.env.PIPEWORX_API_KEY.
 */
export async function callTool(name, args = {}, opts = {}) {
  const cfg = bridgeConfig(process.env, opts);
  const res = await relay({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, { cfg });
  if (res.error) throw new Error(res.error.message);
  const result = res.result || {};
  const text = Array.isArray(result.content)
    ? result.content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n')
    : '';
  if (result.isError) throw new Error(text || `${name} failed`);
  if (result.structuredContent !== undefined) return result.structuredContent;
  try { return JSON.parse(text); } catch { return text; }
}

export default { tools, callTool };
