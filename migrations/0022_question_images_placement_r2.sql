-- Sprint 18 — Editor de questão simplificado + imagens no enunciado e
-- alternativas (seção 8/9/10 da ordem).
--
-- Estritamente ADITIVA: só `ALTER TABLE ... ADD COLUMN` (novas colunas,
-- todas com DEFAULT compatível com as linhas já existentes) e
-- `CREATE TRIGGER/INDEX IF NOT EXISTS`. Nenhuma migration 0001-0021 é
-- tocada; nenhuma tabela é removida/renomeada; nenhum CHECK/índice/trigger
-- pré-existente é alterado ou removido.
--
-- ============================================================================
-- 1) PLACEMENT — distinguir imagem do enunciado de imagem de alternativa
-- ============================================================================
--
-- `question_images` (migration 0008) hoje só tem `position` (ordenação
-- dentro da questão) — nenhuma coluna diz ONDE a imagem se encaixa. Duas
-- colunas novas resolvem isso:
--   `placement`          — 'enunciado' (default) ou 'alternativa'.
--   `alternative_letter` — NULL para 'enunciado'; 'A'-'E' quando
--                          `placement = 'alternativa'`.
--
-- DEFAULT 'enunciado' em `placement` e NULL (implícito, sem DEFAULT) em
-- `alternative_letter` significam que TODA imagem já existente (todas
-- gravadas antes desta sprint, sempre do enunciado — não havia UI nem
-- backend para anexar imagem a uma alternativa) permanece exatamente como
-- estava, sem nenhum UPDATE retroativo: "default das existentes =
-- enunciado" (ordem, seção 8) é satisfeito pelo próprio DEFAULT da coluna.
--
-- Verificado diretamente contra node:sqlite 3.51.3 (mesma checagem já feita
-- para migrations/0010 e 0021) antes de escrever esta migration:
-- `ALTER TABLE ... ADD COLUMN ... CHECK (<só a própria coluna>)` é aceito e
-- o CHECK é de fato aplicado. Um CHECK que cruzasse `placement` E
-- `alternative_letter` na mesma expressão de coluna NÃO foi tentado aqui —
-- ver nota extensa mais abaixo sobre por que essa coerência foi movida para
-- TRIGGERs (seção "COERÊNCIA placement/alternative_letter").
ALTER TABLE question_images ADD COLUMN placement TEXT NOT NULL DEFAULT 'enunciado' CHECK (placement IN ('enunciado', 'alternativa'));
ALTER TABLE question_images ADD COLUMN alternative_letter TEXT CHECK (alternative_letter IS NULL OR alternative_letter IN ('A', 'B', 'C', 'D', 'E'));

CREATE INDEX IF NOT EXISTS idx_question_images_placement ON question_images (question_id, placement, alternative_letter, position);

