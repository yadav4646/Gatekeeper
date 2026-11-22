import { createServer } from 'node:http';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createDemoHandler, isDemoName } from './index.js';

/**
 * Serve one demo upstream over Streamable HTTP.
 *   DEMO=crm PORT=9101 node dist/main.js
 * The MCP endpoint is POST /mcp. These are demo servers: they bind to HOST
 * (default 127.0.0.1) and have no auth of their own; the gateway fronts them.
 */
const demo = process.env.DEMO ?? '';
if (!isDemoName(demo)) {
  console.error(`DEMO must be one of: crm, files (got ${JSON.stringify(demo)})`);
  process.exit(1);
}
const port = Number(process.env.PORT ?? 9100);
const host = process.env.HOST ?? '127.0.0.1';

const mcp = toNodeHandler(createDemoHandler(demo));
const server = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  if (path === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    return;
  }
  if (path !== '/mcp') {
    res.writeHead(404).end();
    return;
  }
  void mcp(req, res);
});

server.listen(port, host, () => console.log(`demo-${demo} listening on http://${host}:${port}/mcp`));
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => server.close(() => process.exit(0)));
