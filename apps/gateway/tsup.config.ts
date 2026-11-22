import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  target: 'node22',
  clean: true,
  // Workspace packages ship TypeScript source, so bundle them; npm deps stay external.
  noExternal: [/^@gatekeeper\//],
});
