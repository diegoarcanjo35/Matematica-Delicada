import { defineConfig, devices } from "@playwright/test";

/* Playwright — Sprint 1 v1.1, correções 2 e 3 (teclado/foco reais e screenshots).
   Sobe o preview de produção local (vite preview) e roda tudo em Chromium local,
   sem qualquer dependência remota. */
export default defineConfig({
  testDir: ".",
  testMatch: ["e2e/**/*.spec.ts", "evidence/**/*.spec.ts"],
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:4319",
    trace: "off",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "npm run build && npm run preview -- --port 4319 --strictPort",
    url: "http://localhost:4319",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
