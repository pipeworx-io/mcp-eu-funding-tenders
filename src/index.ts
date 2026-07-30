interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * EU Funding & Tenders Portal (SEDIA search API) MCP.
 *
 * Horizon Europe and every other EU funding call, plus EU tenders: what is open,
 * when it closes, and the topic identifier to quote in an application.
 *
 * ── THE ONE GOTCHA THAT MAKES THIS PACK WORK ──────────────────────────────
 * The endpoint is POST + multipart/form-data, and **every part must carry
 * `Content-Type: application/json`**. Send the parts as plain strings and the
 * upstream answers HTTP 500 `{"type":"throwable","message":"An internal error
 * occurred"}` — no hint that the per-part content type is what it wanted.
 * In a Worker the only way to attach a per-part content type is to append a
 * Blob with `{ type: 'application/json' }` (see `searchApi` below), and we must
 * NOT set a Content-Type header ourselves — `fetch` has to generate the
 * multipart boundary.
 * ──────────────────────────────────────────────────────────────────────────
 */


const ENDPOINT = 'https://api.tech.ec.europa.eu/search-api/prod/rest/search';
/** Public portal key, documented by the Commission — keyless from a caller's point of view. */
const API_KEY = 'SEDIA';
const UA = 'pipeworx-mcp-eu-funding-tenders/1.0 (+https://pipeworx.io)';
/** The API needs a non-empty text term; this is its match-all. */
const MATCH_ALL = '***';

/** `type` facet: 1 = grant topics / calls for proposals, 2 = tenders & external-action contracts. */
const TYPE_GRANTS = '1';
const TYPE_TENDERS = '2';
/** type=2 also indexes portal FAQs; pin the datasource to keep tender hits clean. */
const DATASOURCE_PORTAL = 'SEDIA';

const STATUS_FORTHCOMING = '31094501';
const STATUS_OPEN = '31094502';
const STATUS_CLOSED = '31094503';
/** Extra closed-equivalent codes seen only on tender/external-action records. */
const TENDER_CLOSED_EXTRA = ['310945031', '99999998'];

const STATUS_WORDS: Record<string, string> = {
  '31094501': 'Forthcoming',
  '31094502': 'Open',
  '31094503': 'Closed',
  '310945031': 'Closed',
  '99999998': 'Closed',
  '0': 'Unspecified',
};

/**
 * `frameworkProgramme` is an internal numeric id, so callers get names.
 * Every id below was read off live records whose identifier carried the
 * matching prefix.
 */
const PROGRAMMES: Record<string, { id: string; label: string }> = {
  horizon: { id: '43108390', label: 'Horizon Europe' },
  'horizon-europe': { id: '43108390', label: 'Horizon Europe' },
  h2020: { id: '31045243', label: 'Horizon 2020' },
  'horizon-2020': { id: '31045243', label: 'Horizon 2020' },
  life: { id: '43252405', label: 'LIFE' },
  erasmus: { id: '43353764', label: 'Erasmus+' },
  'erasmus-plus': { id: '43353764', label: 'Erasmus+' },
  epp: { id: '31059093', label: 'Erasmus+ (2014-2020)' },
  crea: { id: '43251814', label: 'Creative Europe' },
  'creative-europe': { id: '43251814', label: 'Creative Europe' },
  digital: { id: '43152860', label: 'Digital Europe Programme' },
  cef: { id: '43251567', label: 'Connecting Europe Facility' },
  eu4h: { id: '43332642', label: 'EU4Health' },
  eu4health: { id: '43332642', label: 'EU4Health' },
  cerv: { id: '43251589', label: 'Citizens, Equality, Rights and Values' },
  amif: { id: '43251447', label: 'Asylum, Migration and Integration Fund' },
  isf: { id: '43252368', label: 'Internal Security Fund' },
  smp: { id: '43252476', label: 'Single Market Programme' },
  edf: { id: '44181033', label: 'European Defence Fund' },
  rfcs: { id: '43252449', label: 'Research Fund for Coal and Steel' },
  imcap: { id: '43251882', label: 'Agriculture promotion (IMCAP)' },
  innovfund: { id: '43089234', label: 'Innovation Fund' },
  'innovation-fund': { id: '43089234', label: 'Innovation Fund' },
  emfaf: { id: '43392145', label: 'European Maritime, Fisheries and Aquaculture Fund' },
  ucpm: { id: '31082527', label: 'Union Civil Protection Mechanism' },
  i3: { id: '44416173', label: 'Interregional Innovation Investments' },
  pppa: { id: '43637601', label: 'Pilot Projects and Preparatory Actions' },
  euba: { id: '45532249', label: 'EU Bodies and Agencies' },
  hercule: { id: '31084392', label: 'Hercule / EU Anti-Fraud Programme' },
  rec: { id: '31076817', label: 'Rights, Equality and Citizenship (2014-2020)' },
};
const PROGRAMME_LABEL_BY_ID: Record<string, string> = {
  ...Object.fromEntries(Object.values(PROGRAMMES).map((p) => [p.id, p.label])),
  // External-action (EuropeAid/Prospect) records all carry this placeholder id.
  '111111': 'EU external action (EuropeAid)',
};
const PROGRAMME_CODES = [
  'horizon', 'h2020', 'life', 'erasmus', 'crea', 'digital', 'cef', 'eu4h', 'cerv', 'amif',
  'isf', 'smp', 'edf', 'rfcs', 'imcap', 'innovfund', 'emfaf', 'ucpm', 'i3', 'pppa', 'euba',
].join(', ');

