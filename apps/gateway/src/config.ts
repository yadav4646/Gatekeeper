import { readFile } from 'node:fs/promises';
import { isValidSlug } from '@gatekeeper/protocol';
import { parse as parseYaml } from 'yaml';
import * as z from 'zod';

/**
 * Static gateway configuration. In M1 upstreams come from this file; from M3 the
 * registry lives in MongoDB and this file only seeds it.
 */

const UpstreamAuth = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  /**
   * The gateway's OWN credential for this upstream, read from an environment variable.
   * Client tokens are never forwarded to upstreams (MCP 2026-07-28
   * authorization/security-considerations: no token passthrough).
   */
  z.object({ type: z.literal('bearer'), tokenEnv: z.string().min(1) }),
]);

const Upstream = z.object({
  slug: z.string().refine(isValidSlug, 'slug must match [a-z0-9]+(-[a-z0-9]+)* and be at most 24 chars'),
  url: z.url(),
  enabled: z.boolean().default(true),
  timeoutMs: z.number().int().positive().max(120_000).default(10_000),
  auth: UpstreamAuth.default({ type: 'none' }),
});

export const GatewayConfigSchema = z
  .object({
    listen: z
      .object({
        host: z.string().default('127.0.0.1'),
        port: z.number().int().min(0).max(65535).default(8080),
      })
      .default({ host: '127.0.0.1', port: 8080 }),
    /**
     * Host header allowlist (DNS-rebinding protection). Hostnames only, no port.
     * Defaults to localhost-class names.
     */
    allowedHosts: z.array(z.string()).default(['localhost', '127.0.0.1', '[::1]']),
    /**
     * Origin hostnames allowed for browser-originated requests. Requests without an
     * Origin header (non-browser agents) pass; a present, unlisted Origin gets 403.
     */
    allowedOrigins: z.array(z.string()).default(['localhost', '127.0.0.1', '[::1]']),
    /** Dev-only escape hatch: permit http:// upstream URLs. https is required otherwise. */
    allowInsecureUpstreams: z.boolean().default(false),
    catalog: z
      .object({
        /** Lower bound on how long a merged tool catalogue is reused. */
        minTtlMs: z.number().int().min(0).default(5_000),
        /** Upper bound, regardless of what upstreams advertise. */
        maxTtlMs: z.number().int().min(0).default(300_000),
        /** Used when an upstream omits ttlMs (pre-2026 behaviour). */
        defaultTtlMs: z.number().int().min(0).default(30_000),
      })
      .default({ minTtlMs: 5_000, maxTtlMs: 300_000, defaultTtlMs: 30_000 }),
    upstreams: z.array(Upstream).default([]),
  })
  .superRefine((cfg, ctx) => {
    const seen = new Set<string>();
    cfg.upstreams.forEach((u, i) => {
      if (seen.has(u.slug)) {
        ctx.addIssue({ code: 'custom', path: ['upstreams', i, 'slug'], message: `duplicate slug ${u.slug}` });
      }
      seen.add(u.slug);
      const protocol = new URL(u.url).protocol;
      if (protocol !== 'https:' && !(protocol === 'http:' && cfg.allowInsecureUpstreams)) {
        ctx.addIssue({
          code: 'custom',
          path: ['upstreams', i, 'url'],
          message: 'upstream URL must be https (set allowInsecureUpstreams for local development)',
        });
      }
    });
    if (cfg.catalog.minTtlMs > cfg.catalog.maxTtlMs) {
      ctx.addIssue({ code: 'custom', path: ['catalog'], message: 'minTtlMs must be <= maxTtlMs' });
    }
  });

export type GatewayConfig = z.output<typeof GatewayConfigSchema>;
export type UpstreamConfig = GatewayConfig['upstreams'][number];

export function parseConfig(input: unknown): GatewayConfig {
  const result = GatewayConfigSchema.safeParse(input);
  if (!result.success) {
    throw new Error(`invalid gateway config:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export async function loadConfig(path: string): Promise<GatewayConfig> {
  const raw = parseYaml(await readFile(path, 'utf8')) as Record<string, unknown> | null;
  const cfg = { ...(raw ?? {}) };
  // Container-friendly overrides.
  if (process.env.GATEKEEPER_HOST || process.env.GATEKEEPER_PORT) {
    const listen = (cfg.listen ?? {}) as Record<string, unknown>;
    cfg.listen = {
      ...listen,
      ...(process.env.GATEKEEPER_HOST ? { host: process.env.GATEKEEPER_HOST } : {}),
      ...(process.env.GATEKEEPER_PORT ? { port: Number(process.env.GATEKEEPER_PORT) } : {}),
    };
  }
  return parseConfig(cfg);
}
