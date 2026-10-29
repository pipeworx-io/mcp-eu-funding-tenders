#!/usr/bin/env node
// Entry point for `npx @pipeworx/mcp-<slug>` in gateway mode (bin/cli.js).
//
// A stdio MCP server that relays every message to the Pipeworx gateway's
// /<slug>/mcp endpoint -- fleet #3759, docs/standalone-via-gateway-plan.md.
// It carries no pack code and has no local mode. The relay itself lives in
// ../lib/index.js (copied from scripts/templates/standalone-gateway-lib.js);
// this file only owns stdin/stdout.
//
// Copied VERBATIM into every gateway-mode package by scripts/publish-pack.sh.
// Edit scripts/templates/standalone-gateway-cli.js in the monorepo, never a
// per-pack copy. Zero dependencies, Node 18+.
//
// stdout carries newline-delimited JSON-RPC and nothing else; every diagnostic
// goes to stderr, because a single stray line on stdout breaks the host's
// parser.
import { createInterface } from 'node:readline';
import { relay, bridgeConfig } from '../lib/index.js';

const cfg = bridgeConfig();
const warn = (line) => process.stderr.write(`${line}\n`);
const write = (msg) => { if (msg) process.stdout.write(`${JSON.stringify(msg)}\n`); };

const pending = new Set();
function track(p) {
  pending.add(p);
  p.finally(() => pending.delete(p));
}

async function handleLine(line) {
  const text = line.trim();
  if (!text) return;
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  // A JSON-RPC batch: relay each member, answer with the non-notification replies.
  if (Array.isArray(message)) {
    const replies = (await Promise.all(message.map((m) => relay(m, { cfg, warn })))).filter(Boolean);
    if (replies.length) write(replies);
    return;
  }
  write(await relay(message, { cfg, warn }));
}

// Requests are handled concurrently and answered as they finish: JSON-RPC ids
// let the host match them, and a slow tool call must not hold up a ping.
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  track(handleLine(line).catch((err) => warn(`pipeworx-standalone: ${err && err.stack ? err.stack : err}`)));
});
rl.on('close', async () => {
  // stdin closed: finish what is in flight, then exit.
  while (pending.size) await Promise.allSettled([...pending]);
  // Exit only once stdout has flushed: on a pipe that is not synchronous
  // everywhere, and a bare exit can drop the last reply.
  process.stdout.write('', () => process.exit(0));
});
