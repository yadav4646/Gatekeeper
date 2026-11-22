import type { FetchLike } from '@modelcontextprotocol/client';
import { Catalog } from './catalog.js';
import type { GatewayConfig } from './config.js';
import { createGatewayHttp, type GatewayHttp } from './http.js';
import type { GatewayHooks } from './hooks/index.js';
import { UpstreamConnection } from './upstream/connection.js';

export interface Gateway {
  http: GatewayHttp;
  catalog: Catalog;
  upstreams: UpstreamConnection[];
  close(): Promise<void>;
}

export interface CreateGatewayOptions {
  config: GatewayConfig;
  hooks: GatewayHooks;
  /** Override outbound fetch (tests route upstream calls to in-process handlers). */
  upstreamFetch?: FetchLike;
  onerror?: (error: Error) => void;
  now?: () => number;
}

export function createGateway({ config, hooks, upstreamFetch, onerror, now }: CreateGatewayOptions): Gateway {
  const upstreams = config.upstreams.map((u) => new UpstreamConnection(u, upstreamFetch));
  const catalog = new Catalog(upstreams, config.catalog, now);
  const http = createGatewayHttp(config, catalog, hooks, onerror);
  return {
    http,
    catalog,
    upstreams,
    async close() {
      await http.close();
      await Promise.allSettled(upstreams.map((u) => u.close()));
    },
  };
}
