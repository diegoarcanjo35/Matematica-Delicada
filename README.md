# Matemática Delicada

Plataforma digital de preparação estratégica para Matemática no ENEM, com treino por
padrões recorrentes. Este repositório está na **Sprint 2 — Autenticação, contas e
sessões seguras**: cadastro, login, logout, sessão real (cookie `HttpOnly` + D1),
confirmação de e-mail, recuperação de senha, e proteção real das rotas do aluno.
Conteúdo pedagógico (diagnóstico, treino real, banco de questões) ainda não existe —
o dashboard do aluno continua com dados de demonstração, agora dentro de uma área
autenticada de verdade.

Fonte de verdade de produto e pedagogia: [`Documento_Mestre_Plataforma_Matematica_Delicada_v1.0.md`](./Documento_Mestre_Plataforma_Matematica_Delicada_v1.0.md).
Arquitetura: [`docs/ARQUITETURA.md`](./docs/ARQUITETURA.md).
Autenticação e segurança: [`docs/AUTENTICACAO.md`](./docs/AUTENTICACAO.md).
Sistema visual: [`docs/SISTEMA_VISUAL.md`](./docs/SISTEMA_VISUAL.md).
Padrões ENEM (taxonomia, gate local e os três índices): [`docs/PADROES_ENEM.md`](./docs/PADROES_ENEM.md).

## Requisitos

