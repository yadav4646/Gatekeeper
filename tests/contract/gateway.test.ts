import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GATEWAY_URL, MODERN, createHarness, modernRequest, readRpc, type Harness } from '../harness.js';

let h: Harness;
beforeEach(() => {
  h = createHarness();
});
afterEach(async () => {
  await h.close();
});

async function rpc(method: string, params: Record<string, unknown> = {}) {
  const req = modernRequest(method, params);
  const res = await h.send(req);
  return { res, reply: await readRpc(res) };
}

describe('tools/list', () => {
  it('merges upstream tools under namespaced, sorted names', async () => {
    const { res, reply } = await rpc('tools/list');
    expect(res.status).toBe(200);
    const names = (reply?.result?.tools as { name: string }[]).map((t) => t.name);
    expect(names).toEqual([
      'crm__delete_customer',
      'crm__read_customer',
      'crm__search_customers',
      'crm__update_customer',
      'files__list',
      'files__read',
    ]);
  });

  it('carries cache hints: private scope, ttl bounded by the upstream ttl', async () => {
    const { reply } = await rpc('tools/list');
    expect(reply?.result?.cacheScope).toBe('private');
    const ttl = reply?.result?.ttlMs as number;
    expect(Number.isInteger(ttl)).toBe(true);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60_000); // demo upstreams advertise 60s
    // The catalogue lifetime comes from the upstreams' advertised ttlMs, not the 30s default.
    expect((await h.gateway.catalog.current()).ttlMs).toBe(60_000);
  });

  it('is a complete result and identifies the gateway', async () => {
    const { reply } = await rpc('tools/list');
    expect(reply?.result?.resultType).toBe('complete');
    const meta = reply?.result?._meta as Record<string, { name: string }> | undefined;
    expect(meta?.['io.modelcontextprotocol/serverInfo']?.name).toBe('gatekeeper');
  });

  it('keeps upstream schemas and annotations intact', async () => {
    const { reply } = await rpc('tools/list');
    const read = (reply?.result?.tools as Record<string, unknown>[]).find(
      (t) => t.name === 'crm__read_customer',
    );
    expect(read).toMatchObject({
      title: 'Read customer',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
      annotations: { readOnlyHint: true },
    });
  });

  it('rejects a cursor it never issued', async () => {
    const { reply } = await rpc('tools/list', { cursor: 'forged' });
    expect(reply?.error?.code).toBe(-32602);
  });

  it('fans out to upstreams once per catalogue lifetime', async () => {
    await rpc('tools/list');
    await rpc('tools/list');
    await rpc('tools/list');
    const lists = h.upstreamRequests.filter((r) => (r.body as { method?: string })?.method === 'tools/list');
    expect(lists).toHaveLength(2); // one per upstream
  });
});

