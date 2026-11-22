import Fastify, { type FastifyInstance } from 'fastify';
import type { Gateway } from './app.js';

/**
 * HTTP shell around the gateway. Fastify owns routing, health and (from M3) the admin
 * API; the MCP endpoint itself is the web-standard handler from `http.ts`.
 */
export function createServer(gateway: Gateway): FastifyInstance {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, bodyLimit: 4 * 1024 * 1024 });

  // The MCP handler must see the exact bytes the client sent (duplicate keys,
  // header/body consistency), so /mcp bodies are not parsed by Fastify.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  app.get('/healthz', async () => ({ ok: true }));

  app.get('/readyz', async (_req, reply) => {
    const snap = await gateway.catalog.current().catch(() => undefined);
    const upstreams = snap?.upstreams ?? [];
    const ready = upstreams.some((u) => u.ok);
    return reply.code(ready ? 200 : 503).send({
      ready,
      tools: snap?.table.size ?? 0,
      upstreams,
      rejectedTools: snap?.rejections ?? [],
    });
  });

  app.route({
    method: ['POST', 'GET', 'DELETE'],
    url: '/mcp',
    handler: async (req, reply) => {
      const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined) continue;
        for (const item of Array.isArray(v) ? v : [v]) headers.append(k, item);
      }
      const abort = new AbortController();
      reply.raw.on('close', () => abort.abort());
      const body = req.body instanceof Buffer && req.method === 'POST' ? new Uint8Array(req.body) : undefined;
      const response = await gateway.http.fetch(
        new Request(url, { method: req.method, headers, ...(body ? { body } : {}), signal: abort.signal }),
      );
      reply.code(response.status);
      response.headers.forEach((value, key) => reply.header(key, value));
      return reply.send(response.body ? response.body : undefined);
    },
  });

  return app;
}
