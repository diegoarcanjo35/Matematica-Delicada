# Matemática Delicada

Plataforma digital de preparação estratégica para Matemática no ENEM, com treino por
padrões recorrentes. Este repositório está na **Sprint 1 — Fundação técnica e visual**:
estrutura, sistema visual, navegação e páginas-placeholder. Nenhuma funcionalidade
pedagógica real (diagnóstico, treino real, autenticação, banco de dados) existe ainda.

Fonte de verdade de produto e pedagogia: [`Documento_Mestre_Plataforma_Matematica_Delicada_v1.0.md`](./Documento_Mestre_Plataforma_Matematica_Delicada_v1.0.md).
Arquitetura desta sprint: [`docs/ARQUITETURA.md`](./docs/ARQUITETURA.md).
Sistema visual: [`docs/SISTEMA_VISUAL.md`](./docs/SISTEMA_VISUAL.md).

## Requisitos

- Node.js 20+ (testado com v24.15.0)
- npm 10+ (testado com 11.12.1)
- Os testes E2E (teclado, foco, screenshots) usam [Playwright](https://playwright.dev/)
  com Chromium local — não depende de conta, serviço ou navegador remoto.

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

```bash
npm run dev
```

Abre em `http://localhost:5173` (ou a próxima porta livre).

## Lint

```bash
npm run lint
```

## Verificação de tipos

```bash
npx tsc -b
```

## Testes

```bash
npm test              # testes unitários (Vitest + Testing Library), roda uma vez
npm run test:watch    # testes unitários em modo observação
npm run test:e2e      # teclado, foco, console e evidências, em Chromium real (Playwright)
npm run screenshots   # regenera só as evidências visuais em evidence/screenshots/
```

- `npm test`: testes de componente (`src/**/*.test.tsx`) — rápidos, sem navegador real.
- `npm run test:e2e`: sobe um build de produção local e roda toda a suíte Playwright
  (`e2e/` e `evidence/`) em Chromium — navegação por teclado, foco visível, ausência de
  erros no console e geração das evidências visuais.
- `npm run screenshots`: atalho para rodar só `evidence/screenshots.spec.ts`.

## Build de produção

```bash
npm run build
```

Gera a pasta `dist/`. Para pré-visualizar o build: `npm run preview`.

## Worker + Assets local

```bash
npm run worker:preview
```

Esse comando builda a aplicação e sobe um Cloudflare Worker com Static Assets **100%
local**, na porta 8788 (via `wrangler dev`, configurado em `wrangler.jsonc`). Ele:

- gera o build de produção antes de subir o worker;
- serve a SPA com fallback de rota (`not_found_handling: "single-page-application"`),
  então rotas internas acessadas diretamente (`/treino-diario`, por exemplo) funcionam;
- não exige login na Cloudflare;
- não executa deploy;
- não acessa nenhuma conta Cloudflare;
- não cria nem usa D1 — `wrangler.jsonc` não tem `account_id`, credenciais ou bindings.

## Estrutura do projeto

```
src/
  design/       tokens.css (paleta, tipografia, espaçamento) e fonts.css
  components/   Button, Card, Badge, ProgressBar, FormField, Alert,
                EmptyState, LoadingState, ErrorState, Header, Sidebar,
                MobileNav, PageTitle, Modal, Tooltip
  layouts/      StudentLayout (shell do aluno: sidebar + header + navegação móvel)
  pages/        DashboardPage (mock), PlaceholderPage, NotFoundPage
  mocks/        dashboardMock.ts — dados de demonstração, isolados da UI
  routes/       studentNav.ts — fonte única do menu do aluno
  test/         setup.ts (Vitest + Testing Library)
e2e/            testes Playwright de teclado, foco e console (Chromium real)
evidence/       screenshots.spec.ts + evidence/screenshots/*.png — evidências visuais
playwright.config.ts   configuração do Playwright (webServer local, sem dependência remota)
wrangler.jsonc          configuração local de Cloudflare Workers Static Assets
```

## Rotas disponíveis

Todas as rotas abaixo estão dentro do shell do aluno (`StudentLayout`), exceto a rota
de erro 404.

| Rota | Página |
|---|---|
| `/` | Dashboard do aluno (dados mock) |
| `/treino-diario` | Placeholder |
| `/padroes-enem` | Placeholder |
| `/reconheca-o-padrao` | Placeholder |
| `/banco-de-questoes` | Placeholder |
| `/simulados` | Placeholder |
| `/caderno-de-erros` | Placeholder |
| `/desempenho` | Placeholder |
| `/aulas-e-estrategias` | Placeholder |
| `/conquistas` | Placeholder |
| `/configuracoes`, `/ajuda`, `/assinatura` | Placeholder (itens complementares) |
| qualquer outra rota | Página 404 |

## Limitações desta sprint

- Não há autenticação real — o botão "Sair" é decorativo e desabilitado.
- Não há dados reais de aluno — tudo no dashboard vem de `src/mocks/dashboardMock.ts`,
  claramente sinalizado na própria tela.
- Não há banco de dados, API real, pagamentos ou integrações.
- Conformidade com WCAG não foi auditada por ferramenta automatizada de acessibilidade;
  os critérios mínimos da seção 10 da especificação foram verificados manualmente.

## Operações remotas

Commit e push da branch `sprint-01-fundacao` **já ocorreram**, mediante autorização
literal do PO (`AUTORIZADO COMMIT` / `AUTORIZADO PUSH`) — a branch está publicada em
`origin/sprint-01-fundacao`.

Continuam proibidos, até nova autorização explícita:

- merge na `main`;
- release ou tag;
- deploy;
- MCP da Cloudflare, `wrangler login`, `wrangler deploy` ou qualquer criação/alteração
  de recurso remoto (Worker, D1, KV, R2).

Toda ação remota na Cloudflare é feita manualmente por Diego.
