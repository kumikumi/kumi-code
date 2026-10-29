import { defineConfig } from 'vitest/config'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { resolve } from 'node:path'

export default defineConfig({
  plugins: [svelte()],
  resolve: { alias: { '@shared': resolve('src/shared') } },
  test: { include: ['src/**/*.test.ts'] },
})
