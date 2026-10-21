import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // always the source of core, never a stale dist
    alias: { '@aivu/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)) }
  }
});
