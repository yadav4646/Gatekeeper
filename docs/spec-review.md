# Gatekeeper: spec review and open-question answers

Input for the planning pass. Checked against the MCP 2026-07-28 spec source (the
`modelcontextprotocol/modelcontextprotocol` repo, `docs/specification/2026-07-28/`), the official
release posts, the TypeScript SDK v2 migration docs, and the npm registry, as of 2026-11-22.

Spec section names in parentheses point to the page each claim comes from.

---

## Part 1: Answers to the open questions

### 1. Required headers, error codes and `tools/list` TTL

**Every request is self-describing; there is no handshake and no session.** (`basic/versioning`, `changelog`)

- Body `_meta` on every request: `io.modelcontextprotocol/protocolVersion` and
  `io.modelcontextprotocol/clientCapabilities` (MUST); `io.modelcontextprotocol/clientInfo` (SHOULD).
  Results carry `io.modelcontextprotocol/serverInfo` (SHOULD) and a required `resultType`
  (`"complete"` or `"input_required"`).
- Every HTTP POST must also carry these headers (`basic/transports/streamable-http`):

| Header | Value | Required for |
|---|---|---|
| `MCP-Protocol-Version` | must equal the `_meta` protocolVersion | every POST |
| `Mcp-Method` | `method` | every request |
| `Mcp-Name` | `params.name` / `params.uri` | `tools/call`, `resources/read`, `prompts/get` (SDK also uses it for `taskId` on `tasks/*`) |
| `Mcp-Param-{Name}` | value of a tool argument annotated `x-mcp-header` | when the tool schema asks for it |

- If a value isn't plain ASCII, `Mcp-Name` and `Mcp-Param-*` use the sentinel `=?base64?…?=`.
  Servers **MUST decode before comparing**.
- `server/discover` is mandatory for servers. `ping`, `logging/setLevel`, the GET stream,
  `Mcp-Session-Id`, `Last-Event-ID` and server-initiated requests are all gone.

**Error codes** (MCP reserves `-32020…-32099`; `-32000…-32019` is implementation-defined):

| Case | HTTP | JSON-RPC |
|---|---|---|
| Headers missing, malformed, or disagree with the body | 400 | `-32020` HeaderMismatch |
| Required client capability missing | 400 | `-32021` MissingRequiredClientCapability |
| Unsupported protocol version | 400 | `-32022` UnsupportedProtocolVersion, `data: {supported:[…], requested}` |
| Unknown method | 404 | `-32601` |
| Resource not found (was `-32002`) | n/a | `-32602` |
| Bad `Origin` header | 403 | (body optional) |
| Legacy GET/DELETE to the endpoint | 405 | n/a |

Note for intermediaries: you **MUST** return an HTTP error on validation failure, but a
JSON-RPC body is optional. Return one anyway; the client-side fallback logic depends on it.
Intermediaries that enforce policy from headers **SHOULD** reject requests whose version
predates header/body validation instead of trusting those headers.

**Caching** (`server/utilities/caching`). The result *body* carries the cache hints;
there is no HTTP cache header:

- `ttlMs` (integer, ms, ≥ 0; absent or negative means 0) and `cacheScope` (`"public"` | `"private"`) are
  **required** on `server/discover`, `tools/list`, `prompts/list`, `resources/list`,
  `resources/templates/list`, and `resources/read`.
- Cache key = method + result-affecting params (e.g. `cursor`). Each page is cached on its own.
- Results of MRTR retries (anything carrying `inputResponses`/`requestState`) **MUST NOT** be cached.
- `"private"` caches **MUST NOT** be shared across authorization contexts.
- A `listChanged` notification invalidates a fresh entry. You can rely on TTL alone and skip notifications.
- `tools/list` **MAY** vary by the caller's authorization but **MUST NOT** vary per connection.
  Return tools in a deterministic order (SHOULD).

### 2. OAuth: the gateway as a server to clients and a client to upstreams

