/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Tauri serves the bundle from its own protocol, so paths must be relative.
  base: './',
  clearScreen: false,
  build: {
    outDir: 'dist',
    target: 'chrome110',
    chunkSizeWarningLimit: 900,
  },
  server: {
    port: 5123,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**', '**/engine/**'] },
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
