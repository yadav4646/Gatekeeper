import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { demoCacheHints } from './hints.js';

/**
 * A tiny CRM-like upstream with read and write tools, used to demonstrate per-tool
 * policy (e.g. support agents may read but not delete).
 */

interface Customer {
  id: string;
  name: string;
  email: string;
  tier: 'free' | 'pro' | 'enterprise';
}

const seed = (): Map<string, Customer> =>
  new Map(
    [
      { id: 'c-001', name: 'Ada Lovelace', email: 'ada@example.com', tier: 'enterprise' },
      { id: 'c-002', name: 'Alan Turing', email: 'alan@example.com', tier: 'pro' },
      { id: 'c-003', name: 'Grace Hopper', email: 'grace@example.com', tier: 'free' },
    ].map((c) => [c.id, c as Customer]),
  );

const CustomerShape = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  tier: z.enum(['free', 'pro', 'enterprise']),
});

const json = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
});

/** Store shared across per-request server instances (the server itself is stateless). */
export function createCrmStore() {
  return seed();
}

export function createCrmServer(store: Map<string, Customer>): McpServer {
  const server = new McpServer({ name: 'demo-crm', version: '0.1.0' }, { cacheHints: demoCacheHints });

  server.registerTool(
    'read_customer',
    {
      title: 'Read customer',
      description: 'Fetch a single customer record by id.',
      inputSchema: z.object({ id: z.string().describe('Customer id, e.g. c-001') }),
      outputSchema: z.object({ customer: CustomerShape.nullable() }),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ id }) => {
      const customer = store.get(id) ?? null;
      return { ...json({ customer }), structuredContent: { customer } };
    },
  );

  server.registerTool(
    'search_customers',
    {
      title: 'Search customers',
      description: 'Case-insensitive substring search over customer names.',
      inputSchema: z.object({ query: z.string().min(1).max(100) }),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ query }) => {
      const q = query.toLowerCase();
      return json([...store.values()].filter((c) => c.name.toLowerCase().includes(q)));
    },
  );

  server.registerTool(
    'update_customer',
    {
      title: 'Update customer tier',
      description: "Change a customer's subscription tier.",
      inputSchema: z.object({ id: z.string(), tier: z.enum(['free', 'pro', 'enterprise']) }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ id, tier }) => {
      const c = store.get(id);
      if (!c) return { ...json({ error: `no customer ${id}` }), isError: true };
      c.tier = tier;
      return json(c);
    },
  );

  server.registerTool(
    'delete_customer',
    {
      title: 'Delete customer',
      description: 'Permanently delete a customer record.',
      inputSchema: z.object({ id: z.string() }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ id }) => {
      const existed = store.delete(id);
      return json({ deleted: existed, id });
    },
  );

  return server;
}
