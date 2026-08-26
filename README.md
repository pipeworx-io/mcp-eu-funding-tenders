# @pipeworx/eu-funding-tenders

EU Funding & Tenders Portal MCP — Horizon Europe and every other EU funding call plus EU tenders: what is open, when it closes, and the topic identifier to quote in an application.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1476+ live data sources.

## Tools

- `eu_search_calls(query?, status?, programme?, limit?, page?)` — free-text search over EU grant topics (`type=1`). `status` takes plain words (`open` default, `forthcoming`, `closed`, `any`); `programme` takes a code such as `horizon`, `life`, `erasmus`, `digital`, `cef`, `eu4h`. Returns identifier, title, parent call, deadline, days remaining, status word, types of action, programme and portal URL.
- `eu_open_calls(query?, programme?, limit?)` — currently-open calls ordered by nearest deadline, days-until-deadline computed at request time.
- `eu_get_topic(identifier, include_conditions?)` — full detail for one topic (e.g. `HORIZON-CL5-2026-09-D4-03`): tag-stripped description, admissibility/eligibility conditions, indicative budget with expected number of grants and EU contribution per project, action types, deadline model, destination, cross-cutting priorities and submission links. Also resolves external-action references like `EuropeAid/187022/DD/ACT/IN`.
- `eu_external_action_tenders(query?, status?, limit?, page?)` — the same search against `type=2`: the Commission's own external-action tenders and EuropeAid calls, i.e. development cooperation and technical assistance delivered in partner countries (~2,400 records, all `EuropeAid/…` references). A contract notice from a national or municipal buyer inside the EU is published in TED instead, which is a different and far larger journal. Returns reference, country, contract budget + currency, deadline, status and portal URL.

Tools that legitimately cannot answer return `{ found: false, reason, hint }` — unknown topic identifier, unknown programme code, no matching calls — rather than throwing.

## Auth

Keyless. The portal's own public key (`apiKey=SEDIA`) is baked in; callers pass nothing.

## Data sources

- Search endpoint: `https://api.tech.ec.europa.eu/search-api/prod/rest/search?apiKey=SEDIA`
- Human portal: https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/home
- Topic pages: `https://ec.europa.eu/info/funding-tenders/opportunities/portal/screen/opportunities/topic-details/<identifier>`
- External-action calls (Prospect): `https://webgate.ec.europa.eu/prospect/external/publishedcalls.htm?callId=<id>`

**Gotchas.** The request body is `multipart/form-data` and **every part must carry `Content-Type: application/json`** — send the parts as plain strings and the API answers HTTP 500 `{"type":"throwable","message":"An internal error occurred"}` with no clue what it wanted. In curl that is `-F 'query={...};type=application/json'`; in a Worker the only way to attach a per-part content type is to append a `Blob` with `{ type: 'application/json' }`, and you must let `fetch` set the multipart boundary rather than setting `Content-Type` yourself. The `text` query param cannot be empty, so `***` is the match-all term. Every value in a result's `metadata` is a **single-element array** (`metadata.title === ["…"]`), so each field needs unwrapping or every consumer gets arrays. `descriptionByte` and `topicConditions` are **raw HTML with inline styles** — this pack strips tags and collapses whitespace, including two upstream defects it leaves behind: literal `<p>null</p>` paragraphs, and a broken attribute quote (`<div class="x>"`) that otherwise leaves a stray `">` at the head of the conditions text. `budgetOverview` is a JSON *string* whose `budgetTopicActionMap` is keyed by internal ids; the matching entry is found by the `action` string, which starts with the topic identifier. The query DSL is a narrow subset of Elasticsearch: `terms` works, `prefix` is rejected with HTTP 400, and **`range` is silently ignored** (same `totalResults`, same rows) — so date windows cannot be pushed down. That matters because the portal leaves several hundred legacy topics flagged **Open** with deadlines years in the past (~250 of ~590 as of July 2026), which is why `eu_open_calls` sorts by `deadlineDate` ASC and binary-searches the result set for the first live deadline, and why `eu_search_calls` sorts DESC and drops past-deadline rows from the page it returns. `frameworkProgramme` is an internal numeric id, so the pack ships a code→id map (external-action records all use the placeholder `111111`). Facet values worth knowing: `type` 1 = grant topics, 2 = tenders/external action, and `status` 31094501 = Forthcoming, 31094502 = Open, 31094503 = Closed (tender records add `310945031` and `99999998`, both closed). `type=2` also indexes portal FAQs, so tender queries pin `DATASOURCE=SEDIA`. Finally, `text` matching is loose — a nonsense phrase still returns hundreds of hits — so treat `total_results` as a relevance-ranked upper bound, not a count of true matches.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "eu-funding-tenders": {
      "url": "https://gateway.pipeworx.io/eu-funding-tenders/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/eu-funding-tenders/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1476+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Eu Funding Tenders data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
