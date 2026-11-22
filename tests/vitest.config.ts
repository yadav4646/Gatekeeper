import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'contract', include: ['**/*.test.ts'], exclude: ['**/node_modules/**'] },
});
