import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const rootDir = import.meta.dirname;

/* Playwright — a partir da Sprint 2, roda contra o Worker local (API + assets),
   não mais o vite preview puro, já que a área do aluno agora exige sessão real.
   Tudo 100% local: build + wrangler dev (D1 e Worker local), Chromium local. */
export default defineConfig({
  testDir: ".",
  testMatch: ["e2e/**/*.spec.ts", "evidence/**/*.spec.ts"],
  fullyParallel: false,
  // Serial entre arquivos também: todos compartilham o mesmo D1 local e o mesmo
  // identificador de rate limit ("local-dev") nesta sessão, então rodar arquivos
  // em paralelo causaria colisões espúrias de limite entre testes independentes.
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: "http://localhost:8788",
    trace: "off",
    storageState: path.join(rootDir, "e2e", ".auth", "user.json"),
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "npm run worker:preview",
    url: "http://localhost:8788/api/health",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
