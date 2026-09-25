interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
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


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'EU Funding & Tenders Portal');
}

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
    name: 'eu_external_action_tenders',
    description:
      'Search EuropeAid external-action contracts — the European Commission\'s own development cooperation, humanitarian aid and technical assistance tenders, published on the EU Funding & Tenders Portal with EuropeAid/… references. Covers roughly 2,400 records, all Commission-funded work delivered in partner countries. Returns the reference, title, contract budget and currency, submission deadline, status word, geographical zone and portal URL. Answers "what EuropeAid contracts are open in Nigeria", "which EU development contracts cover water infrastructure", "EU technical assistance tenders in the Sahel". For a contract notice published by a national or municipal buyer inside the EU, that is TED (Tenders Electronic Daily), a separate and far larger journal.',
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
  const res = await pwFetch(url.toString(), { method: 'POST', body, headers: { Accept: 'application/json', 'User-Agent': UA } });
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

    case 'eu_external_action_tenders': {
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
