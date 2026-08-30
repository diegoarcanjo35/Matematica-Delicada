# Template de importação de questões — v1

Este diretório guarda o template CSV versionado usado pela importação em lote
do Banco de Questões (Sprint 7). O mesmo conjunto de colunas também é gerado
dinamicamente por `GET /api/editorial/question-imports/template`
(`worker/src/routes/editorialImports.ts:buildTemplateCsv`) — os dois são
mantidos em sincronia manualmente; qualquer alteração de coluna precisa ser
replicada nos dois lugares e em
`worker/src/services/questionImportService.ts:IMPORT_CSV_HEADERS`.

## Como usar

1. Baixe `questoes-importacao-v1.csv` (ou use o botão "Baixar template" em
   `/editorial/importacoes`).
2. Preencha uma linha por questão, mantendo o cabeçalho exatamente como está.
3. Envie o arquivo em **Pré-visualizar** antes de aplicar — a prévia nunca
   cria questão, só valida.
4. Corrija todos os erros reportados por linha/campo antes de aplicar: um
   lote com qualquer erro pendente não pode ser aplicado.
5. **Aplicar** cria todas as questões válidas como `draft`, atomicamente.

## Colunas

| Coluna | Obrigatória | Descrição |
| --- | --- | --- |
| `codigo` | sim | Código editorial único (letras/dígitos/hífen/underscore, até 40 caracteres). |
| `enunciado` | sim | Texto do enunciado (texto puro — nunca HTML). |
| `resolucao_comentada` | não | Resolução comentada em texto puro. |
| `conteudo` / `subconteudo` | não | Classificação de conteúdo matemático. |
| `habilidade` / `competencia` | não | Habilidade/competência trabalhada. |
| `dificuldade` | sim | `facil`, `media` ou `dificil`. |
| `origem` | sim | `oficial`, `autoral`, `licenciada`, `diagnostico`, `reconhecimento` ou `revisao_base`. |
| `prova` / `ano` | não | Identificação da prova de origem (quando `origem = oficial`). |
| `tempo_estimado_segundos` | não | Inteiro positivo. |
| `tipo_calculo` | não (padrão `misto`) | `mental`, `escrito` ou `misto`. |
| `necessita_calculadora` | não | `sim` ou `nao`. |
| `alt_a` .. `alt_e` | sim | Texto de cada uma das 5 alternativas — nenhuma pode ficar vazia. |
| `correta` | sim | Letra (`A`-`E`) da alternativa correta — exatamente uma. |
| `pista`, `estrategia`, `pegadinha`, `conteudo_apoio`, `resolucao_dna`, `aprendizado_erro` | recomendado | Componentes do DNA da questão — exigidos completos antes de aprovação. |
| `atalho` | não | Atalho/macete opcional do DNA. |
| `padrao_principal_code` | sim | `code` de um padrão JÁ EXISTENTE (ex.: `PAD-01`) — a importação NUNCA cria padrão. |
| `padroes_secundarios_codes` | não | Códigos de padrões secundários, **separados por `;`** (nunca vírgula, para não colidir com o CSV). |
| `tags` | não | Tags separadas por `;`. |
| `titular_direitos` / `base_licenca` / `texto_atribuicao` | recomendado | Exigidos completos antes de publicação. |
| `imagem_ref` | não | Caminho de um asset local do repositório (`assets/questoes/...`) — nunca URL externa. |
| `imagem_alt` | obrigatório se houver `imagem_ref` | Texto alternativo da imagem. |

## Regras de segurança do arquivo

- Codificação: UTF-8 (com ou sem BOM).
- Tamanho máximo: 300KB. Linhas máximas: 500.
- Conteúdo matemático legítimo começando com `-`, `+`, `=` ou `@` (ex.:
  `-5`, `+3`, `= 2x + 4`, `@ representa uma variável`) é importado
  normalmente — a importação NUNCA rejeita uma linha só por causa do
  primeiro caractere de um campo pedagógico (Sprint 7 v1.1, Correção B).
  Essa proteção existe só do lado de EXPORTAÇÃO: se você baixar um
  relatório de erros como CSV, qualquer célula que comece por um desses
  caracteres é neutralizada com um apóstrofo (`'`) para abrir com segurança
  numa planilha — o conteúdo armazenado no banco nunca é alterado por isso.
- Código duplicado (no arquivo ou já existente no banco) e enunciado
  equivalente a outra questão (fingerprint duplicada, no arquivo ou no
  banco) são sempre rejeitados como erro de linha.