-- ============================================================================
-- 2) STORAGE — permitir R2 como storage novo, preservando assets locais
-- ============================================================================
--
-- `asset_ref` (migration 0008) hoje só aceita um caminho local de
-- repositório (`assets/questoes/...`, validado por ASSET_REF_RE em
-- worker/src/lib/questionsValidation.ts). Continua sendo a referência
-- INTERNA de toda imagem (ordem, seção 10 — "não salvar URL pública
-- arbitrária"), mas passa a poder representar TAMBÉM uma object key
-- controlada dentro do bucket R2 (`questions/<questionId>/<imageId>.<ext>`),
-- nunca uma URL http(s) nem um caminho com "..".
--
-- `storage_kind` diz qual dos dois regimes de validação/leitura se aplica a
-- `asset_ref` naquela linha: 'local' (comportamento antigo, senha por
-- ASSET_REF_RE, nunca lido de R2) ou 'r2' (novo, object key controlada,
-- lido do binding QUESTION_MEDIA). DEFAULT 'local' preserva toda imagem já
-- existente sem nenhuma migração de dado.
--
-- `mime_type`/`size_bytes` só são preenchidos por uploads novos via R2 (a
-- Content-Type real do arquivo, nunca a extensão/nome, e o tamanho em bytes
-- — usados por worker/src/routes/questionMedia.ts para responder o
-- Content-Type correto e para auditoria/limite de quota; nunca guardamos os
-- BYTES da imagem em si no D1, só este metadado). Ambas ficam NULL para
-- toda linha pré-existente (storage_kind='local') — o serviço nunca exige
-- estas colunas para uma imagem local antiga.
ALTER TABLE question_images ADD COLUMN storage_kind TEXT NOT NULL DEFAULT 'local' CHECK (storage_kind IN ('local', 'r2'));
ALTER TABLE question_images ADD COLUMN mime_type TEXT;
ALTER TABLE question_images ADD COLUMN size_bytes INTEGER;

-- ============================================================================
-- COERÊNCIA placement/alternative_letter — TRIGGER aditivo (seção 8 da ordem:
-- "validar coerência... no serviço e, se tecnicamente adequado, com
-- trigger/check aditivo")
-- ============================================================================
--
-- Por que TRIGGER e não CHECK: o CHECK que o SQLite aceita ao lado de um
-- `ADD COLUMN` só enxerga a própria coluna sendo adicionada de forma
-- confiável neste projeto (mesma disciplina de 0010/0021 — nunca "supor"
-- comportamento não verificado do motor). Uma regra que cruza DUAS colunas
-- (`placement` x `alternative_letter`) é exatamente o motivo de existir
-- `CREATE TRIGGER ... BEFORE INSERT/UPDATE ... RAISE(ABORT, ...)` no resto
-- do projeto (ver migrations/0009, 0010, 0011, 0012) — mesmo mecanismo,
-- reaproveitado aqui. A checagem do SERVIÇO (worker/src/lib/
-- questionsValidation.ts) continua sendo a primeira linha de defesa (erro
-- 400 controlado, nunca uma exceção crua); este trigger é a segunda camada,
-- no banco, para qualquer escrita que porventura a contornasse.
--
-- `BEFORE INSERT/UPDATE` (não AFTER): aborta ANTES de a linha inconsistente
-- chegar a existir mesmo momentaneamente dentro da transação — mais simples
-- e mais barato que checar depois.
CREATE TRIGGER IF NOT EXISTS trg_question_images_placement_coherence_insert
BEFORE INSERT ON question_images
FOR EACH ROW
WHEN (NEW.placement = 'alternativa' AND NEW.alternative_letter IS NULL)
  OR (NEW.placement = 'enunciado' AND NEW.alternative_letter IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'invariante violada: placement e alternative_letter incoerentes em question_images');
END;

CREATE TRIGGER IF NOT EXISTS trg_question_images_placement_coherence_update
BEFORE UPDATE ON question_images
FOR EACH ROW
WHEN (NEW.placement = 'alternativa' AND NEW.alternative_letter IS NULL)
  OR (NEW.placement = 'enunciado' AND NEW.alternative_letter IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'invariante violada: placement e alternative_letter incoerentes em question_images');
END;

-- ============================================================================
-- NÃO FEITO NESTA MIGRATION (documentado, não improvisado — ordem, seção 15)
-- ============================================================================
--
-- "Alternativa cujo conteúdo seja somente visual" (texto vazio + imagem)
-- exigiria afrouxar `CHECK (length(trim(text)) > 0)` em
-- `question_alternatives.text` (migrations/0008, linha ~98). SQLite NÃO
-- permite ALTER a um CHECK já existente — a única forma correta é o
-- procedimento de reconstrução de tabela (criar tabela nova com o CHECK
-- novo, copiar dados, dropar a antiga, renomear, recriar índices). Este
-- projeto nunca precisou desse procedimento até hoje (nenhuma migration
-- 0001-0021 o usa) e não há template testado aqui para reproduzi-lo com
-- segurança dentro do prazo desta sprint. Confirmado por grep: nenhuma FK
-- de qualquer outra tabela aponta para `question_alternatives.id` — a
-- reconstrução seria estruturalmente segura (sem referências penduradas a
-- corrigir), mas ainda assim arriscada o bastante (tabela usada por TODA
-- questão do banco, incluindo produção) para não ser improvisada dentro de
-- uma sprint já grande. O plano seguro (create-new/copy/drop/rename,
-- preservando `idx_question_alternatives_letter` UNIQUE e
-- `idx_question_alternatives_question`, e o FK para `questions(id)`) está
-- documentado no relatório final desta sprint para decisão e execução
-- isolada numa sprint futura dedicada, com sua própria bateria de testes.
--
-- Nesta sprint: uma alternativa SEMPRE continua exigindo texto não vazio
-- (nenhuma mudança de comportamento aqui); imagens podem ser anexadas a
-- QUALQUER alternativa (via placement='alternativa' acima) como
-- COMPLEMENTO ao texto, nunca como substituto.