- Node.js 20+ (testado com v24.15.0)
- npm 10+ (testado com 11.12.1)
- Os testes E2E (teclado, foco, screenshots, fluxos de autenticação) usam
  [Playwright](https://playwright.dev/) com Chromium local — não depende de conta,
  serviço ou navegador remoto.

## Instalação

Para instalação reproduzível (recomendado, inclusive no Windows — não exige conta nem
serviço remoto):

```bash
npm ci
npx playwright install chromium
```

Alternativa para desenvolvimento do dia a dia:

```bash
npm install
```

## Execução local

A aplicação agora tem uma API real (Cloudflare Worker + D1), então a forma completa de
rodar localmente é via Worker, não só `vite dev`:

```bash
npm run worker:preview
```

Builda o frontend, aplica as migrations no D1 local e sobe o Worker (API + assets) em
`http://localhost:8793`. Veja a seção "Worker + Assets + D1 local" abaixo para os
detalhes de cada etapa.

Para trabalhar só na interface, sem a API (as telas de autenticação não vão funcionar
sem o Worker rodando em paralelo):

```bash
npm run dev
```

Abre em `http://localhost:5173` (ou a próxima porta livre).

## Lint

```bash
npm run lint
```

Cobre `src/` (frontend) e `worker/` (API).

## Verificação de tipos

```bash
npx tsc -b                       # frontend
npm run worker:check             # API do Worker (tsconfig separado)
```

## Testes

```bash
npm test              # testes unitários (Vitest + Testing Library), roda uma vez
npm run test:watch    # testes unitários em modo observação
npm run test:e2e      # teclado, foco, console, autenticação e segurança, em Chromium real
npm run screenshots   # regenera só as evidências visuais em evidence/screenshots/
```

- `npm test`: testes de componente (`src/**/*.test.tsx`) — rápidos, sem navegador real.
- `npm run test:e2e`: builda, aplica migrations, sobe o Worker local e roda toda a
  suíte Playwright (`e2e/` e `evidence/`) em Chromium — navegação por teclado, foco
  visível, ausência de erros no console, fluxos completos de cadastro/login/recuperação
  de senha, segurança da API (Origin, JSON malformado, rate limit) e evidências visuais.
- `npm run screenshots`: atalho para rodar só `evidence/screenshots.spec.ts`.

## Build de produção

```bash
npm run build
```

Gera a pasta `dist/`. Para pré-visualizar só o build estático (sem API): `npm run preview`.

## Worker + Assets + D1 local

```bash
npm run worker:preview
```

Esse comando builda a aplicação, aplica as migrations no D1 local e sobe um Cloudflare
Worker completo (API + assets estáticos) **100% local**, na porta 8793. Ele:

- serve a SPA com fallback de rota (`not_found_handling: "single-page-application"`);
- expõe a API de autenticação em `/api/auth/*` (ver `docs/AUTENTICACAO.md` para o
  contrato de cada endpoint);
- roda o D1 inteiramente local (SQLite em `.wrangler/state`);
- não exige login na Cloudflare, não executa deploy, não acessa nenhuma conta Cloudflare.

### Duas configurações do Wrangler — nunca confundir

| Arquivo | Para que serve | Pode ser usado para deploy? |
|---|---|---|
| **`wrangler.local.jsonc`** | Único usado pelos scripts locais acima (`-c wrangler.local.jsonc`) | **Não** — `database_id` é uma string claramente local, nunca um ID real |
| **`wrangler.jsonc`** | O que `wrangler deploy` usaria | Só depois que Diego criar o D1 remoto e preencher o `database_id` real, com autorização do PO |

`wrangler.jsonc` tem `database_id: ""` de propósito — vazio, não um valor
inventado. `npm run deploy` está bloqueado por construção: o script
`"predeploy"` (mecanismo nativo do npm, roda sozinho antes de `"deploy"`)
executa `npm run check:deploy-config`, que falha se o `database_id`
implantável estiver vazio, zerado ou parecer um placeholder. Detalhes em
`docs/AUTENTICACAO.md`.

Comandos relacionados:

```bash
npm run db:migrate:local        # aplica migrations/*.sql no D1 local
npm run worker:dev              # só sobe o worker (exige dist/ e D1 já preparados)
npm run check:deploy-config     # roda manualmente a verificação de database_id real
npm run bench:pbkdf2            # benchmark local do hash de senha
```

Para inspecionar o banco local diretamente (note o `-c wrangler.local.jsonc`):

```bash
npx wrangler d1 execute matematica-delicada-local --local -c wrangler.local.jsonc --command "SELECT * FROM users"
```

## Estrutura do projeto

```
src/
  design/       tokens.css (paleta, tipografia, espaçamento) e fonts.css
  components/   Button, Card, Badge, ProgressBar, FormField, Alert,
                EmptyState, LoadingState, ErrorState, Header, Sidebar,
                MobileNav, PageTitle, Modal, Tooltip
  layouts/      StudentLayout (shell do aluno: sidebar + header + navegação móvel)
  pages/        DashboardPage (mock), PlaceholderPage, NotFoundPage
  pages/auth/   LoginPage, RegisterPage, ForgotPasswordPage, ResetPasswordPage,
                ConfirmEmailPage, RegisterConfirmationPage
  auth/         AuthContext, useAuth, ProtectedRoute, PublicOnlyRoute
  api/          authClient.ts — único ponto de fetch para a API
  mocks/        dashboardMock.ts — dados de demonstração, isolados da UI
  routes/       studentNav.ts — fonte única do menu do aluno
  test/         setup.ts (Vitest + Testing Library)
worker/         API real (Cloudflare Worker) — ver docs/ARQUITETURA.md
  scripts/      benchmark-pbkdf2.mjs — benchmark local do hash de senha
migrations/     SQL versionado do D1 (0001_init.sql, 0002_rate_limit_counters.sql)
scripts/        check-deployable-d1-config.mjs — gate de deploy (ver acima)
e2e/            testes Playwright (teclado/foco, autenticação, segurança de API)
evidence/       screenshots.spec.ts + evidence/screenshots/*.png — evidências visuais
playwright.config.ts   configuração do Playwright (webServer = worker local)
wrangler.jsonc          configuração IMPLANTÁVEL (database_id vazio de propósito)
wrangler.local.jsonc    configuração EXCLUSIVAMENTE LOCAL — nunca usada para deploy
```

## Rotas disponíveis

| Rota | Página | Acesso |
|---|---|---|
| `/entrar` | Login | público (redireciona se já autenticado) |
| `/criar-conta` | Cadastro | público (redireciona se já autenticado) |
| `/cadastro-confirmado` | Confirmação de cadastro criado | público |
| `/esqueci-minha-senha` | Solicitar redefinição de senha | público (redireciona se já autenticado) |
| `/redefinir-senha?token=...` | Redefinir senha | público |
| `/confirmar-email?token=...` | Confirmar e-mail | público |
| `/termos`, `/privacidade` | Placeholder (conteúdo jurídico pendente) | público |
| `/` | Dashboard do aluno (dados mock) | **exige sessão** |
| `/padroes-enem` | Catálogo de padrões ENEM (Sprint 6 — ver `docs/PADROES_ENEM.md`) | **exige sessão** |
| `/padroes-enem/:slug` | Ficha técnica de um padrão | **exige sessão** |
| `/treino-diario`, `/reconheca-o-padrao`, `/banco-de-questoes`, `/simulados`, `/caderno-de-erros`, `/desempenho`, `/aulas-e-estrategias`, `/conquistas` | Placeholder | **exige sessão** |
| `/configuracoes`, `/ajuda`, `/assinatura` | Placeholder | **exige sessão** |
| qualquer outra rota | Página 404 | público |

Visitante sem sessão que tenta acessar uma rota protegida é redirecionado para
`/entrar` e volta automaticamente para a rota pretendida após o login. **Esse
redirecionamento é só uma conveniência de navegação da SPA, não a proteção
real** — a proteção de fato é a validação de sessão dentro do Worker em cada
endpoint privado da API. Ver "Fronteira de proteção" em `docs/AUTENTICACAO.md`.

## Limitações desta sprint

- Dashboard continua com dados de demonstração (`src/mocks/dashboardMock.ts`) — só a
  identidade e a sessão do aluno são reais agora.
- Sem 2FA, sem login social, sem verificação de força de senha além do comprimento.
- Rate limit local usa um identificador compartilhado em ambiente de desenvolvimento
  (ver limitação documentada em `docs/AUTENTICACAO.md`).
- Sem provedor real de e-mail — links de confirmação/recuperação ficam numa caixa de
  saída local (`dev_email_outbox`, banco D1), usada pelos testes automatizados.
- Conformidade com WCAG não foi auditada por ferramenta automatizada de acessibilidade;
  os critérios mínimos foram verificados manualmente e via Playwright.

## Operações remotas

Commit e push das branches `sprint-01-fundacao` e `main` **já ocorreram** na Sprint 1,
mediante autorização literal do PO.

Commit e push da Sprint 2 **também já ocorreram**, mediante autorização literal do PO,
exclusivamente na branch remota `sprint-02-autenticacao`:

- a v1.2 foi publicada no commit `2d4c412262f13ffcc329d749acdae59e786701e3`;
- a correção v1.3 de atomicidade das operações de token foi aprovada pelo PO e está
  incluída no HEAD atual da branch `sprint-02-autenticacao`;
- commit e push da v1.3 foram autorizados.

Continuam proibidos, até nova autorização explícita:

- merge na `main`;
- pull request;
- rebase;
- release ou tag;
- deploy;
- criação, acesso ou migração de D1 remoto;
- alteração de binding, variável ou segredo remoto;
- MCP da Cloudflare, `wrangler login`, `wrangler deploy` ou qualquer criação/alteração
  de recurso remoto (Worker, D1, KV, R2).

Toda ação remota na Cloudflare é feita manualmente por Diego.
