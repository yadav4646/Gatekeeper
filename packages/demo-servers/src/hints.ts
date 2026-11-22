/**
 * Tool lists of the demo upstreams are identical for every caller, so they are
 * publicly cacheable (MCP 2026-07-28 server/utilities/caching).
 */
export const demoCacheHints = {
  'tools/list': { ttlMs: 60_000, cacheScope: 'public' },
  'server/discover': { ttlMs: 300_000, cacheScope: 'public' },
} as const;