const MAX_LIMIT = 50;

// ── Tool definitions ───────────────────────────────────────────────────────

const tools: McpToolExport['tools'] = [
  {
    name: 'eu_search_calls',
    description:
      'Search Horizon Europe and every other EU funding call (grant topics) on the EU Funding & Tenders Portal by keyword. Returns the topic identifier to quote in an application (e.g. HORIZON-CL5-2026-09-D4-03), title, parent call identifier, submission deadline, status word (Open, Forthcoming, Closed), type of action, framework programme and portal URL. Answers "is there EU funding for hydrogen storage", "which Horizon Europe calls cover AI in health", "what LIFE or Erasmus+ or Digital Europe calls mention circular economy".',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text search over topic titles, descriptions and keywords, e.g. "battery recycling". Omit to list everything matching the filters.' },
        status: { type: 'string', enum: ['open', 'forthcoming', 'closed', 'any'], description: 'Call status in plain words (default "open").' },
        programme: { type: 'string', description: `Framework programme code, e.g. "horizon", "life", "erasmus", "digital", "eu4h". Supported: ${PROGRAMME_CODES}. A raw numeric frameworkProgramme id also works.` },
        limit: { type: 'integer', description: 'Results per page, 1-50 (default 10).' },
        page: { type: 'integer', description: '1-based page number (default 1).' },
      },
    },
  },
  {
    name: 'eu_open_calls',
    description:
      'Currently open EU funding calls ordered by nearest submission deadline first, with days remaining computed at request time. Answers "what EU grants can I still apply for", "which Horizon Europe calls close soon", "what is the next EU funding deadline for renewable energy". Each row carries the topic identifier, title, deadline date, days until deadline, type of action, framework programme and portal URL.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional free-text filter, e.g. "quantum" or "SME innovation".' },
        programme: { type: 'string', description: `Optional framework programme code, e.g. "horizon", "life", "cef". Supported: ${PROGRAMME_CODES}.` },
        limit: { type: 'integer', description: 'How many calls to return, 1-50 (default 10).' },
      },
    },
  },
  {
    name: 'eu_get_topic',
    description:
      'Full detail for one EU funding call topic by its identifier, e.g. "HORIZON-CL5-2026-09-D4-03". Returns the tag-stripped expected-outcome and scope description, the admissibility and eligibility conditions, indicative budget with expected number of grants and EU contribution per project, types of action and grant-agreement types, deadline and deadline model, framework programme, destination, cross-cutting priorities, keywords and the submission links. Answers "what does this Horizon Europe topic fund", "how much budget does topic X have", "what are the conditions and page limits for topic X".',
    inputSchema: {
      type: 'object',
      properties: {
        identifier: { type: 'string', description: 'Topic identifier exactly as the portal prints it, e.g. "HORIZON-CL5-2026-09-D4-03".' },
        include_conditions: { type: 'boolean', description: 'Include the (long) admissibility/eligibility conditions text (default true).' },
      },
      required: ['identifier'],
    },
  },
  {
    name: 'eu_search_tenders',
    description:
      'Search EU tenders and procurement opportunities published on the EU Funding & Tenders Portal (European Commission external-action contracts and EuropeAid calls). Returns the reference, title, contract budget and currency, submission deadline, status word, geographical zone and portal URL. Answers "what EU contracts are open in Nigeria", "which EU tenders cover water infrastructure", "EU procurement opportunities for technical assistance services".',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text search over tender titles and descriptions, e.g. "cloud services" or "Kenya energy".' },
        status: { type: 'string', enum: ['open', 'forthcoming', 'closed', 'any'], description: 'Tender status in plain words (default "open").' },
        limit: { type: 'integer', description: 'Results per page, 1-50 (default 10).' },
        page: { type: 'integer', description: '1-based page number (default 1).' },
      },
    },
  },
];

