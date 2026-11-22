import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { demoCacheHints } from './hints.js';

/** A read-only virtual file store upstream. No real filesystem access. */

const FILES: Record<string, string> = {
  'handbook/onboarding.md': '# Onboarding\n\nWelcome aboard.',
  'handbook/security.md': '# Security\n\nNever share credentials.',
  'reports/q3.csv': 'region,revenue\nemea,120\namer,340\n',
};

export function createFilesServer(): McpServer {
  const server = new McpServer({ name: 'demo-files', version: '0.1.0' }, { cacheHints: demoCacheHints });

  server.registerTool(
    'list',
    {
      title: 'List files',
      description: 'List file paths, optionally under a prefix.',
      inputSchema: z.object({ prefix: z.string().max(200).optional() }),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ prefix }) => {
      const paths = Object.keys(FILES)
        .filter((p) => !prefix || p.startsWith(prefix))
        .sort();
      return { content: [{ type: 'text', text: paths.join('\n') }] };
    },
  );

  server.registerTool(
    'read',
    {
      title: 'Read file',
      description: 'Read a file by its exact path.',
      inputSchema: z.object({ path: z.string().max(200) }),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ path }) => {
      const body = FILES[path];
      if (body === undefined) {
        return { content: [{ type: 'text', text: `not found: ${path}` }], isError: true };
      }
      return { content: [{ type: 'text', text: body }] };
    },
  );

  return server;
}
