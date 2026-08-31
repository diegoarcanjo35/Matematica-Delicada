-- Sprint 7 v1.5 — fecha o buraco de 0010 para coleções ESVAZIADAS
-- (`*_expected_count = 0`, ex. `tags: []`), imposto no BANCO, antes do
-- commit. NÃO toca `migrations/0009` nem `migrations/0010` — nenhuma linha
-- delas é editada, nenhum trigger delas é removido/substituído. As duas
-- migrations permanecem exatamente como estão, e seus triggers continuam
-- rodando normalmente (o trigger novo abaixo é um trigger INDEPENDENTE,
-- adicional, no mesmo evento/tabela — SQLite permite múltiplos triggers
-- para o mesmo `AFTER INSERT`, todos disparam).
--
-- Por que 0010 sozinha não bastava para o caso vazio: seu trigger confere
-- `COUNT(linhas com version_stamp = expected_version) = expected_count`,
-- mas quando `expected_count = 0` essa contagem é SEMPRE zero — tenha o
-- `DELETE` guardado da coleção realmente rodado (limpando de verdade) ou
-- silenciosamente afetado 0 linhas (guard não bateu, sem lançar exceção,
-- deixando linhas antigas para trás). Contar não distingue os dois casos
-- quando o alvo já É zero. A v1.4 original cobriu esse buraco só com um
-- argumento de código ("o DELETE e o UPDATE central usam o MESMO texto de
-- guard, byte a byte, então não podem divergir") — a auditoria rejeitou
-- isso como insuficiente: é uma garantia de convenção de código, não uma
-- garantia imposta pelo banco numa transação real.
--
-- Mecanismo — "recibo" de mutação por coleção
-- (`question_collection_mutation_receipts`): para CADA coleção presente
-- num PATCH (alternativas/dna/padrões/tags/imagens), o serviço
-- (worker/src/services/questionService.ts) agora grava, no MESMO lote, UM
-- INSERT A MAIS — o recibo — guardado pela EXATA MESMA condição do `DELETE`
-- daquela coleção (`collectionGuardCondition()`,
-- worker/src/repositories/questionRepository.ts — a mesma função é
-- reaproveitada pelos dois, nunca um texto duplicado "igual por
-- convenção"). O recibo só é gravado se o guard genuinamente bateu, não
-- importa quantas linhas sobraram na coleção depois (0 ou N) — ele prova
-- "o DELETE guardado desta coleção rodou de verdade", desacoplado de contar
-- linhas.
--
-- O trigger abaixo, independente do de 0010, dispara no MESMO evento (o
-- INSERT incondicional em `editorial_mutation_checks`, o único statement do
-- lote com disparo garantido) e confere, para cada coleção cujo
-- `*_expected_count` NÃO é NULL no marcador (ou seja, esta mutação tocou
-- aquela coleção, esvaziando-a ou substituindo-a por N itens): a EXISTÊNCIA
-- do recibo para exatamente `(question_id, collection, expected_version)`
-- deve COINCIDIR com "o núcleo está na versão esperada" — as duas
-- verdadeiras juntas ou as duas falsas juntas, nunca uma sem a outra
-- (mesmo padrão XNOR do próprio trigger de 0010, nunca uma implicação
-- unidirecional "tocou logo TEM que ter recibo"). Isto é deliberado: uma
-- implicação unidirecional reproduziria, para o recibo, o MESMO
-- falso-positivo que 0010 já corrigiu para a contagem — um PATCH legítimo
-- com `expectedVersion` desatualizada falha o guard de TODOS os statements
-- de forma consistente (nenhum recibo é gravado, mas o núcleo também não
-- muda), e isso é um 409 gracioso, não uma corrupção; só quando o núcleo
-- MUDA sem o recibo correspondente (ou vice-versa) é que algo real
-- divergiu. Cobre os casos N>0 e N=0 de forma uniforme — o trigger de 0010
-- continua rodando e válido como camada adicional para o caso N>0 (nenhum
-- problema em ter as duas).
--
-- Limpeza: para não deixar `editorial_mutation_checks` NEM
-- `question_collection_mutation_receipts` crescendo sem limite (nenhuma das
-- duas é um registro de auditoria/negócio — só uma prova técnica
-- instantânea), o serviço acrescenta, no MESMO `db.batch()`, statements de
-- `DELETE` para a própria linha-marcador e para cada recibo gravado nesta
-- chamada, IMEDIATAMENTE APÓS o INSERT incondicional do marcador. Como os
-- statements de um `db.batch()`/transação rodam em ORDEM, esses `DELETE`s
-- só são alcançados se TODOS os triggers (0010 e o novo, abaixo) já
-- passaram sem abortar — se algum tivesse abortado, a exceção já teria
-- interrompido a transação inteira antes de chegar a eles, e nada
-- (nem esta limpeza) seria commitado. Por isso a limpeza só roda no
-- caminho de SUCESSO, e sempre afeta exatamente 1 linha por `DELETE` (a
-- que acabou de ser inserida, incondicionalmente, momentos antes, na MESMA
-- transação).
--
-- Aditiva e não destrutiva: só `CREATE TABLE/INDEX/TRIGGER IF NOT EXISTS`.
-- Nenhuma linha de conteúdo é inserida por esta migration. A Sprint 8 deve
-- começar sua própria migration em `0012` — nunca reaproveitar ou renumerar
-- 0009/0010/0011.

CREATE TABLE IF NOT EXISTS question_collection_mutation_receipts (
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL,
  -- Nome literal da tabela de coleção (ex. 'question_tags') — mesma
  -- convenção de string usada nas mensagens de erro de 0010.
  collection TEXT NOT NULL,
  -- Versão RESULTANTE desta mutação (a mesma que
  -- editorial_mutation_checks.expected_version para a mesma chamada) —
  -- nunca a versão de guard/pré-mutação — para casar corretamente com o
  -- marcador da MESMA mutação.
  expected_version INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_question_collection_mutation_receipts_lookup
  ON question_collection_mutation_receipts (question_id, collection, expected_version);

CREATE TRIGGER IF NOT EXISTS trg_editorial_mutation_checks_collection_receipts
AFTER INSERT ON editorial_mutation_checks
FOR EACH ROW
BEGIN
  SELECT CASE
    WHEN NEW.alternatives_expected_count IS NOT NULL
     AND (
       EXISTS (
         SELECT 1 FROM question_collection_mutation_receipts
         WHERE question_id = NEW.question_id AND collection = 'question_alternatives' AND expected_version = NEW.expected_version
       )
     ) != (
       EXISTS (SELECT 1 FROM questions WHERE id = NEW.question_id AND version = NEW.expected_version)
     )
    THEN RAISE(ABORT, 'invariante violada: núcleo e recibo de question_alternatives divergem para esta mutação')
  END;

  SELECT CASE
    WHEN NEW.dna_expected_count IS NOT NULL
     AND (
       EXISTS (
         SELECT 1 FROM question_collection_mutation_receipts
         WHERE question_id = NEW.question_id AND collection = 'question_dna' AND expected_version = NEW.expected_version
       )
     ) != (
       EXISTS (SELECT 1 FROM questions WHERE id = NEW.question_id AND version = NEW.expected_version)
     )
    THEN RAISE(ABORT, 'invariante violada: núcleo e recibo de question_dna divergem para esta mutação')
  END;

  SELECT CASE
    WHEN NEW.patterns_expected_count IS NOT NULL
     AND (
       EXISTS (
         SELECT 1 FROM question_collection_mutation_receipts
         WHERE question_id = NEW.question_id AND collection = 'question_patterns' AND expected_version = NEW.expected_version
       )
     ) != (
       EXISTS (SELECT 1 FROM questions WHERE id = NEW.question_id AND version = NEW.expected_version)
     )
    THEN RAISE(ABORT, 'invariante violada: núcleo e recibo de question_patterns divergem para esta mutação')
  END;

  SELECT CASE
    WHEN NEW.tags_expected_count IS NOT NULL
     AND (
       EXISTS (
         SELECT 1 FROM question_collection_mutation_receipts
         WHERE question_id = NEW.question_id AND collection = 'question_tags' AND expected_version = NEW.expected_version
       )
     ) != (
       EXISTS (SELECT 1 FROM questions WHERE id = NEW.question_id AND version = NEW.expected_version)
     )
    THEN RAISE(ABORT, 'invariante violada: núcleo e recibo de question_tags divergem para esta mutação')
  END;

  SELECT CASE
    WHEN NEW.images_expected_count IS NOT NULL
     AND (
       EXISTS (
         SELECT 1 FROM question_collection_mutation_receipts
         WHERE question_id = NEW.question_id AND collection = 'question_images' AND expected_version = NEW.expected_version
       )
     ) != (
       EXISTS (SELECT 1 FROM questions WHERE id = NEW.question_id AND version = NEW.expected_version)
     )
    THEN RAISE(ABORT, 'invariante violada: núcleo e recibo de question_images divergem para esta mutação')
  END;
END;
