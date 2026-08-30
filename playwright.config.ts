import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const rootDir = import.meta.dirname;

/* Playwright — a partir da Sprint 2, roda contra o Worker local (API + assets),
   não mais o vite preview puro, já que a área do aluno agora exige sessão real.
   Tudo 100% local: build + wrangler dev (D1 e Worker local), Chromium local.

   Sprint 4 v1.0 — porta movida de 8788 para 8793: nesta máquina, outro
   projeto (Sofia-Mariah-Joias) mantém `wrangler pages dev` na 8788/8799
   durante o dia a dia, e a colisão de porta causava tanto falha de startup
   quanto flakiness intermitente por contenção de recursos entre os dois
   servidores. 8793 não é usada por nenhum projeto conhecido nesta máquina. */
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
  // Margem extra sobre o padrão do Playwright (30s de teste, 5s de asserção)
  // para a suíte completa em máquina local — não afrouxa nenhuma asserção,
  // só dá tempo real de execução sob a carga acumulada de dezenas de contas
  // e requisições no mesmo D1 local ao longo da suíte inteira.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: "http://localhost:8793",
    trace: "off",
    storageState: path.join(rootDir, "e2e", ".auth", "user.json"),
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  // Sprint 4 v1.0 precisa de um segundo `wrangler dev` (porta 8790, sem
  // ENABLE_LOCAL_DIAGNOSTIC_FIXTURES) para provar o gate de indisponibilidade,
  // mas só e2e/diagnostic-unavailable-gate.spec.ts o usa. Mantê-lo aqui faria
  // os dois servidores rodarem em paralelo pela suíte inteira, dobrando a
  // carga de CPU da máquina local pela duração toda e causando flakiness por
  // timeout em testes sem nenhuma relação com o diagnóstico. Por isso esse
  // spec sobe/derruba seu próprio servidor em test.beforeAll/afterAll — aqui
  // fica só o servidor principal, do qual todo o resto da suíte depende.
  webServer: {
    command: "npm run worker:preview",
    url: "http://localhost:8793/api/health",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
