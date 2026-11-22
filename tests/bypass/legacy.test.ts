import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, readRpc, upstreamCalls, type Harness } from '../harness.js';

/**
 * Raw 2025-era requests: no `_meta` envelope, optional `MCP-Protocol-Version` header,
 * no `Mcp-Method`/`Mcp-Name` mirroring. These are served by the SDK's stateless
 * legacy fallback in front of the same gateway server.
 */

let h: Harness;
let id = 1000;
beforeEach(() => {
  h = createHarness();
});
afterEach(async () => {
  await h.close();
});

function legacy(
  method: string,
  params?: Record<string, unknown>,
  { version, notification = false }: { version?: string; notification?: boolean } = {},
) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(version ? { 'mcp-protocol-version': version } : {}),
  };
  const body = {
    jsonrpc: '2.0',
    ...(notification ? {} : { id: id++ }),
    method,
    ...(params ? { params } : {}),
  };
  return { headers, body };
}

const initParams = (protocolVersion: string) => ({
  protocolVersion,
  capabilities: {},
  clientInfo: { name: 'raw-legacy', version: '0.0.0' },
});

describe('legacy initialize', () => {
  it.each(['2025-11-25', '2025-06-18', '2025-03-26'])('accepts initialize for %s', async (v) => {
    const res = await h.send(legacy('initialize', initParams(v)));
    const reply = await readRpc(res);
    expect(res.status).toBe(200);
    expect(reply?.result).toMatchObject({
      protocolVersion: v,
      serverInfo: { name: 'gatekeeper' },
      capabilities: { tools: {} },
    });
    expect(res.headers.get('mcp-session-id')).toBeNull();
  });

  it('acknowledges notifications/initialized with 202', async () => {
    const res = await h.send(legacy('notifications/initialized', undefined, { notification: true }));
    expect(res.status).toBe(202);
  });

  it('answers ping', async () => {
    const res = await h.send(legacy('ping', undefined, { version: '2025-11-25' }));
    expect((await readRpc(res))?.result).toEqual({});
  });
});

describe('legacy tools/list', () => {
  it('works with and without the MCP-Protocol-Version header', async () => {
    for (const version of ['2025-11-25', undefined]) {
      const reply = await readRpc(await h.send(legacy('tools/list', {}, { version })));
      expect((reply?.result?.tools as { name: string }[]).map((t) => t.name)).toContain('crm__read_customer');
    }
  });

  it('carries no 2026-only fields', async () => {
    const reply = await readRpc(await h.send(legacy('tools/list', {}, { version: '2025-11-25' })));
    expect(reply?.result).not.toHaveProperty('ttlMs');
    expect(reply?.result).not.toHaveProperty('cacheScope');
    expect(reply?.result).not.toHaveProperty('resultType');
  });
});

describe('legacy tools/call', () => {
  it('routes by the body name', async () => {
    const reply = await readRpc(
      await h.send(
        legacy(
          'tools/call',
          { name: 'files__read', arguments: { path: 'reports/q3.csv' } },
          { version: '2025-11-25' },
        ),
      ),
    );
    expect(JSON.stringify(reply?.result)).toContain('region,revenue');
    expect(upstreamCalls(h)).toHaveLength(1);
  });

  it.each(['crm__nope', 'CRM__read_customer', 'read_customer', 'crm__files__read'])(
    'refuses %j with -32602 and no upstream call',
    async (name) => {
      const reply = await readRpc(
        await h.send(legacy('tools/call', { name, arguments: { id: 'c-001' } }, { version: '2025-11-25' })),
      );
      expect(reply?.error?.code).toBe(-32602);
      expect(upstreamCalls(h)).toHaveLength(0);
    },
  );

  it('ignores a stray Mcp-Name on a legacy request: routing and policy follow the body', async () => {
    // 2025-era requests have no header mirroring. Whatever a stray header says, the
    // gateway resolves (and, from M2, authorizes) the body name, never the header.
    const req = legacy('tools/call', { name: 'files__list', arguments: {} }, { version: '2025-11-25' });
    const res = await h.send({ ...req, headers: { ...req.headers, 'mcp-name': 'crm__delete_customer' } });
    expect(res.status).toBeLessThan(500);
    const calls = upstreamCalls(h);
    expect(calls.every((c) => c.upstream === 'files')).toBe(true);
    expect(
      calls.some((c) => (c.body as { params: { name: string } }).params.name === 'delete_customer'),
    ).toBe(false);
  });
});

describe('legacy session operations', () => {
  it('answers GET with 405', async () => {
    const res = await h.send({
      method: 'GET',
      headers: { accept: 'text/event-stream', 'mcp-session-id': 'x' },
    });
    expect(res.status).toBe(405);
  });

  it('answers DELETE with 405', async () => {
    const res = await h.send({ method: 'DELETE', headers: { 'mcp-session-id': 'x' } });
    expect(res.status).toBe(405);
  });
});
