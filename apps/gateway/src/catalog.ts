import { ToolNameTable, type Rejection } from '@gatekeeper/protocol';
import type { Tool } from '@modelcontextprotocol/client';
import type { GatewayConfig } from './config.js';
import type { UpstreamConnection } from './upstream/connection.js';

export interface CatalogEntry {
  upstream: UpstreamConnection;
  /** The upstream's tool definition, unmodified. */
  tool: Tool;
}

export interface UpstreamStatus {
  slug: string;
  ok: boolean;
  toolCount: number;
  error?: string;
  refreshedAt: string;
}

export interface CatalogSnapshot {
  table: ToolNameTable<CatalogEntry>;
  builtAt: number;
  ttlMs: number;
  upstreams: UpstreamStatus[];
  rejections: readonly Rejection[];
}

/**
 * The merged tool catalogue across all enabled upstreams.
 *
 * - Refreshes lazily when stale, single-flight, so a burst of requests causes one
 *   fan-out to upstreams.
 * - Freshness = min(upstream ttlMs), clamped to [minTtlMs, maxTtlMs].
 * - A failing upstream contributes no tools (fail closed) but does not take the others
 *   down. If a refresh fails entirely, the previous snapshot keeps being served
 *   (stale-if-error, which the caching spec allows).
 *
 * From M3, every tool also passes through definition pinning before it is published.
 */
export class Catalog {
  private snapshot: CatalogSnapshot | undefined;
  private refreshing: Promise<CatalogSnapshot> | undefined;

  constructor(
    private readonly upstreams: UpstreamConnection[],
    private readonly options: GatewayConfig['catalog'],
    private readonly now: () => number = Date.now,
  ) {}

  async current(): Promise<CatalogSnapshot> {
    const snap = this.snapshot;
    if (snap && this.now() < snap.builtAt + snap.ttlMs) return snap;
    return this.refresh();
  }

  /** Remaining freshness of the current snapshot, in ms. */
  remainingTtl(snap: CatalogSnapshot): number {
    return Math.max(0, snap.builtAt + snap.ttlMs - this.now());
  }

  refresh(): Promise<CatalogSnapshot> {
    this.refreshing ??= this.build()
      .then((snap) => {
        this.snapshot = snap;
        return snap;
      })
      .finally(() => {
        this.refreshing = undefined;
      });
    return this.refreshing;
  }

  private async build(): Promise<CatalogSnapshot> {
    const enabled = this.upstreams.filter((u) => u.config.enabled);
    const results = await Promise.allSettled(enabled.map((u) => u.listTools()));
    const table = new ToolNameTable<CatalogEntry>();
    const statuses: UpstreamStatus[] = [];
    const ttls: number[] = [];
    const refreshedAt = new Date(this.now()).toISOString();

    results.forEach((r, i) => {
      const upstream = enabled[i]!;
      if (r.status === 'rejected') {
        statuses.push({
          slug: upstream.slug,
          ok: false,
          toolCount: 0,
          error: r.reason instanceof Error ? r.reason.message : String(r.reason),
          refreshedAt,
        });
        return;
      }
      let count = 0;
      for (const tool of r.value.tools) {
        if (table.add(upstream.slug, tool.name, { upstream, tool })) count++;
      }
      ttls.push(r.value.ttlMs ?? this.options.defaultTtlMs);
      statuses.push({ slug: upstream.slug, ok: true, toolCount: count, refreshedAt });
    });

    const anyOk = statuses.some((s) => s.ok);
    if (!anyOk && this.snapshot && enabled.length > 0) {
      // Total failure: keep serving the last good catalogue, but retry soon.
      return { ...this.snapshot, builtAt: this.now(), ttlMs: this.options.minTtlMs, upstreams: statuses };
    }

    const advertised = ttls.length ? Math.min(...ttls) : this.options.minTtlMs;
    const ttlMs = Math.min(this.options.maxTtlMs, Math.max(this.options.minTtlMs, advertised));
    return { table, builtAt: this.now(), ttlMs, upstreams: statuses, rejections: table.rejections() };
  }
}