**Toward agents, the gateway is a resource server** (`basic/authorization/index`):
- MUST serve Protected Resource Metadata (RFC 9728) at `/.well-known/oauth-protected-resource`.
- On 401, send `WWW-Authenticate: Bearer resource_metadata="…"`, plus `scope=` (SHOULD).
- On insufficient scope, send 403 with `error="insufficient_scope"`.
- MUST check that the token's audience is the gateway (RFC 8707). Clients request tokens with
  `resource=<gateway canonical URI>`.

**Toward upstreams, the gateway is a separate OAuth client** (`authorization/security-considerations`):
> "The MCP server **MUST NOT** pass through the token it received from the MCP client."

That rules out simple forwarding. Two workable models:
1. **MVP: a service identity per upstream.** The gateway gets its own token for each upstream
   (client-credentials, or a static key stored in a secret store). End-user identity goes along
   as a signed assertion (for example `_meta` or a header the upstream can verify), and the
   gateway is the policy enforcement point. Simple, but the gateway becomes a powerful deputy,
   so the writeup must say so.
2. **Stretch: on-behalf-of via token exchange (RFC 8693).** The gateway exchanges the user's
   token for an upstream-audience token. Upstreams can then enforce per-user access too.
   This is the better story for "confused deputy", but it needs IdP support.

If the gateway ever proxies OAuth flows to *third-party* authorization servers using a static
client ID, the spec requires per-client user consent. Avoid that by design in the MVP.

Also new in 2026-07-28 (these matter for the console's OAuth login, and for any upstream OAuth
the gateway performs): validate `iss` per RFC 9207, key stored credentials by issuer, set
`application_type` in DCR, and prefer Client ID Metadata Documents (DCR is now deprecated).

### 3. Is the TypeScript SDK stable enough?

**Yes, use v2.** On npm, `@modelcontextprotocol/server` and `@modelcontextprotocol/client` have
`latest = 2.4.0` (last modified 2026-10-23). The v1 `@modelcontextprotocol/sdk` line stops at
2025-11-25 and won't get 2026-07-28.

What matters for a proxy:
- Entry point: `createMcpHandler(factory, { legacy })` from `@modelcontextprotocol/server`,
  wrapped with `toNodeHandler` (`@modelcontextprotocol/node`). There are Express, Fastify and
  Hono adapter packages.
- Build on the **low-level `Server`**, with `setRequestHandler('tools/list' | 'tools/call', …)`,
  not `McpServer`. The gateway serves dynamic tool tables, not tools it registers itself.
- When relaying, pass an explicit result schema (for example `ResultSchema` from
  `@modelcontextprotocol/core`). Otherwise v2 validates the relayed result and throws
  `InvalidResult`.
- Re-emit upstream errors with `ProtocolError.fromError(code, message, data)`.
- **The handler does not check `Origin`/`Host`.** Add middleware for that.
- There is no server-to-client request channel on 2026 connections. Elicitation and sampling go
  through MRTR (`resultType: "input_required"` + `requestState`).
- Renames from v1: `McpError` → `ProtocolError`, `ErrorCode` → `ProtocolErrorCode`, schema-keyed
  handlers → method-string handlers, Zod 4 only.
- Read first in the planning pass: the SDK's `/v2/advanced/gateway.html` and
  `/v2/protocol-versions.html` pages. I did not get to them.

### 4. Upstreams still on the older stateful spec

The spec defines exactly how a client talks to both eras (`basic/versioning`, "Compatibility matrix"):
- Send a modern request first. If you get a `400` with a recognized modern error, the upstream
  is modern; retry with a version from `supported`. If you get any other `4xx` or an empty body,
  fall back to `initialize`.
- Cache the era **per origin**, and re-probe when that assumption fails.
- SDK: `ClientOptions.versionNegotiation: { mode: 'auto' }` probes `server/discover` and falls
  back to `initialize`. `getProtocolEra()` reports the result. It does **not** fall back on
  401/403/5xx, which is correct.

Recommendation: make the gateway **dual-era on the upstream side** and **modern-first on the
client side**.
- For legacy upstreams, the gateway keeps a pooled session per upstream (or per upstream and
  service identity). That is the only state the gateway holds, and it is internal; agents
  never see it.
- Server-initiated requests from legacy upstreams (sampling, elicitation, roots) can't reach
  modern clients. Reject them in the MVP; translating them to MRTR is a stretch item.
