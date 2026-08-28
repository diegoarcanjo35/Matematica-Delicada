/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: true,
    // e2e/ e evidence/ são specs do Playwright (Chromium real), rodados via
    // `npx playwright test` — não são testes de componente do Vitest.
    // worker/**/*.test.ts roda em ambiente 'node' (via comentário mágico
    // @vitest-environment em cada arquivo), não 'jsdom' — são funções puras
    // do runtime Workers, sem DOM.
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'worker/**/*.test.ts', 'scripts/**/*.test.ts'],
  },
})
