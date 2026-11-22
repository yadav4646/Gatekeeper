import { Client as V1Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as V1Transport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GATEWAY_URL, MODERN, createHarness, gatewayFetch, upstreamCalls, type Harness } from '../harness.js';

/**
 * 2025-era clients (v1 SDK, MCP Inspector, most desktop apps today) talk to the gateway
 * through the SDK's stateless legacy fallback. The gateway still speaks 2026-07-28 to
 * its upstreams, so it bridges eras: legacy in front, modern behind.
 */

let h: Harness;
beforeEach(() => {
  h = createHarness();
});
afterEach(async () => {
  await h.close();
});

/** Every request the gateway sent upstream used the modern revision. */
function expectModernUpstreamLeg() {
  expect(h.upstreamRequests.length).toBeGreaterThan(0);
  for (const r of h.upstreamRequests) expect(r.headers['mcp-protocol-version']).toBe(MODERN);
}

describe('v1 SDK client (@modelcontextprotocol/sdk 1.x, protocol 2025-11-25)', () => {
  async function connect() {
    const responses: Response[] = [];
    const fetchImpl = gatewayFetch(h);
    const client = new V1Client({ name: 'legacy-v1', version: '0.0.0' });
    const transport = new V1Transport(new URL(GATEWAY_URL), {
      fetch: async (input, init) => {
        const res = await fetchImpl(input as string | URL | Request, init);
        responses.push(res.clone());
        return res;
      },
    });
    await client.connect(transport);
    return { client, transport, responses };
  }

  it('connects, lists namespaced tools and calls one', async () => {
    const { client } = await connect();
    expect(client.getServerVersion()?.name).toBe('gatekeeper');

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      'crm__delete_customer',
      'crm__read_customer',
      'crm__search_customers',
      'crm__update_customer',
      'files__list',
      'files__read',
    ]);

    const result = await client.callTool({ name: 'crm__read_customer', arguments: { id: 'c-003' } });
    expect(result.structuredContent).toEqual({
      customer: { id: 'c-003', name: 'Grace Hopper', email: 'grace@example.com', tier: 'free' },
    });
    expect(JSON.stringify(result)).not.toContain('demo-crm');
    await client.close();
  });

  it('is served statelessly: no session id is ever minted', async () => {
    const { client, transport, responses } = await connect();
    await client.listTools();
    expect(transport.sessionId).toBeUndefined();
    for (const r of responses) expect(r.headers.get('mcp-session-id')).toBeNull();
    await client.close();
  });

  it('bridges eras: the upstream leg stays on 2026-07-28', async () => {
    const { client } = await connect();
    await client.callTool({ name: 'files__list', arguments: {} });
    expectModernUpstreamLeg();
    await client.close();
  });

  it('gets -32602 for unknown and case-changed tools without an upstream call', async () => {
    const { client } = await connect();
    for (const name of ['crm__drop_tables', 'CRM__read_customer']) {
      await expect(client.callTool({ name, arguments: {} })).rejects.toMatchObject({ code: -32602 });
    }
    expect(upstreamCalls(h)).toHaveLength(0);
    await client.close();
  });
});

describe('v2 SDK client in legacy mode (no version negotiation)', () => {
  it('negotiates the legacy era and works end to end', async () => {
    const client = new Client({ name: 'legacy-v2', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(GATEWAY_URL), { fetch: gatewayFetch(h) }));
    expect(client.getProtocolEra()).toBe('legacy');

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('crm__search_customers');
    const result = await client.callTool({ name: 'crm__search_customers', arguments: { query: 'ada' } });
    expect(JSON.stringify(result.content)).toContain('Ada Lovelace');
    expectModernUpstreamLeg();
    await client.close();
  });
});
