import { createGateway } from './app.js';
import { loadConfig } from './config.js';
import { developmentAllowAllHooks } from './hooks/index.js';
import { createServer } from './server.js';

const configPath = process.env.GATEKEEPER_CONFIG ?? 'config/gateway.yaml';
const config = await loadConfig(configPath);

const gateway = createGateway({
  config,
  hooks: developmentAllowAllHooks,
  onerror: (err) => app.log.warn({ err }, 'mcp handler error'),
});
const app = createServer(gateway);

app.log.warn('M1 build: no authentication or policy yet; every listed tool is callable');
app.addHook('onClose', () => gateway.close());

await app.listen({ host: config.listen.host, port: config.listen.port });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void app.close().then(() => process.exit(0));
  });
}
