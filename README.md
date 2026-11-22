# Gatekeeper

A stateless gateway between AI agents (MCP clients) and many MCP servers, built on the
**MCP 2026-07-28** stateless spec. Agents see one `/mcp` endpoint; behind it the
gateway merges upstream tool lists, routes calls, and (as milestones land) enforces
authentication, per-tool policy, rate limits, caching, audit logging, tool-definition
pinning and tracing.

> **Status: M1 walking skeleton.** Merged, namespaced tool catalogue and call routing
> with full 2026-07-28 header/body validation. There is **no authentication or policy
> yet**: every listed tool is callable. Do not expose this build beyond localhost.

## Quick start

Requirements: Node 22.12+, pnpm 10 (`corepack enable`), Docker (optional).

```bash
pnpm install
pnpm test
```

Run locally without Docker:

```bash
pnpm build
DEMO=crm PORT=9101 node packages/demo-servers/dist/main.js &
DEMO=files PORT=9102 node packages/demo-servers/dist/main.js &
(cd apps/gateway && node dist/main.js) &
scripts/smoke.sh
```

Or with Docker Compose:

```bash
docker compose -f deploy/docker-compose.yml up -d --build --wait gateway
scripts/smoke.sh
```

`docker compose -f deploy/docker-compose.yml up -d` also starts MongoDB, Redis,
Keycloak, the OpenTelemetry collector and Jaeger, which later milestones use.

## What M1 does

```
agent ──POST /mcp──▶ Host/Origin check ─▶ SDK edge: era, MCP-Protocol-Version,
                                          Mcp-Method/Mcp-Name vs body (-32020/-32022)
                                        ─▶ gateway: catalogue lookup ─▶ upstream client
                                                                         (own credentials)
```

- **One endpoint, many upstreams.** Tools are exposed as `{slug}__{tool}`
  (`crm__read_customer`), resolved by exact table lookup, never by parsing the name.
- **Deterministic, cache-aware listing.** Sorted names; `ttlMs` bounded by the
  upstreams' own TTLs; `cacheScope: "private"` because lists become per-caller in M2.
- **Validation before anything else.** Header/body mismatches, base64-sentinel tricks,
  case changes and namespace escapes are refused before an upstream is contacted
  (`tests/bypass`).
- **No token passthrough.** The client's `Authorization` header is never forwarded; each
  upstream gets the gateway's own credential.
- **Hop hygiene.** Upstream identity (`_meta` serverInfo) and addresses never reach the
  client; unknown and (from M2) denied tools both answer `-32602 Unknown tool`.

## Layout

| Path                    | What                                                        |
| ----------------------- | ----------------------------------------------------------- |
| `apps/gateway`          | The gateway (Fastify shell + MCP TypeScript SDK v2)         |
| `packages/protocol`     | Pure helpers: tool-name codec, error codes, header encoding |
| `packages/demo-servers` | Demo upstreams: `crm` (read/write) and `files` (read-only)  |
| `tests`                 | Contract and bypass suites against in-process upstreams     |
| `deploy`                | Docker Compose, OTel collector, Keycloak realm (M2)         |
| `docs/spec-review.md`   | Spec review: open questions answered against 2026-07-28     |

## Roadmap

M2 auth + default-deny policy (Keycloak) · M3 registry + tool pinning / rug-pull
quarantine · M4 rate limits, timeouts, circuit breaking, MRTR passthrough · M5 legacy
(2025-era) upstreams · M6 audit log + OpenTelemetry · M7 React console · M8
conformance, load numbers, threat model, hosted demo.

## Building behind a TLS-intercepting proxy

Pass the proxy's CA as a build secret; it is used only during dependency install and
never stored in an image layer:

```bash
docker build --secret id=extra_ca,src=/path/to/proxy-ca.pem \
  --build-arg APP=@gatekeeper/gateway -t gatekeeper-gateway:dev .
```