describe('tools/call', () => {
  it('routes to the right upstream with the original tool name in body and Mcp-Name', async () => {
    const { res, reply } = await rpc('tools/call', {
      name: 'crm__read_customer',
      arguments: { id: 'c-001' },
    });
    expect(res.status).toBe(200);
    expect(reply?.result?.structuredContent).toEqual({
      customer: { id: 'c-001', name: 'Ada Lovelace', email: 'ada@example.com', tier: 'enterprise' },
    });

    const forwarded = h.upstreamRequests.find(
      (r) => (r.body as { method?: string })?.method === 'tools/call',
    );
    expect(forwarded?.upstream).toBe('crm');
    expect((forwarded?.body as { params: { name: string } }).params.name).toBe('read_customer');
    expect(forwarded?.headers['mcp-name']).toBe('read_customer');
    expect(forwarded?.headers['mcp-method']).toBe('tools/call');
    expect(forwarded?.headers['mcp-protocol-version']).toBe(MODERN);
  });

  it('identifies itself, not the upstream, in call results', async () => {
    const { reply } = await rpc('tools/call', { name: 'crm__read_customer', arguments: { id: 'c-001' } });
    const meta = reply?.result?._meta as Record<string, { name?: string }> | undefined;
    expect(JSON.stringify(reply)).not.toContain('demo-crm');
    expect(meta?.['io.modelcontextprotocol/serverInfo']?.name ?? 'gatekeeper').toBe('gatekeeper');
  });

  it('never forwards the client Authorization header to the upstream', async () => {
    const req = modernRequest('tools/call', { name: 'files__list', arguments: {} });
    await h.send({ ...req, headers: { ...req.headers, authorization: 'Bearer client-token' } });
    const forwarded = h.upstreamRequests.filter((r) => r.upstream === 'files');
    expect(forwarded.length).toBeGreaterThan(0);
    for (const r of forwarded) expect(r.headers.authorization).toBeUndefined();
  });

  it('returns upstream tool errors as results, not protocol errors', async () => {
    const { reply } = await rpc('tools/call', { name: 'files__read', arguments: { path: 'nope.txt' } });
    expect(reply?.result?.isError).toBe(true);
    expect(h.events.at(-1)).toMatchObject({ requestedName: 'files__read', outcome: 'tool_error' });
  });

  it('answers unknown tools with -32602 "Unknown tool" and never contacts an upstream', async () => {
    const { reply } = await rpc('tools/call', { name: 'crm__drop_tables', arguments: {} });
    expect(reply?.error).toMatchObject({ code: -32602, message: 'Unknown tool: crm__drop_tables' });
    expect(h.upstreamRequests.some((r) => (r.body as { method?: string })?.method === 'tools/call')).toBe(
      false,
    );
    expect(h.events.at(-1)).toMatchObject({ outcome: 'unknown_tool' });
  });

  it('reports an unreachable upstream without leaking its address', async () => {
    await h.close();
    h = createHarness({ failing: ['files'] });
    const list = await rpc('tools/list');
    const names = (list.reply?.result?.tools as { name: string }[]).map((t) => t.name);
    expect(names.every((n) => n.startsWith('crm__'))).toBe(true);

    const { reply } = await rpc('tools/call', { name: 'files__list', arguments: {} });
    expect(reply?.error?.code).toBe(-32602); // its tools are not in the catalogue at all
    expect(JSON.stringify(reply)).not.toContain('files.test');
  });

  it('emits one call event per call with latency', async () => {
    await rpc('tools/call', { name: 'crm__search_customers', arguments: { query: 'a' } });
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({
      requestedName: 'crm__search_customers',
      upstream: 'crm',
      upstreamTool: 'search_customers',
      outcome: 'ok',
    });
    expect(h.events[0]!.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

describe('server/discover', () => {
  it('advertises the modern revision and the tools capability', async () => {
    const { reply } = await rpc('server/discover');
    const result = reply?.result as Record<string, unknown>;
    expect(result.supportedVersions).toContain(MODERN);
    expect(result.capabilities).toMatchObject({ tools: {} });
    expect(result.ttlMs).toEqual(expect.any(Number));
    expect(result.cacheScope).toMatch(/^(public|private)$/);
  });
});

describe('SDK client end to end', () => {
  it('a stock 2026-07-28 client can list and call through the gateway', async () => {
    const client = new Client(
      { name: 'e2e', version: '0.0.0' },
      { versionNegotiation: { mode: { pin: MODERN } } },
    );
    await client.connect(
      new StreamableHTTPClientTransport(new URL(GATEWAY_URL), {
        // A real HTTP client always sends Host; the in-process Request does not.
        fetch: (input, init) => {
          const req = new Request(input, init);
          const headers = new Headers(req.headers);
          headers.set('host', new URL(req.url).host);
          return h.gateway.http.fetch(new Request(req, { headers }));
        },
      }),
    );
    expect(client.getProtocolEra()).toBe('modern');
    expect(client.getServerVersion()?.name).toBe('gatekeeper');

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('files__read');

    const result = await client.callTool({
      name: 'files__read',
      arguments: { path: 'handbook/security.md' },
    });
    expect(result.content).toEqual([{ type: 'text', text: '# Security\n\nNever share credentials.' }]);
    await client.close();
  });
});
