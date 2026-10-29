import { defineConfig } from 'electron-vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { resolve } from 'node:path'

const alias = { '@shared': resolve('src/shared') }

export default defineConfig(({ mode }) => ({
  main: {
    resolve: { alias },
  },
  preload: {
    resolve: { alias },
    // Sandboxed preloads cannot be ES modules.
    build: { rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } } },
  },
  renderer: {
    plugins: [svelte()],
    resolve: { alias },
    // The end-to-end tests count calls of renderer functions by name.
    build: { minify: mode !== 'e2e' },
  },
}))
