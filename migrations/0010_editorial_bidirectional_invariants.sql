-- Sprint 7 v1.4 — invariante BIDIRECIONAL núcleo<->histórico<->coleções,
-- imposto no BANCO, antes do commit.
--
-- migrations/0009 já garante uma direção: se `questions.version` muda, um
-- `question_history` correspondente PRECISA existir (trigger `AFTER UPDATE
-- ON questions`). A auditoria apontou o buraco na direção OPOSTA: se o
-- `UPDATE` central de `questions` afeta 0 linhas SILENCIOSAMENTE (seu guard
-- não bate, mas sem lançar exceção) enquanto o `INSERT` condicionado de
-- `question_history` RODOU com sucesso (seu próprio guard bateu, já que ele
-- roda ANTES do central, na mesma transação — ver v1.3), o trigger de 0009
-- NUNCA dispara: ele só reage a um UPDATE que de fato mudou uma linha. O
-- lote inteiro poderia commitar com um histórico órfão e coleções
-- substituídas, mas sem a mudança de versão correspondente.
--
-- SQLite só permite `RAISE(ABORT, ...)` DENTRO do corpo de um
-- `CREATE TRIGGER ... BEGIN ... END` — nunca como statement solto no lote
-- (verificado diretamente contra node:sqlite antes desta migration: uma
-- chamada bare a RAISE() fora de um trigger lança
-- "RAISE() may only be used within a trigger-program"). Como um `UPDATE`
-- que afeta 0 linhas nunca dispara SEU PRÓPRIO trigger `AFTER UPDATE`, a
-- checagem não pode viver ali.
--
-- Mecanismo: toda mutação (worker/src/services/questionService.ts —
-- updateQuestion/applyTransition) agora insere, como o ÚLTIMO statement do
-- lote, uma linha INCONDICIONAL (sem WHERE-guard algum — sempre insere
-- exatamente 1 linha) em `editorial_mutation_checks`, registrando o que
-- ESTA mutação esperava alcançar (questão, versão resultante e, quando
-- aplicável, a contagem esperada de cada coleção tocada). Por ser
-- incondicional, o `INSERT` nesta tabela SEMPRE dispara seu próprio trigger
-- `AFTER INSERT` — não importa o que qualquer statement condicionado
-- anterior no MESMO lote tenha feito ou deixado de fazer. Rodando por
-- ÚLTIMO na transação, o trigger enxerga o estado (ainda não commitado) de
-- TODAS as tabelas já modificadas pelos statements anteriores desta mesma
-- transação, e confere que "o núcleo está na versão esperada" e "existe um
-- question_history para esta questão NESTA versão" e "cada coleção tocada
-- tem a contagem esperada" sejam TODOS verdadeiros juntos, ou TODOS falsos
-- juntos — nunca uma combinação dividida. Uma divergência dispara
-- `RAISE(ABORT, ...)`, abortando a transação INTEIRA: nem o núcleo, nem o
-- histórico, nem as coleções, nem a própria linha-marcador desta tabela
-- sobrevivem — nenhum registro técnico residual.
--
-- Por que o histórico é conferido por `(question_id, expected_version)` e
-- NÃO por um `history_id` específico desta chamada: uma reenvio idempotente
-- legítimo (mesmo ator, mesma transição, `expectedVersion` que já foi
-- correta no passado mas ficou obsoleta porque a PRIMEIRA tentativa já
-- teve sucesso) faz o guard desta SEGUNDA chamada falhar de propósito (nada
-- deveria mudar de novo) — mas o núcleo JÁ ESTÁ na versão-alvo e um
-- `question_history` para essa versão JÁ EXISTE, só que gravado pela
-- PRIMEIRA chamada, com um id diferente do desta segunda tentativa. Cobrar
-- um `history_id` exato quebraria esse reenvio legítimo (abortaria uma
-- idempotência válida). Checar por versão, e não por id, é exatamente o
-- que `migrations/0009` já faz consigo mesma (`WHERE question_id = ? AND
-- version = ?`, nunca por id) — e continua detectando com precisão o furo
-- real: um `question_history` pré-existente NUNCA aparece "no lugar certo"
-- por acidente, porque o próprio guard `NOT EXISTS(question_id, version)`
-- de `buildConditionalHistoryStatement` já impede mais de um evento de
-- histórico por versão, para sempre.
--
-- Aditiva e não destrutiva quanto a CONTEÚDO e a TABELAS/TRIGGERS existentes
-- (nenhuma linha é apagada, nenhuma constraint pré-existente muda, nenhuma
-- tabela é removida ou renomeada). Nunca toca ou enfraquece o trigger de
-- 0009 (mantido tal como está). A Sprint 8 deve começar sua própria
-- migration em `0011` — nunca reaproveitar 0009/0010.
--
-- ATENÇÃO — verificado diretamente contra node:sqlite antes de escrever esta
-- migration: a versão do SQLite empacotada aqui NÃO aceita
-- `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` (erro de sintaxe). Por isso as 5
-- linhas `ALTER TABLE` abaixo, ao contrário de todo o resto desta migration,
-- NÃO são idempotentes por reaplicação manual direta (reaplicar via
-- `db.exec()` duas vezes falharia com "duplicate column name"). Isso NUNCA
-- acontece em uso real: o próprio `wrangler d1 migrations apply` (D1) e todo
-- o histórico deste projeto (0001-0009) já dependem de cada arquivo de
-- migration ser aplicado EXATAMENTE uma vez, rastreado pela tabela própria
-- de controle do Wrangler — nunca reexecutado manualmente em produção. Os
-- testes desta migration (worker/testing/migration0010.test.ts) verificam a
-- idempotência apenas das partes que genuinamente suportam
-- `IF NOT EXISTS` (tabela e trigger novos) e documentam esta exceção
-- explicitamente, em vez de fingir uma garantia que o SQLite não oferece.
--
-- Por que o `ALTER TABLE` é necessário: a checagem por CONTAGEM sozinha
-- (`COUNT(*) = N`) tem um furo — se uma coleção já tinha exatamente N linhas
-- ANTES desta mutação (por coincidência, ou porque o guard falhou e nada
-- mudou), uma contagem pós-falha pode COINCIDIR com a contagem esperada
-- pós-sucesso, gerando um falso positivo (aborto de uma tentativa que
-- deveria só receber 409, nunca uma exceção de banco não tratada). A coluna
-- `version_stamp`, gravada pelo mesmo INSERT/UPSERT guardado que já escreve
-- cada linha da coleção, com o mesmo valor que vai para
-- `editorial_mutation_checks.expected_version`, resolve isso do mesmo jeito
-- que `question_history.version` já resolve o caso do histórico: só conta
-- linhas efetivamente carimbadas com a versão-alvo desta mutação, nunca
-- linhas antigas remanescentes de uma versão anterior.
--
-- Caso especial — contagem esperada IGUAL A ZERO (coleção enviada vazia,
-- ex. `tags: []`, para limpar tudo): uma contagem "carimbada com a
-- versão-alvo" É SEMPRE ZERO neste caso, tenha o guard passado ou falhado
-- (não há linha nenhuma para carimbar quando a intenção é não inserir
-- nada) — logo o carimbo não ajuda a distinguir os dois casos aqui, ao
-- contrário do caso N>0. Por isso a checagem por contagem é PULADA quando
-- `*_expected_count = 0` (ver `> 0` nas condições abaixo); a garantia para
-- este caso vem de outro lugar, estrutural: o `DELETE` guardado
-- (`guardedDeleteSql`, questionRepository.ts) usa a MESMA condição de guard,
-- byte a byte, que o `UPDATE` central — logo, sempre que o núcleo muda,
-- o `DELETE` da coleção necessariamente também rodou (mesmo guard, mesma
-- transação, mesmo instante imutável), garantindo a coleção vazia; e
-- sempre que o núcleo NÃO muda, o `DELETE` também não roda, preservando o
-- que já havia. Essa garantia é estrutural (mesmo guard compartilhado),
-- não uma checagem em runtime — nunca dependeu do `version_stamp`.
ALTER TABLE question_alternatives ADD COLUMN version_stamp INTEGER;
ALTER TABLE question_dna ADD COLUMN version_stamp INTEGER;
ALTER TABLE question_patterns ADD COLUMN version_stamp INTEGER;
ALTER TABLE question_tags ADD COLUMN version_stamp INTEGER;
ALTER TABLE question_images ADD COLUMN version_stamp INTEGER;