// ── HTTP ───────────────────────────────────────────────────────────────────

type Clause = Record<string, unknown>;

interface SearchArgs {
  text?: string;
  must: Clause[];
  pageSize: number;
  pageNumber: number;
  sort?: { field: string; order: 'ASC' | 'DESC' };
}

interface SearchHit {
  reference?: string;
  url?: string;
  summary?: string;
  content?: string;
  metadata?: Record<string, unknown>;
}

interface SearchResponse {
  totalResults?: number;
  pageNumber?: number;
  pageSize?: number;
  results?: SearchHit[];
  type?: string;
  message?: string;
}

/** JSON part helper — the Blob's `type` becomes the part's Content-Type, which the upstream requires. */
function jsonPart(value: unknown): Blob {
  return new Blob([JSON.stringify(value)], { type: 'application/json' });
}

async function searchApi(args: SearchArgs): Promise<SearchResponse> {
  const url = new URL(ENDPOINT);
  url.searchParams.set('apiKey', API_KEY);
  url.searchParams.set('text', args.text && args.text.trim() ? args.text.trim() : MATCH_ALL);
  url.searchParams.set('pageSize', String(args.pageSize));
  url.searchParams.set('pageNumber', String(args.pageNumber));

  const body = new FormData();
  body.append('query', jsonPart({ bool: { must: args.must } }));
  body.append('languages', jsonPart(['en']));
  if (args.sort) body.append('sort', jsonPart(args.sort));

  // No Content-Type header here on purpose: fetch must set the multipart boundary itself.
  const res = await fetch(url.toString(), { method: 'POST', body, headers: { Accept: 'application/json', 'User-Agent': UA } });
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(
      `EU Funding & Tenders search API: ${res.status} ${raw.slice(0, 200)}` +
        (res.status === 500 ? ' (a 500 here usually means a multipart part was sent without Content-Type: application/json)' : ''),
    );
  }
  let parsed: SearchResponse;
  try {
    parsed = JSON.parse(raw) as SearchResponse;
  } catch {
    throw new Error(`EU Funding & Tenders search API returned non-JSON: ${raw.slice(0, 200)}`);
  }
  if (parsed.type === 'throwable') throw new Error(`EU Funding & Tenders search API: ${parsed.message ?? 'unknown error'}`);
  return parsed;
}

// ── Metadata helpers ───────────────────────────────────────────────────────

/** Every metadata value is a single-element array — unwrap it. */
function one(meta: Record<string, unknown> | undefined, key: string): string | null {
  const v = meta?.[key];
  if (Array.isArray(v)) {
    const first = v[0];
    return first === undefined || first === null ? null : String(first);
  }
  if (v === undefined || v === null) return null;
  return String(v);
}

