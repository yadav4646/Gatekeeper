import { encodeHeaderValue } from '@gatekeeper/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, modernRequest, readRpc, type Harness } from '../harness.js';

/**
 * Edge and bypass cases for the /mcp endpoint. Each case must be refused BEFORE any
 * upstream sees a tools/call. Policy (M2) runs only on validated bodies, so these
 * guarantees are what make header-based tricks impossible.
 */

let h: Harness;
beforeEach(() => {
  h = createHarness();
});
afterEach(async () => {
  await h.close();
});

const upstreamCalls = () =>
  h.upstreamRequests.filter((r) => (r.body as { method?: string })?.method === 'tools/call');

describe('protocol version', () => {
  it('rejects an unsupported version with 400 / -32022 listing supported versions', async () => {
    const res = await h.send(modernRequest('tools/list', {}, { version: '1900-01-01' }));
    const reply = await readRpc(res);
    expect(res.status).toBe(400);
    expect(reply?.error?.code).toBe(-32022);
    expect((reply?.error?.data as { supported: string[] }).supported).toContain('2026-07-28');
  });

  it('rejects a header version that disagrees with the body _meta (400 / -32020)', async () => {
    const req = modernRequest('tools/list');
    req.headers['mcp-protocol-version'] = '2025-11-25';
    const res = await h.send(req);
    expect(res.status).toBe(400);
    expect((await readRpc(res))?.error?.code).toBe(-32020);
  });
});

describe('header/body consistency', () => {
  it('rejects Mcp-Name that disagrees with params.name (400 / -32020)', async () => {
    const req = modernRequest('tools/call', { name: 'crm__delete_customer', arguments: { id: 'c-001' } });
    req.headers['mcp-name'] = 'crm__read_customer'; // a header-routing proxy would see "read"
    const res = await h.send(req);
    expect(res.status).toBe(400);
    expect((await readRpc(res))?.error?.code).toBe(-32020);
    expect(upstreamCalls()).toHaveLength(0);
  });

  it('rejects a missing Mcp-Name on tools/call', async () => {
    const req = modernRequest('tools/call', { name: 'crm__read_customer', arguments: { id: 'c-001' } });
    delete req.headers['mcp-name'];
    const res = await h.send(req);
    expect(res.status).toBe(400);
    expect(upstreamCalls()).toHaveLength(0);
  });

  it('rejects Mcp-Method that disagrees with the body method', async () => {
    const req = modernRequest('tools/call', { name: 'crm__read_customer', arguments: { id: 'c-001' } });
    req.headers['mcp-method'] = 'tools/list';
    const res = await h.send(req);
    expect(res.status).toBe(400);
    expect(upstreamCalls()).toHaveLength(0);
  });

  it('decodes a base64-sentinel Mcp-Name and still requires it to match the body', async () => {
    const req = modernRequest('tools/call', { name: 'crm__delete_customer', arguments: { id: 'c-001' } });
    // Sentinel-encoded value of a DIFFERENT tool.
    req.headers['mcp-name'] = `=?base64?${Buffer.from('crm__read_customer').toString('base64')}?=`;
    const res = await h.send(req);
    expect(res.status).toBe(400);
    expect(upstreamCalls()).toHaveLength(0);
  });

  it('accepts a correctly sentinel-encoded Mcp-Name', async () => {
    const req = modernRequest('tools/call', { name: 'files__list', arguments: {} });
    req.headers['mcp-name'] = `=?base64?${Buffer.from('files__list').toString('base64')}?=`;
    const res = await h.send(req);
    expect(res.status).toBe(200);
    expect(encodeHeaderValue('files__list')).toBe('files__list'); // plain form is the canonical one
  });
});

describe('tool name resolution', () => {
  it.each([
    ['case change', 'CRM__read_customer'],
    ['case change in tool', 'crm__Read_Customer'],
    ['bare upstream name', 'read_customer'],
    ['dot separator', 'crm.read_customer'],
    ['single underscore', 'crm_read_customer'],
    ['trailing space', 'crm__read_customer '],
    ['slug escape', 'crm__files__read'],
    ['unicode lookalike', 'crm__read_customеr'], // Cyrillic е
  ])('%s (%j) is an unknown tool', async (_label, name) => {
    const req = modernRequest(
      'tools/call',
      { name, arguments: { id: 'c-001' } },
      { name: encodeHeaderValue(name) },
    );
    const res = await h.send(req);
    const reply = await readRpc(res);
    expect(reply?.error?.code).toBe(-32602);
    expect(upstreamCalls()).toHaveLength(0);
  });
});

describe('message shape', () => {
  it('rejects a JSON-RPC batch', async () => {
    const one = modernRequest('tools/list');
    const res = await h.send({ headers: one.headers, rawBody: JSON.stringify([one.body, one.body]) });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(upstreamCalls()).toHaveLength(0);
  });

  it('rejects malformed JSON', async () => {
    const { headers } = modernRequest('tools/list');
    const res = await h.send({ headers, rawBody: '{"jsonrpc":"2.0",' });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('rejects a non-JSON content type with 415', async () => {
    const req = modernRequest('tools/list');
    const res = await h.send({ ...req, headers: { ...req.headers, 'content-type': 'text/plain' } });
    expect(res.status).toBe(415);
  });

  it('treats duplicate keys deterministically: the routed name is the validated one', async () => {
    // JSON.parse keeps the LAST duplicate. Whatever the gateway resolves, it must be the
    // same value the header was validated against, so the upstream call matches Mcp-Name.
    const req = modernRequest('tools/call', { name: 'files__list', arguments: {} });
    const raw = JSON.stringify(req.body).replace(
      '"name":"files__list"',
      '"name":"crm__delete_customer","name":"files__list"',
    );
    const res = await h.send({ headers: req.headers, rawBody: raw });
    expect(res.status).toBe(200);
    const calls = upstreamCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.upstream).toBe('files');
  });
});

describe('transport edge', () => {
  it('answers GET with 405 (no standalone stream in 2026-07-28)', async () => {
    const res = await h.send({ method: 'GET', headers: { accept: 'text/event-stream' } });
    expect(res.status).toBe(405);
  });

  it('answers DELETE with 405 (no sessions)', async () => {
    const res = await h.send({ method: 'DELETE' });
    expect(res.status).toBe(405);
  });

  it('rejects a foreign browser Origin with 403', async () => {
    const req = modernRequest('tools/list');
    const res = await h.send({ ...req, headers: { ...req.headers, origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
  });

  it('rejects a foreign Host header (DNS rebinding) with 403', async () => {
    const req = modernRequest('tools/list');
    const res = await h.send({ ...req, headers: { ...req.headers, host: 'attacker.example' } });
    expect(res.status).toBe(403);
  });

  it('answers an unknown method with 404 / -32601', async () => {
    const res = await h.send(modernRequest('crm/drop_everything'));
    expect(res.status).toBe(404);
    expect((await readRpc(res))?.error?.code).toBe(-32601);
  });

  it('ignores a legacy Mcp-Session-Id and never mints one', async () => {
    const req = modernRequest('tools/list');
    const res = await h.send({ ...req, headers: { ...req.headers, 'mcp-session-id': 'abc' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeNull();
  });
});
