# Arquitetura — Sprint 2 v1.0

Este documento registra a arquitetura **efetivamente implementada**, não um plano
teórico. Atualizado na Sprint 2 com a API real no Worker e o D1 local. Histórico das
versões anteriores (Sprint 1) preservado abaixo, no que ainda se aplica.

## Tecnologias

| Camada | Escolha | Motivo |
|---|---|---|
| Linguagem | TypeScript (strict, dois tsconfigs — app e worker) | Tipagem exigida pela especificação |
| Build/dev server (frontend) | Vite 8 | Padrão moderno, HMR rápido |
| Runtime da API | Cloudflare Workers (`worker/src/index.ts`) | Arquitetura obrigatória da Sprint 2 |
| Banco | Cloudflare D1 (SQLite), local nesta sprint | Arquitetura obrigatória da Sprint 2 |
| UI | React 19 | — |
| Roteamento | react-router-dom 7 (`BrowserRouter`) | Navegação real + proteção de rota |
| Estilo | CSS puro por componente + tokens centrais em `src/design/tokens.css` | Tokens centralizados, sem valores soltos |
| Criptografia | Web Crypto (`SubtleCrypto`), nativa do runtime Workers | Sem biblioteca própria de criptografia |
| Testes unitários | Vitest + Testing Library + jsdom | Componentes React isolados |
| Testes E2E | Playwright + Chromium local | UI real + API real, sem mocks |
| Lint | ESLint (TypeScript + React Hooks) | Cobre `src/` e `worker/` |

Nenhuma biblioteca de componentes de terceiros foi usada. Nenhum ORM foi adicionado —
o acesso ao D1 usa SQL parametrizado direto (`D1Database.prepare().bind()`), suficiente
para o volume de queries desta sprint.

## Estrutura de diretórios

```
src/                          frontend (React) — inalterado em sua organização desde a Sprint 1
  design/                     tokens.css, fonts.css
  components/                 componentes fundamentais reutilizáveis
  layouts/                    StudentLayout
  pages/                      DashboardPage, PlaceholderPage, NotFoundPage
  pages/auth/                 NOVO — Login, Register, ForgotPassword, ResetPassword, ConfirmEmail
  auth/                       NOVO — AuthContext, useAuth, ProtectedRoute, PublicOnlyRoute
  api/                        NOVO — authClient.ts (único ponto de fetch para a API)
  mocks/                      dados de demonstração do dashboard (ainda mock, dentro da área autenticada)
  routes/                     studentNav.ts
  test/                       setup do Vitest

worker/                       NOVO — API real, roda como Cloudflare Worker
  src/
    index.ts                  fetch handler raiz: roteia /api/*, senão delega a ASSETS
    env.ts                    tipos do binding (DB, ASSETS, ENVIRONMENT)
    routes/                   auth.ts (todos os endpoints), dev.ts (outbox local/teste)
    services/                 authService.ts — regras de negócio, não conhece SQL nem HTTP
    repositories/             acesso a dados — só SQL parametrizado
    lib/                      crypto.ts, cookies.ts, rateLimit.ts, origin.ts, response.ts, validation.ts
    email/                    adapter.ts (interface) + devOutboxAdapter.ts (dev/no-provider)
  tsconfig.json                separado do app: lib ES2022, tipos @cloudflare/workers-types

migrations/                    NOVO — SQL versionado do D1 (0001_init.sql)
e2e/                            testes Playwright (teclado/foco, fluxos de auth, segurança de API)
evidence/                       screenshots.spec.ts + evidence/screenshots/*.png
docs/                           esta pasta
wrangler.jsonc                  config local de Worker + Assets + D1 (sem credenciais)
```

### Separação interface / domínio / dados / infraestrutura

- **Interface** (`src/components`, `src/pages`, `src/pages/auth`): não sabe como a
  sessão é validada nem como senha é armazenada — só chama `src/api/authClient.ts`.
- **Cliente de API** (`src/api/authClient.ts`): único lugar do frontend que faz
  `fetch`. Não lê nem escreve cookies diretamente (o navegador cuida disso via
  `credentials: "include"` + cookie `HttpOnly`).
- **Rotas HTTP** (`worker/src/routes/`): parseiam request, validam entrada, chamam
  serviços, montam resposta. Não têm SQL nem lógica de negócio.
- **Serviços** (`worker/src/services/authService.ts`): regras de negócio (o que
  significa "cadastrar", "logar", "confirmar e-mail"). Não sabem HTTP.
- **Repositórios** (`worker/src/repositories/`): única camada que fala SQL com o D1.
- **Criptografia/tokens** (`worker/src/lib/crypto.ts`): isolada, reutilizada por
  serviços diferentes (hash de senha, tokens de sessão, tokens de e-mail).
- Componentes React **nunca** consultam o D1 diretamente — essa é uma regra reforçada
  por construção (o binding `DB` só existe no ambiente do Worker, inacessível ao
  bundle do navegador).

## Cloudflare Worker + Assets + D1 (implementado, só local)

`wrangler.jsonc`:

```jsonc
{
  "name": "matematica-delicada",
  "compatibility_date": "2025-01-01",
  "main": "worker/src/index.ts",
  "assets": { "directory": "./dist", "not_found_handling": "single-page-application", "binding": "ASSETS" },
  "d1_databases": [{ "binding": "DB", "database_name": "matematica-delicada-local", "database_id": "00000000-...-000000000000", "migrations_dir": "migrations" }]
}
```

- `database_id` é um **placeholder de 36 zeros** — `wrangler dev` roda o D1 inteiramente
  local (SQLite em `.wrangler/state`), sem validar esse valor contra a Cloudflare. Antes
  de qualquer deploy futuro, Diego substitui pelo `database_id` real do banco que ele
  criar manualmente.
- Sem `account_id`, sem credenciais, sem login, sem deploy.
- Scripts: `npm run db:migrate:local` (aplica migrations no D1 local), `npm run
  worker:dev` (`wrangler dev` puro), `npm run worker:preview` (build + migrate + dev).

## Limites desta sprint

- Sem 2FA, sem login social.
- D1 e Worker validados apenas localmente — nenhum deploy, nenhum recurso remoto.
- Rate limit local tem identificador único compartilhado (ver `docs/AUTENTICACAO.md`,
  limitação documentada e testada).
- Dashboard continua com dados mock (fora de escopo desta sprint) — só a
  identidade/sessão do aluno é real agora.
- Sem CI configurado.

## Decisões adiadas

- Onde a persistência de dados pedagógicos (padrões, questões etc.) vai morar —
  provavelmente novas tabelas D1 e novos repositórios, decisão de sprint futura.
- Gerenciamento de estado global além do `AuthContext` — ainda não há necessidade real.
- Provedor real de e-mail — ver `docs/AUTENTICACAO.md`, adaptador já isola essa decisão.
- Rotação/renovação automática de sessão antes da expiração — não implementada.