CREATE TABLE IF NOT EXISTS editorial_mutation_checks (
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL,
  expected_version INTEGER NOT NULL,
  -- NULL = esta coleção não foi tocada por esta mutação (nada a conferir);
  -- um número = a contagem de linhas que a coleção DEVERIA ter, no exato
  -- momento desta checagem, se a mutação tiver realmente acontecido.
  alternatives_expected_count INTEGER,
  dna_expected_count INTEGER,
  patterns_expected_count INTEGER,
  tags_expected_count INTEGER,
  images_expected_count INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TRIGGER IF NOT EXISTS trg_editorial_mutation_checks_bidirectional
AFTER INSERT ON editorial_mutation_checks
FOR EACH ROW
BEGIN
  -- Núcleo <-> histórico: as duas coisas só podem ser verdadeiras juntas ou
  -- falsas juntas — nunca uma sem a outra, em NENHUMA das duas direções.
  -- Por (question_id, version) — nunca por um id específico desta chamada,
  -- ver nota extensa acima sobre reenvios idempotentes legítimos.
  SELECT CASE
    WHEN (
      EXISTS (SELECT 1 FROM questions WHERE id = NEW.question_id AND version = NEW.expected_version)
    ) != (
      EXISTS (SELECT 1 FROM question_history WHERE question_id = NEW.question_id AND version = NEW.expected_version)
    )
    THEN RAISE(ABORT, 'invariante violada: núcleo (questions.version) e question_history divergem para esta mutação')
  END;

  -- Núcleo <-> alternativas (só quando esta mutação tocou alternativas).
  -- Conta só linhas CARIMBADAS com a versão-alvo desta mutação
  -- (`version_stamp = NEW.expected_version`) — nunca uma contagem "crua",
  -- que poderia coincidir por acaso com o estado antigo remanescente de um
  -- guard que falhou (ver nota extensa acima sobre por que `version_stamp`
  -- existe).
  SELECT CASE
    WHEN NEW.alternatives_expected_count IS NOT NULL AND NEW.alternatives_expected_count > 0
     AND (
       (SELECT COUNT(*) FROM question_alternatives WHERE question_id = NEW.question_id AND version_stamp = NEW.expected_version) = NEW.alternatives_expected_count
     ) != (
       EXISTS (SELECT 1 FROM questions WHERE id = NEW.question_id AND version = NEW.expected_version)
     )
    THEN RAISE(ABORT, 'invariante violada: núcleo e question_alternatives divergem para esta mutação')
  END;

  -- Núcleo <-> DNA.
  SELECT CASE
    WHEN NEW.dna_expected_count IS NOT NULL AND NEW.dna_expected_count > 0
     AND (
       (SELECT COUNT(*) FROM question_dna WHERE question_id = NEW.question_id AND version_stamp = NEW.expected_version) = NEW.dna_expected_count
     ) != (
       EXISTS (SELECT 1 FROM questions WHERE id = NEW.question_id AND version = NEW.expected_version)
     )
    THEN RAISE(ABORT, 'invariante violada: núcleo e question_dna divergem para esta mutação')
  END;

  -- Núcleo <-> padrões.
  SELECT CASE
    WHEN NEW.patterns_expected_count IS NOT NULL AND NEW.patterns_expected_count > 0
     AND (
       (SELECT COUNT(*) FROM question_patterns WHERE question_id = NEW.question_id AND version_stamp = NEW.expected_version) = NEW.patterns_expected_count
     ) != (
       EXISTS (SELECT 1 FROM questions WHERE id = NEW.question_id AND version = NEW.expected_version)
     )
    THEN RAISE(ABORT, 'invariante violada: núcleo e question_patterns divergem para esta mutação')
  END;

  -- Núcleo <-> tags.
  SELECT CASE
    WHEN NEW.tags_expected_count IS NOT NULL AND NEW.tags_expected_count > 0
     AND (
       (SELECT COUNT(*) FROM question_tags WHERE question_id = NEW.question_id AND version_stamp = NEW.expected_version) = NEW.tags_expected_count
     ) != (
       EXISTS (SELECT 1 FROM questions WHERE id = NEW.question_id AND version = NEW.expected_version)
     )
    THEN RAISE(ABORT, 'invariante violada: núcleo e question_tags divergem para esta mutação')
  END;

  -- Núcleo <-> imagens.
  SELECT CASE
    WHEN NEW.images_expected_count IS NOT NULL AND NEW.images_expected_count > 0
     AND (
       (SELECT COUNT(*) FROM question_images WHERE question_id = NEW.question_id AND version_stamp = NEW.expected_version) = NEW.images_expected_count
     ) != (
       EXISTS (SELECT 1 FROM questions WHERE id = NEW.question_id AND version = NEW.expected_version)
     )
    THEN RAISE(ABORT, 'invariante violada: núcleo e question_images divergem para esta mutação')
  END;
END;
