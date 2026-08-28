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
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
})
