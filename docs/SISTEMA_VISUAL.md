# Sistema Visual — Sprint 1 v1.0

Derivado do `Documento_Mestre_Plataforma_Matematica_Delicada_v1.0.md` (seção 20) e da
implementação aprovada nesta sprint. Nenhuma regra visual ou pedagógica adicional foi
inventada além do que está no Documento Mestre.

## Conceito

**Caderno Estratégico ENEM**: aproximadamente 80% interface profissional de desempenho,
20% caderno/lettering. Navy e branco sustentam a interface; rosa, amarelo, verde,
laranja e azul-claro aparecem como destaques pontuais — nunca como predominância.

## Paleta oficial

Todos os valores vivem em `src/design/tokens.css`, como variáveis CSS. Nenhum componente
usa um valor de cor hexadecimal solto.

| Token | Cor | Uso |
|---|---|---|
| `--color-navy-deep` | `#081C36` | Sidebar, textos principais, fundo da 404 |
| `--color-navy-medium` | `#102A4C` | Hover de botão primário, ícones |
| `--color-blue-action` | `#163F72` | Botão primário, links, foco |
| `--color-yellow-highlight` | `#F5B800` | Destaque de marca, favicon |
| `--color-orange-strategic` | `#F28C00` | Frase estratégica (tagline), avisos |
| `--color-white` | `#FFFFFF` | Superfícies, texto sobre navy |
| `--color-paper-light` | `#FFFDF8` | Reservado para áreas de "caderno" |
| `--color-surface-soft` | `#FAF8F3` | Fundo geral da página |
| `--color-pink-brand` | `#F3A7BB` | Avatar, aviso de mock |
| `--color-pink-support` | `#F9DDE5` | Fundo de aviso de mock, badge "revisão vencida" |
| `--color-green-highlight` | `#B7E97A` | Reservado para marca-texto |
| `--color-blue-support` | `#CFE9F4` | Badge "em evolução", hover de botão secundário |
| `--color-success` | `#4FAE77` | Badge "dominado", alerta de sucesso |
| `--color-error` | `#D95B65` | Badge de erro, alerta de erro, borda de campo inválido |
| `--color-text-secondary` | `#5F6670` | Texto secundário em toda a aplicação |

## Tipografia

| Token | Fontes | Uso |
|---|---|---|
| `--font-display` | Oswald → Bebas Neue → sans-serif | Títulos (h1–h4), números de destaque |
| `--font-body` | Inter → Manrope → DM Sans → sistema | Interface, texto corrido, botões, formulários |
| `--font-hand` | Caveat → Kalam → cursive | Apenas a frase "Foco hoje, vitória no ENEM" no dashboard |

Carregadas via Google Fonts (`src/design/fonts.css`) com fallback local declarado nas
variáveis acima — se o carregamento externo falhar, a interface cai para fontes de
sistema sem quebrar. A fonte manuscrita **não** é usada em texto longo, tabelas, botões
críticos, números ou formulários, conforme a restrição do Documento Mestre.

## Tokens de espaçamento, raio e sombra

Escala de 4px (`--space-1` a `--space-8`), raios (`--radius-sm/md/lg/full`) e sombras
(`--shadow-sm/md/lg`) — todos em `tokens.css`, usados por todos os componentes.

## Componentes fundamentais implementados

| Componente | Estados cobertos |
|---|---|
| `Button` (primary/secondary/text) | normal, hover, foco visível, desabilitado, carregando |
| `Card` | normal |
| `Badge` | 10 variações de status pedagógico (Documento Mestre, seção 5.4) + neutro/sucesso/erro |
| `ProgressBar` | valor 0–100, acessível via `role="progressbar"` |
| `FormField` | normal, com texto de ajuda, com erro (`aria-invalid`, `role="alert"`) |
| `Alert` | info, success, warning, error |
| `EmptyState` / `LoadingState` / `ErrorState` | vazio, carregando, erro |
| `Header` | ações de notificação, ajuda, perfil |
| `Sidebar` | link ativo, hover, foco, item desabilitado ("Sair") |
| `MobileNav` | ativo, drawer "Mais opções" |
| `PageTitle` | título + descrição + ação opcional |
| `Modal` | aberto/fechado, fecha com Escape, foco inicial no diálogo |
| `Tooltip` | mostra/esconde em hover e foco |

## Regras de acessibilidade aplicadas

- Todo estado de foco usa `:focus-visible` com contorno de 3px (`--color-focus-ring`),
  definido uma única vez em `index.css` e herdado por todos os componentes.
- Ícones puramente decorativos usam `aria-hidden="true"`.
- `ProgressBar` expõe `role="progressbar"` com `aria-valuenow/min/max` e rótulo.
- O gráfico "Evolução da Semana" tem alternativa textual completa em
  `.visually-hidden`, já que as barras são `aria-hidden`.
- Estados de erro usam `role="alert"`; estados de carregamento usam
  `role="status"` + `aria-live="polite"`.
- Link "Pular para o conteúdo" (`.skip-link`) no início do shell do aluno.
- `prefers-reduced-motion: reduce` reduz/neutraliza animações de spinner.
- Nenhuma informação depende só de cor: badges de estado sempre mostram o nome do
  estado em texto, não só uma cor.

## Restrições da identidade

- Navy e branco predominam; rosa nunca é a cor de fundo principal de uma tela inteira.
- Fonte manuscrita restrita a uma única frase de destaque no dashboard.
- Nenhum componente usa cor fora da paleta de `tokens.css`.
