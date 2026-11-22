import { createMcpHandler, type McpHttpHandler } from '@modelcontextprotocol/server';
import { createCrmServer, createCrmStore } from './crm.js';
import { createFilesServer } from './files.js';

export { createCrmServer, createCrmStore } from './crm.js';
export { createFilesServer } from './files.js';
export { demoCacheHints } from './hints.js';

export type DemoName = 'crm' | 'files';
export const DEMO_NAMES: readonly DemoName[] = ['crm', 'files'];

export function isDemoName(value: string): value is DemoName {
  return (DEMO_NAMES as readonly string[]).includes(value);
}

/**
 * Build a web-standard MCP handler for a demo upstream. A fresh server instance is
 * created per request (stateless); demo data lives outside the instance.
 */
export function createDemoHandler(name: DemoName): McpHttpHandler {
  switch (name) {
    case 'crm': {
      const store = createCrmStore();
      return createMcpHandler(() => createCrmServer(store));
    }
    case 'files':
      return createMcpHandler(() => createFilesServer());
  }
}