- On the client side, the SDK default (`legacy: 'stateless'`) also answers 2025-era clients that
  don't need server-to-client requests. Leave it on and add tests for both eras.
- This changes the spec's non-goal "No stateful/sessions legacy mode". See Part 2, item 1.

### 5. Namespaced tool names

The spec addresses this directly (`server/tools`, "Tool Names" and the note after it):
- Proxies that aggregate servers **SHOULD** prefix tool names with a server identifier.
- `serverInfo.name` **SHOULD NOT** be used for that; it isn't unique.
- Name rules (all SHOULD): 1–128 characters, case-sensitive, `[A-Za-z0-9_.-]` only.

Recommended scheme: `{slug}__{tool}`.
- `slug` is admin-assigned when the upstream is registered, matches `[a-z0-9]+(-[a-z0-9]+)*`,
  and is unique. It cannot contain `_`, so splitting at the **first** `__` is always unambiguous,
  even when the upstream's own tool name contains `__` or dots.
- Avoid `.` as the separator. It is spec-legal, but upstream names like `admin.tools.list`
  make it ambiguous, and some LLM provider APIs restrict function names to roughly
  `[a-zA-Z0-9_-]{1,64}`. That limit is from my own knowledge; check it for the hosts you target.
  Keep the full name ≤ 64 characters, and reject or alias tools that would exceed it.
- Resolve names through a **lookup table** (`exposedName → {upstreamId, originalName, pinnedHash}`)
  built from the approved catalogue, never by parsing and trusting the string. Exact,
  case-sensitive match only. An unknown name gets `-32602` or a not-found error, which is
  default deny.
- When forwarding, rewrite **both** `params.name` and the `Mcp-Name` header, recompute
  `Mcp-Param-*`, and re-validate before sending.

### 6. Identity provider for the demo

The spec has no opinion here; this is my recommendation. **Keycloak** in Docker Compose for local
development, and the same image for the hosted demo:
- free and self-hosted;
- audience mappers handle the `aud` check;
- supports client credentials for agent identities and token exchange for the stretch goal;
- realm export as JSON makes the demo reproducible.

Before committing to it, check Keycloak's RFC 8707 `resource`-parameter support. If it's weak,
map `resource` to an audience, or use Auth0's free tier for the hosted demo. Either way, write
the IdP adapter against plain JWKS + OIDC discovery so the IdP can be swapped.

---

## Part 2: Changes I'd make to the spec

1. **Fix the legacy non-goal.** Change it to: "Client-facing surface is 2026-07-28 (plus
   whatever 2025-era clients the SDK's stateless legacy mode serves). The upstream connector is
   dual-era; legacy upstream sessions are pooled inside the gateway and never exposed."
2. **Tool annotations can't drive caching or retries.** The spec says annotations (`readOnlyHint`,
   `idempotentHint`, …) are untrusted unless they come from a trusted server. An admin sets
   "safe to cache" and "safe to retry" per tool in the gateway; upstream hints only pre-fill the
   approval form. Retry only tools an admin marked idempotent.
3. **Merged `tools/list` is per caller, so it's `cacheScope: "private"`.** The gateway filters
   by role, so its own `tools/list` responses vary by caller. Emit `"private"`, set the gateway's
   `ttlMs` ≤ the minimum upstream TTL, and key internal caches by (role set, cursor). The merged
   list needs gateway-minted cursors and a deterministic order (sorted by exposed name).
4. **Widen the pin hash.** Hash RFC 8785 (JCS) canonical JSON of `name`, `title`, `description`,
   `inputSchema`, `outputSchema`, `annotations`, `x-mcp-header` annotations, and tool-level
   `_meta` (that is where MCP Apps UI templates live). Also:
   - **New tools start quarantined** (default deny).
   - Removed tools are flagged.
   - Keep the hash history so the console can show diffs.
   - Re-check definitions on every upstream refresh: TTL expiry, `listChanged`, or a `tools/call`
     error that suggests drift.
