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

## Instalação

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
npm test          # roda uma vez
npm run test:watch # modo observação
```

## Build de produção

```bash
npm run build
```

Gera a pasta `dist/`. Para pré-visualizar o build: `npm run preview`.

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

## Operações remotas — proibidas nesta sprint

Este repositório **não** deve receber commit, push, merge ou deploy nesta sprint —
essas ações aguardam autorização literal do PO (`AUTORIZADO COMMIT` / `AUTORIZADO PUSH`).
Também **não** deve ser usado o MCP da Cloudflare, `wrangler login`, `wrangler deploy` ou
qualquer criação/alteração de recurso remoto (Worker, D1, KV, R2). Toda ação na Cloudflare
é feita manualmente por Diego.