function many(meta: Record<string, unknown> | undefined, key: string): string[] {
  const v = meta?.[key];
  if (!Array.isArray(v)) return [];
  return v.filter((x) => x !== null && x !== undefined).map((x) => String(x));
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'",
  '&nbsp;': ' ', '&ndash;': '-', '&mdash;': '—', '&lsquo;': "'", '&rsquo;': "'",
  '&ldquo;': '"', '&rdquo;': '"', '&hellip;': '…', '&euro;': '€', '&deg;': '°', '&middot;': '·',
};

/** The portal ships descriptions and conditions as styled HTML; markup poisons downstream summarisation. */
function stripHtml(html: string | null): string | null {
  if (!html) return null;
  let out = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|li|tr|h[1-6]|ul|ol|table)\s*>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '\n- ')
    .replace(/<[^>]*>/g, ' ');
  for (const [entity, char] of Object.entries(ENTITIES)) out = out.split(entity).join(char);
  out = out
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCharCode(Number(code)))
    .replace(/﻿/g, '')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    // The portal emits literal `<p>null</p>` paragraphs inside some topic descriptions.
    .replace(/(^|\n)null(?=\n|$)/g, '$1')
    // Some topicConditions blocks ship a broken attribute quote (`<div class="x>"`),
    // which leaves a stray `">` behind once the tags are gone.
    .replace(/(^|\n)[ \t]*["']?>[ \t]*/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return out.length ? out : null;
}

function truncate(text: string | null, max: number): { text: string | null; truncated: boolean } {
  if (!text) return { text: null, truncated: false };
  if (text.length <= max) return { text, truncated: false };
  return { text: `${text.slice(0, max)}…`, truncated: true };
}

function parseJsonField(meta: Record<string, unknown> | undefined, key: string): unknown {
  const raw = one(meta, key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw; // pass the string through rather than losing the field
  }
}

function statusWord(code: string | null): string | null {
  if (!code) return null;
  return STATUS_WORDS[code] ?? code;
}

function programmeLabel(id: string | null): string | null {
  if (!id) return null;
  return PROGRAMME_LABEL_BY_ID[id] ?? id;
}

function daysUntil(deadline: string | null, nowMs: number): number | null {
  if (!deadline) return null;
  const ms = Date.parse(deadline);
  if (Number.isNaN(ms)) return null;
  return Math.ceil((ms - nowMs) / 86_400_000);
}

function deadlineMs(hit: SearchHit): number {
  const d = one(hit.metadata, 'deadlineDate');
  if (!d) return Number.POSITIVE_INFINITY; // no deadline given: treat as still ahead of us
  const ms = Date.parse(d);
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}

// ── Arg coercion ───────────────────────────────────────────────────────────

function intArg(args: Record<string, unknown>, key: string, def: number, min: number, max: number): number {
  const v = args[key];
  if (v === undefined || v === null || v === '') return def;
  const n = typeof v === 'number' ? v : Number(String(v));
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function strArg(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (typeof v !== 'string' || !v.trim()) return undefined;
  return v.trim();
}

function boolArg(args: Record<string, unknown>, key: string, def: boolean): boolean {
  const v = args[key];
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return !/^(false|0|no)$/i.test(v);
  return def;
}

interface NotFound {
  found: false;
  reason: string;
  hint: string;
}

function statusClause(status: string, isTender: boolean): Clause[] | NotFound {
  const word = status.toLowerCase();
  if (word === 'any' || word === 'all') return [];
  if (word === 'open') return [{ terms: { status: [STATUS_OPEN] } }];
  if (word === 'forthcoming' || word === 'upcoming') return [{ terms: { status: [STATUS_FORTHCOMING] } }];
  if (word === 'closed') {
    return [{ terms: { status: isTender ? [STATUS_CLOSED, ...TENDER_CLOSED_EXTRA] : [STATUS_CLOSED] } }];
  }
  return {
    found: false,
    reason: 'unknown_status',
    hint: 'status accepts "open", "forthcoming", "closed" or "any".',
  };
}

function programmeClause(programme: string | undefined): Clause[] | NotFound {
  if (!programme) return [];
  const key = programme.trim().toLowerCase().replace(/[\s_]+/g, '-');
  const hit = PROGRAMMES[key];
  if (hit) return [{ terms: { frameworkProgramme: [hit.id] } }];
  if (/^\d+$/.test(key)) return [{ terms: { frameworkProgramme: [key] } }];
  return {
    found: false,
    reason: 'unknown_programme',
    hint: `Use one of these programme codes: ${PROGRAMME_CODES}. Or drop the programme filter and put the programme name in "query".`,
  };
}

function isNotFound(v: Clause[] | NotFound): v is NotFound {
  return !Array.isArray(v);
}

// ── Row shaping ────────────────────────────────────────────────────────────

function callRow(hit: SearchHit, nowMs: number): Record<string, unknown> {
  const m = hit.metadata;
  const deadline = one(m, 'deadlineDate');
  return {
    identifier: one(m, 'identifier'),
    title: one(m, 'title'),
    call_identifier: one(m, 'callIdentifier'),
    call_title: one(m, 'callTitle'),
    status: statusWord(one(m, 'status')),
    deadline_date: deadline,
    days_until_deadline: daysUntil(deadline, nowMs),
    deadline_model: one(m, 'deadlineModel'),
    types_of_action: many(m, 'typesOfAction'),
    programme: programmeLabel(one(m, 'frameworkProgramme')),
    programme_period: one(m, 'programmePeriod'),
    url: one(m, 'url') ?? hit.url ?? null,
  };
}

/** References look like `EuropeAid/187022/DD/ACT/IN`; the tail is the country ("Multi" = multi-country). */
function tenderCountry(reference: string | null): string | null {
  if (!reference) return null;
  const tail = reference.split('/').pop();
  return tail && tail !== reference ? tail : null;
}

function tenderRow(hit: SearchHit, nowMs: number): Record<string, unknown> {
  const m = hit.metadata;
  const deadline = one(m, 'deadlineDate');
  const reference = one(m, 'identifier');
  return {
    reference,
    country: tenderCountry(reference),
    title: one(m, 'title'),
    status: statusWord(one(m, 'status')),
    deadline_date: deadline,
    days_until_deadline: daysUntil(deadline, nowMs),
    publication_date: one(m, 'startDate'),
    budget: one(m, 'budget'),
    currency: one(m, 'currency'),
    contract_type_code: one(m, 'contractType'),
    programme_period: one(m, 'programmePeriod'),
    last_updated: one(m, 'updateDate'),
    url: one(m, 'url') ?? hit.url ?? null,
  };
}

// ── eu_open_calls: seek past the stale "Open" block ────────────────────────
//
// The portal leaves a few hundred legacy topics flagged Open with deadlines years
// in the past, and the search DSL silently ignores `range` clauses (only `terms`
// is honoured — `prefix` is rejected outright with HTTP 400). So we sort by
// deadlineDate ASC and binary-search the result set for the first record whose
// deadline is still ahead of us, probing with pageSize=1 pages (~17 KB each) in
// small parallel batches to keep the wall clock down.

const PROBES_PER_ROUND = 5;
const PROBE_ROUNDS = 6;

async function probeDeadline(base: Omit<SearchArgs, 'pageSize' | 'pageNumber'>, offset: number): Promise<number> {
  const res = await searchApi({ ...base, pageSize: 1, pageNumber: offset + 1 });
  const hit = res.results?.[0];
  return hit ? deadlineMs(hit) : Number.POSITIVE_INFINITY;
}

/** Index of the first record (0-based) whose deadline has not passed. */
async function seekFirstFuture(
  base: Omit<SearchArgs, 'pageSize' | 'pageNumber'>,
  total: number,
  nowMs: number,
): Promise<number> {
  let lo = 0; // known-or-assumed past
  let hi = total - 1; // assumed future
  for (let round = 0; round < PROBE_ROUNDS && hi - lo > 1; round++) {
    const span = hi - lo;
    const step = span / (PROBES_PER_ROUND + 1);
    const offsets: number[] = [];
    for (let i = 1; i <= PROBES_PER_ROUND; i++) {
      const off = lo + Math.round(step * i);
      if (off > lo && off < hi && !offsets.includes(off)) offsets.push(off);
    }
    if (!offsets.length) break;
    const deadlines = await Promise.all(offsets.map((off) => probeDeadline(base, off)));
    for (let i = 0; i < offsets.length; i++) {
      if (deadlines[i] < nowMs) lo = Math.max(lo, offsets[i]);
      else hi = Math.min(hi, offsets[i]);
    }
  }
  return hi;
}

async function collectFutureCalls(
  base: Omit<SearchArgs, 'pageSize' | 'pageNumber'>,
  startOffset: number,
  limit: number,
  total: number,
  nowMs: number,
): Promise<SearchHit[]> {
  const pageSize = Math.min(MAX_LIMIT, Math.max(limit, 10));
  const startPage = Math.floor(startOffset / pageSize) + 1;
  const collected: SearchHit[] = [];
  for (let page = startPage; page < startPage + 3; page++) {
    if ((page - 1) * pageSize >= total) break;
    const res = await searchApi({ ...base, pageSize, pageNumber: page });
    const rows = res.results ?? [];
    collected.push(...rows.filter((r) => deadlineMs(r) >= nowMs));
    if (collected.length >= limit || rows.length < pageSize) break;
  }
  return collected;
}

// ── callTool ───────────────────────────────────────────────────────────────

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  // Compute "now" inside the handler: a module-scope Date in a Worker evaluates to 1970.
  const nowMs = Date.now();

  switch (name) {
    case 'eu_search_calls': {
      const status = strArg(args, 'status') ?? 'open';
      const statusFilter = statusClause(status, false);
      if (isNotFound(statusFilter)) return statusFilter;
      const programmeFilter = programmeClause(strArg(args, 'programme'));
      if (isNotFound(programmeFilter)) return programmeFilter;

      const limit = intArg(args, 'limit', 10, 1, MAX_LIMIT);
      const page = intArg(args, 'page', 1, 1, 1000);
      const text = strArg(args, 'query');
      const must: Clause[] = [{ terms: { type: [TYPE_GRANTS] } }, ...statusFilter, ...programmeFilter];

      // DESC on deadlineDate keeps live opportunities on page 1: relevance ranking is
      // dominated by the several hundred legacy topics the portal still flags Open.
      const res = await searchApi({ text, must, pageSize: limit, pageNumber: page, sort: { field: 'deadlineDate', order: 'DESC' } });
      let rows = res.results ?? [];
      const upstreamTotal = res.totalResults ?? rows.length;
      let dropped = 0;
      if (status.toLowerCase() === 'open') {
        const kept = rows.filter((r) => deadlineMs(r) >= nowMs);
        dropped = rows.length - kept.length;
        rows = kept;
      }
      if (!rows.length) {
        return {
          found: false,
          reason: 'no_calls_matched',
          hint: `No EU grant topics with a live deadline matched${text ? ` "${text}"` : ''} with status "${status}". Try broader wording, status "any" to include closed calls, drop the programme filter, or ask for an earlier page.`,
        };
      }
      return {
        total_results: upstreamTotal,
        returned: rows.length,
        page,
        limit,
        status_filter: status,
        as_of: new Date(nowMs).toISOString(),
        results: rows.map((r) => callRow(r, nowMs)),
        ...(dropped
          ? { note: `${dropped} matching topic(s) on this page were flagged Open with a deadline already past and were dropped; total_results counts them.` }
          : {}),
        source: 'EU Funding & Tenders Portal (SEDIA)',
      };
    }

    case 'eu_open_calls': {
      const limit = intArg(args, 'limit', 10, 1, MAX_LIMIT);
      const text = strArg(args, 'query');
      const programmeFilter = programmeClause(strArg(args, 'programme'));
      if (isNotFound(programmeFilter)) return programmeFilter;

      const base = {
        text,
        must: [{ terms: { type: [TYPE_GRANTS] } }, { terms: { status: [STATUS_OPEN] } }, ...programmeFilter] as Clause[],
        sort: { field: 'deadlineDate', order: 'ASC' as const },
      };

      const head = await searchApi({ ...base, pageSize: 1, pageNumber: 1 });
      const total = head.totalResults ?? 0;
      if (!total) {
        return {
          found: false,
          reason: 'no_open_calls',
          hint: `No open EU grant topics matched${text ? ` "${text}"` : ''}. Try broader wording, drop the programme filter, or call eu_search_calls with status "forthcoming".`,
        };
      }

      let hits: SearchHit[];
      if (total <= MAX_LIMIT) {
        const all = await searchApi({ ...base, pageSize: MAX_LIMIT, pageNumber: 1 });
        hits = (all.results ?? []).filter((r) => deadlineMs(r) >= nowMs);
      } else {
        const firstDeadline = deadlineMs(head.results?.[0] ?? {});
        const startOffset = firstDeadline >= nowMs ? 0 : await seekFirstFuture(base, total, nowMs);
        hits = await collectFutureCalls(base, startOffset, limit, total, nowMs);
      }

      hits.sort((a, b) => deadlineMs(a) - deadlineMs(b));
      const results = hits.slice(0, limit).map((r) => callRow(r, nowMs));
      if (!results.length) {
        return {
          found: false,
          reason: 'no_future_deadlines',
          hint: `${total} topics carry status Open but every deadline in range has passed — the portal keeps legacy topics flagged Open. Call eu_search_calls with status "forthcoming" for the next wave.`,
        };
      }
      return {
        open_calls_matching_filters: total,
        returned: results.length,
        as_of: new Date(nowMs).toISOString(),
        results,
        note: 'Sorted by nearest deadline. Topics flagged Open whose deadline has already passed are dropped — the portal leaves several hundred legacy topics in that state.',
        source: 'EU Funding & Tenders Portal (SEDIA)',
      };
    }

    case 'eu_get_topic': {
      const identifier = strArg(args, 'identifier');
      if (!identifier) {
        throw new Error('Required argument "identifier" is missing. Pass a topic identifier like "HORIZON-CL5-2026-09-D4-03".');
      }
      const wanted = identifier.toLowerCase();
      const res = await searchApi({
        text: identifier,
        must: [{ terms: { type: [TYPE_GRANTS, TYPE_TENDERS] } }],
        pageSize: 20,
        pageNumber: 1,
      });
      const rows = res.results ?? [];
      const hit = rows.find((r) => (one(r.metadata, 'identifier') ?? '').toLowerCase() === wanted);
      if (!hit) {
        const near = rows.map((r) => one(r.metadata, 'identifier')).filter((x): x is string => !!x).slice(0, 8);
        return {
          found: false,
          reason: 'topic_not_found',
          hint: near.length
            ? `No topic has identifier "${identifier}". Closest identifiers in the portal: ${near.join(', ')}. Use eu_search_calls to find the right one by keyword.`
            : `No topic has identifier "${identifier}". Identifiers look like "HORIZON-CL5-2026-09-D4-03"; use eu_search_calls to find one by keyword.`,
        };
      }

      const m = hit.metadata;
      const deadline = one(m, 'deadlineDate');
      const description = truncate(stripHtml(one(m, 'descriptionByte')), 12_000);
      const conditions = boolArg(args, 'include_conditions', true)
        ? truncate(stripHtml(one(m, 'topicConditions')), 8_000)
        : { text: null, truncated: false };

      // budgetOverview arrives as a JSON *string*; its budgetTopicActionMap is keyed by
      // internal ids, and each entry's `action` string starts with the topic identifier.
      const budgetOverview = parseJsonField(m, 'budgetOverview');
      const budgetLines: Record<string, unknown>[] = [];
      if (budgetOverview && typeof budgetOverview === 'object') {
        const map = (budgetOverview as { budgetTopicActionMap?: Record<string, unknown> }).budgetTopicActionMap;
        for (const entries of Object.values(map ?? {})) {
          if (!Array.isArray(entries)) continue;
          for (const entry of entries) {
            if (!entry || typeof entry !== 'object') continue;
            const e = entry as Record<string, unknown>;
            const action = typeof e.action === 'string' ? e.action : '';
            if (!action.toLowerCase().startsWith(wanted)) continue;
            budgetLines.push({
              action,
              expected_grants: e.expectedGrants ?? null,
              min_eu_contribution: e.minContribution ?? null,
              max_eu_contribution: e.maxContribution ?? null,
              budget_by_year: e.budgetYearMap ?? null,
              planned_opening_date: e.plannedOpeningDate ?? null,
              deadline_dates: e.deadlineDates ?? null,
            });
          }
        }
      }

      const links = parseJsonField(m, 'links');
      const submissionLinks = Array.isArray(links)
        ? links
            .filter((l): l is Record<string, unknown> => !!l && typeof l === 'object')
            .map((l) => ({ url: l.url ?? null, action: l.criterionDescription ?? l.criterionCode ?? null, grant_agreement: l.mgaDescription ?? null }))
        : [];

      return {
        found: true,
        identifier: one(m, 'identifier'),
        title: one(m, 'title'),
        status: statusWord(one(m, 'status')),
        call_identifier: one(m, 'callIdentifier'),
        call_title: one(m, 'callTitle'),
        programme: programmeLabel(one(m, 'frameworkProgramme')),
        programme_period: one(m, 'programmePeriod'),
        destination: one(m, 'destinationDescription'),
        opening_date: one(m, 'startDate'),
        deadline_date: deadline,
        days_until_deadline: daysUntil(deadline, nowMs),
        deadline_model: one(m, 'deadlineModel'),
        types_of_action: many(m, 'typesOfAction'),
        cross_cutting_priorities: many(m, 'crossCuttingPriorities'),
        keywords: many(m, 'keywords'),
        tags: many(m, 'tags'),
        description: description.text,
        description_truncated: description.truncated,
        conditions: conditions.text,
        conditions_truncated: conditions.truncated,
        budget: budgetLines,
        budget_years: budgetOverview && typeof budgetOverview === 'object' ? (budgetOverview as { budgetYearsColumns?: unknown }).budgetYearsColumns ?? null : null,
        submission_links: submissionLinks,
        url: one(m, 'url') ?? hit.url ?? null,
        ccm2_id: one(m, 'ccm2Id'),
        source: 'EU Funding & Tenders Portal (SEDIA)',
      };
    }

    case 'eu_search_tenders': {
      const status = strArg(args, 'status') ?? 'open';
      const statusFilter = statusClause(status, true);
      if (isNotFound(statusFilter)) return statusFilter;
      const limit = intArg(args, 'limit', 10, 1, MAX_LIMIT);
      const page = intArg(args, 'page', 1, 1, 1000);
      const text = strArg(args, 'query');

      const res = await searchApi({
        text,
        must: [{ terms: { type: [TYPE_TENDERS] } }, { terms: { DATASOURCE: [DATASOURCE_PORTAL] } }, ...statusFilter],
        pageSize: limit,
        pageNumber: page,
        // Nearest deadline first while a tender can still be bid on; most recent first once it can't.
        sort: { field: 'deadlineDate', order: /^(open|forthcoming|upcoming)$/i.test(status) ? 'ASC' : 'DESC' },
      });
      let rows = res.results ?? [];
      if (status.toLowerCase() === 'open') {
        // A handful of tenders keep status Open past their deadline; drop those.
        rows = rows.filter((r) => deadlineMs(r) >= nowMs);
      }
      if (!rows.length) {
        return {
          found: false,
          reason: 'no_tenders_matched',
          hint: `No EU tenders matched${text ? ` "${text}"` : ''} with status "${status}". Try broader wording, status "any", or a later page.`,
        };
      }
      return {
        total_results: res.totalResults ?? rows.length,
        page,
        limit,
        status_filter: status,
        as_of: new Date(nowMs).toISOString(),
        results: rows.map((r) => tenderRow(r, nowMs)),
        source: 'EU Funding & Tenders Portal (SEDIA), external-action tenders and calls',
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
