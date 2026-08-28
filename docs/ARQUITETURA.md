# Arquitetura — Sprint 1 v1.1

Este documento registra a arquitetura **efetivamente implementada** na Sprint 1, não um
plano teórico. Escrito depois do código, conforme pedido do PO. Atualizado na v1.1 com a
configuração local de Worker + Assets (correção 1 da auditoria).

## Tecnologias

| Camada | Escolha | Motivo |
|---|---|---|
| Linguagem | TypeScript (strict) | Tipagem exigida pela especificação (seção 7) |
| Build/dev server | Vite 8 | Padrão moderno, HMR rápido, exigido pela seção 7 |
| UI | React 19 | Exigido pela seção 7 |
| Roteamento | react-router-dom 7 (`BrowserRouter`) | Navegação real entre rotas estruturais (seção 8.6) |
| Estilo | CSS puro por componente + tokens centrais em `src/design/tokens.css` | Especificação pede tokens centralizados, não valores soltos (seção 8.3) |
| Testes | Vitest + Testing Library + jsdom | Padrão nativo do ecossistema Vite, exigido pela seção 12 |
| Lint | ESLint (config gerada pelo `create-vite`, TypeScript + React Hooks) | Exigido pela seção 7 |

Nenhuma biblioteca de componentes de terceiros (Material UI, Chakra etc.) foi usada —
a especificação pede "fundação necessária", não uma biblioteca grande (seção 8.5).

## Estrutura de diretórios

```
src/
  design/     tokens.css, fonts.css — única fonte de cor/tipografia/espaçamento
  components/ componentes fundamentais reutilizáveis (seção 8.5)
  layouts/    StudentLayout — shell visual do aluno (seção 8.6)
  pages/      DashboardPage, PlaceholderPage, NotFoundPage
  mocks/      dados de demonstração, isolados da camada de UI (seção 8.7)
  routes/     studentNav.ts — fonte única do menu (usada por Sidebar, MobileNav e App)
  test/       setup do ambiente de testes
docs/         esta pasta — arquitetura e sistema visual
```

### Separação interface / domínio / dados / infraestrutura

Nesta sprint não existe domínio de negócio real nem infraestrutura de dados (sem API,
sem banco). A separação preparada é:

- **Interface**: `components/`, `layouts/`, `pages/` — não conhecem a origem dos dados.
- **Dados (mock)**: `mocks/dashboardMock.ts` — isolado, comentado como demonstrativo,
  com formato já pensado para ser trocado por uma chamada de API real sem alterar a UI.
- **Domínio e infraestrutura real**: não existem ainda. Quando a API for construída
  (sprint futura), o padrão esperado é um diretório `src/api/` ou `src/domain/` que
  produza dados no mesmo formato dos mocks atuais, para troca sem reescrever páginas.

## Preparação para Cloudflare Worker + Assets + D1

### Worker + Assets (implementado nesta versão, só localmente)

`wrangler.jsonc` na raiz do repositório configura a SPA como *Cloudflare Workers Static
Assets*:

```jsonc
{
  "name": "matematica-delicada",
  "compatibility_date": "2025-01-01",
  "assets": {
    "directory": "./dist",
    "not_found_handling": "single-page-application"
  }
}
```

- `not_found_handling: "single-page-application"` faz qualquer rota interna
  (`/treino-diario`, `/padroes-enem` etc.) cair de volta em `index.html`, preservando o
  roteamento do `react-router-dom` no lado do cliente.
- **Sem** `account_id`, sem credenciais, sem `database_id`, sem bindings de D1/KV/R2.
- `wrangler` (^4.127.0) é `devDependency`, usado apenas via `wrangler dev` local.
- Scripts adicionados: `npm run worker:dev` (sobe `wrangler dev` na porta 8788, exige
  `dist/` já buildado) e `npm run worker:preview` (builda e sobe em sequência).
- Nenhum `wrangler login` ou `wrangler deploy` foi executado — proibidos e não usados.

### D1 (documentação apenas — nenhum banco criado)

- Não existe banco D1 nem binding nesta sprint.
- Quando a persistência real for introduzida (sprint futura), o binding D1 será
  declarado em `wrangler.jsonc` sob a chave `d1_databases`, e o **banco em si será
  criado manualmente por Diego** na Cloudflare — este projeto não cria nem acessa
  nenhuma conta ou banco Cloudflare.
- A futura camada de acesso a dados ficará em `src/api/` (ou pacote equivalente,
  decisão de sprint futura — ver "Decisões adiadas"), acessível somente a partir do
  Worker (`fetch` handler), nunca diretamente do bundle do cliente. A interface
  (`src/components`, `src/pages`) permanece desacoplada: hoje ela lê de
  `src/mocks/dashboardMock.ts`, e passará a ler de um cliente de API com o mesmo
  formato de dados, sem exigir reescrita de componente.

## Limites desta sprint

- Sem autenticação real (o layout do aluno é puramente visual).
- Sem banco de dados (D1 ou qualquer outro) — apenas documentado, não criado.
- Sem API — toda a UI consome dados estáticos de `src/mocks/`.
- Worker + Assets validado apenas localmente (`wrangler dev`), sem deploy.
- Sem CI configurado (fora do escopo da Sprint 1).

## Decisões adiadas

- Onde a futura camada de API/domínio vai morar (`src/api/` vs. um pacote separado) —
  decisão que depende da sprint que introduzir o Worker.
- Gerenciamento de estado global (Context, Zustand, etc.) — não há necessidade real
  ainda, pois toda página é hoje independente e usa apenas dados mock locais.
- Estratégia de autenticação (sessão, JWT, etc.) — depende de decisão de produto ainda
  pendente no Documento Mestre (seção 45, "decisões pendentes").