5. **Handle MRTR in the MVP, not as a stretch.** Any upstream `tools/call` can return
   `resultType: "input_required"`. The gateway must pass `inputRequests` through and route the
   retry to the same upstream.
   - Wrap the upstream's `requestState` in a gateway-signed envelope bound to (identity,
     upstream, tool, expiry). This blocks cross-user replay and steering a retry at another
     upstream. The SDK's `createRequestStateCodec` (HMAC) covers this.
   - Policy is re-checked on every retry.
6. **Make header/body consistency part of the bypass test matrix.** Explicit cases:
   - `Mcp-Name` differs from `params.name`;
   - Base64-sentinel `Mcp-Name` (`=?base64?…?=`) that decodes to a denied tool;
   - case variants (`CRM__delete` vs `crm__delete`);
   - a slug that tries to escape (`crm__x__delete`);
   - duplicate JSON keys in the body;
   - `Mcp-Param-*` that disagrees with the arguments;
   - an old or missing `MCP-Protocol-Version` used to dodge header validation;
   - a JSON-RPC batch array (one request per POST is the rule).
   Policy is evaluated on the **decoded body after validation**, never on raw headers.
7. **Make trace propagation concrete.** The spec fixes `_meta` keys `traceparent`, `tracestate`,
   `baggage` (SEP-414). The gateway continues the client's trace and injects context into the
   upstream request. That gives the "one trace end to end" demo without inventing a convention.
8. **Health checks use `server/discover`.** `ping` is removed. The `server/discover` result is
   cacheable and also yields the upstream's era and capabilities.
9. **Notifications: TTL only in the MVP.** Fanning in `subscriptions/listen` from N upstreams to
   N clients is a long-lived stream, the one place statefulness creeps back. The spec allows
   TTL-only freshness. Make this a stretch item.
10. **Use the official conformance work.** SEP-2484 made a conformance suite a requirement for
    SDK tiers. Find out in planning whether its tests can be pointed at an arbitrary server. If
    they can, "passes the official suite for implemented methods" is a much stronger success
    criterion than a homemade one.
11. **Spell out SSRF controls for upstream registration.** Allow `https` only (with an explicit
    dev-mode exception). Resolve the host and block private, link-local, and metadata ranges
    *after* DNS resolution and again on every connect (DNS rebinding). Don't follow redirects
    to new hosts. Require admin approval before first contact.
12. **Pin the load-test method.** Same upstream, same payloads, gateway vs direct. Report RPS
    and added p50/p95/p99 with caches cold vs warm. Policy and rate-limit checks stay on; the
    Redis round-trip is the honest cost.
13. **Out of scope by spec:** Sampling, Roots and Logging are deprecated. Don't proxy them. Use
    OpenTelemetry instead of Logging.

---

## Part 3: What I couldn't verify

- **AAIF migration guide:** `aaif.io` failed DNS lookup from this environment. Not read.
- **SDK pages not read:** `/v2/advanced/gateway.html`, `/v2/protocol-versions.html`,
  `/v2/serving/authorization.html`. Auth helper names differ between the SDK's upgrade page and
  its API index (`requireBearerAuth` vs `bearerAuth`); confirm against the API reference.
- **SDK stability:** that v2 is stable is inferred from npm `latest = 2.4.0`. I didn't read the
  release notes.
- **Keycloak:** RFC 8707 support level, and the LLM-host tool-name limits, come from my own
  knowledge, not a source checked today.
- **CSA papers:** found, but only the search summary was read. Several CSA research notes are
  labelled AI-assisted and not formally reviewed. Cite the May 2026 whitepaper and OWASP
  MCP03:2025, not the notes.

## Sources

- Spec source: https://github.com/modelcontextprotocol/modelcontextprotocol (`docs/specification/2026-07-28/`)
- Release post: https://blog.modelcontextprotocol.io/posts/2026-07-28/
- RC post: https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/
- TS SDK migration: https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28
- TS SDK upgrade guide: https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2.html
- CSA whitepaper: https://labs.cloudsecurityalliance.org/research-rb/csa-whitepaper-mcp-security-tool-poisoning-20260506-csa-styl/
- CSA confused deputy: https://labs.cloudsecurityalliance.org/research-rb/csa-whitepaper-mcp-security-agentic-attack-surface-20260516/
