-- Sprint 7 v1.6 — corrige um colapso real de identidade nos triggers de
-- 0010/0011: eles verificam coisas como
-- `EXISTS(questions WHERE id=? AND version=NEW.expected_version)` — ou
-- seja, "o núcleo está ATUALMENTE na versão que este marcador esperava?".
-- Isso funciona quando só existe UMA mutação em voo por vez, mas quebra sob
-- concorrência otimista real: se a mutação A (mutationId A) avança
-- legitimamente uma questão de version=1 para version=2, e uma mutação B
-- DIFERENTE (mutationId B, outro ator/requisição), construída contra
-- `expectedVersion=1` (já obsoleta, porque começou antes de A terminar),
-- ainda assim insere seu PRÓPRIO marcador com `expected_version = 1+1 = 2`
-- (o alvo que B CALCULOU) — mesmo que TODOS os guards do UPDATE/histórico/
-- recibo de B tenham corretamente falhado (afetado 0 linhas, já que a
-- versão real já é 2). O marcador de B, ao disparar os triggers de
-- 0010/0011, faz essas perguntas "por versão" — "o núcleo está em v2?" (SIM,
-- graças a A) contra "existe histórico/recibo PARA v2?" — que não distingue
-- DE QUEM é esse histórico/recibo. No caso do recibo (0011), o problema é
-- ainda mais agudo: a própria limpeza técnica da v1.5 já APAGOU o recibo de
-- A logo depois que A commitou (ver migrations/0011) — então, quando o
-- marcador de B dispara o trigger de 0011, a resposta é sistematicamente
-- "não existe recibo para v2" (FALSO), enquanto "núcleo está em v2" é
-- VERDADEIRO — uma divergência que aborta um conflito de versão
-- perfeitamente comum como se fosse corrupção real.
--
-- Reproduzido e confirmado ANTES desta correção (commit 820196e) em
-- worker/testing/questions.test.ts, describe "Sprint 7 v1.6": uma mutação B
-- (mutationId diferente, expectedVersion=1 já obsoleta porque A já avançou
-- para v2) lança `invariante violada: núcleo e recibo de question_tags
-- divergem para esta mutação` tanto no nível de serviço quanto through a
-- rota HTTP, em vez de devolver um 409 limpo.
--
-- Mecanismo: uma IDENTIDADE explícita por mutação, nunca mais um número de
-- versão compartilhável entre mutações concorrentes distintas.
--   1) `questions.last_mutation_id` (nova coluna, nullable) registra QUAL
--      mutação especificamente foi a última a fazer `version` avançar com
--      sucesso — setada pelo MESMO UPDATE guardado que já muda `version`
--      (nunca um statement à parte, nunca "confiável só por convenção").
--   2) `editorial_mutation_checks.id` e
--      `question_collection_mutation_receipts.id` passam a SER a
--      identidade real da mutação — o `mutationId` (ou o id de histórico
--      gerado internamente, no caso de `applyTransition`, que não tem
--      `mutationId` vindo do cliente), e `'<identidade>:<colecao>'` para um
--      recibo de coleção específico — em vez de um UUID aleatório sem
--      relação nenhuma com a operação. Isso permite perguntar "o
--      histórico/recibo QUE EU MESMO (esta mutação, especificamente)
--      deveria ter inserido existe?", nunca "existe ALGUM histórico/recibo
--      para esta versão, seja lá de quem for?" — a segunda pergunta é
--      exatamente a que confunde mutações concorrentes distintas
--      mirando o mesmo número de versão resultante.
--
-- ATUALIZAÇÃO (mesma migration, antes de qualquer commit): a auditoria não
-- aceitou deixar o trigger de CONTAGEM por coleção de 0010
-- (`trg_editorial_mutation_checks_bidirectional`) como risco residual —
-- ele tem exatamente a MESMA classe de vulnerabilidade que o de recibos de
-- 0011: sua checagem `(COUNT(... WHERE version_stamp = NEW.expected_version)
-- = NEW.<x>_expected_count) != EXISTS(core@expected_version)` também não
-- pergunta QUEM produziu aquele estado. Ao contrário do recibo (cuja
-- evidência é ativamente apagada pela limpeza da v1.5, tornando o furo
-- CERTO), o furo aqui é mais estreito — só se manifesta se a mutação B
-- declarar uma coleção que A nunca tocou (nenhuma linha carimbada com
-- version_stamp = X para aquela coleção, então a contagem real é 0; se B
-- também declarar 0, colidiria por acidente com o caso "coleção vazia" e
-- passaria; se B declarar N>0, divergiria e abortaria um conflito
-- legítimo) — mas é da MESMA natureza (checagem por versão, não por
-- identidade) e por isso também retirado nesta migration.
--
-- Por que retirar os DOIS (0010 e 0011) não reduz proteção alguma, e por
-- que 0009 PODE continuar ativo com segurança:
--   * 0009 (`trg_questions_require_history_after_update`) só dispara
--     quando uma linha de `questions` MUDA de `version` de fato (
--     `WHEN NEW.version != OLD.version`), e checa
--     `EXISTS(question_history WHERE question_id=? AND version=NEW.version)`
--     — uma linha de histórico, uma vez gravada para uma versão, nunca é
--     apagada (`question_history` é append-only, sem DELETE em nenhum
--     código de produção). Logo, sempre que ESTE UPDATE realmente mudar a
--     versão, o histórico para essa MESMA versão TEM que ter sido
--     inserido momentos antes, na MESMA transação, pelo MESMO guard
--     (`buildConditionalHistoryStatement`, rodando ANTES do UPDATE central
--     — v1.3) — nunca pode ser o histórico de uma mutação concorrente
--     qualquer, porque só existe UM UPDATE em voo por transação, e a
--     pergunta é literal ("este UPDATE, que acabou de rodar, tem
--     histórico?"), nunca "existe histórico para esta versão, seja de
--     quem for?". 0009 não sofre do bug de identidade porque nunca compara
--     o estado atual do banco com uma EXPECTATIVA vinda de outro lugar
--     (como o marcador faz) — ele só audita o PRÓPRIO UPDATE que acabou de
--     rodar, sempre a fonte de verdade certa. Continua ativo sem risco.
--   * 0010 e 0011, em contraste, disparam a partir do INSERT incondicional
--     do MARCADOR — uma linha SEPARADA, escrita por uma mutação que pode
--     ou não ser a mesma que produziu o estado atual do núcleo. Comparar
--     "o marcador espera a versão X" com "o núcleo está em X" (0010) ou
--     "existe recibo para X" (0011) SEMPRE corre o risco de confundir duas
--     mutações que, por coincidência aritmética (`expectedVersion + 1`),
--     miram o MESMO número — não importa se a evidência subjacente é
--     permanente (0010) ou apagada (0011): o problema não é a evidência
--     em si, é a PERGUNTA errada ("existe ALGO para X" em vez de "isto
--     aconteceu POR CAUSA DESTA mutação").
--
-- Mecanismo final: os DOIS triggers de 0010/0011 são retirados (via
-- DROP + CREATE NESTA migration nova — os ARQUIVOS de 0010/0011 em si
-- NUNCA são editados; seu conteúdo histórico permanece exatamente como foi
-- commitado, descrevendo fielmente o que cada um adicionou naquele
-- momento) e substituídos por UM ÚNICO trigger consolidado, que cobre TUDO
-- que os dois cobriam — núcleo<->histórico E núcleo<->coleção (existência
-- do guard via recibo E contagem exata via `version_stamp`) — mas SEMPRE
-- perguntando "isto é resultado DESTA mutação, identificada por
-- `last_mutation_id = NEW.id`?", nunca "existe algo para esta versão?".
-- Uma coleção só é considerada "confirmada" quando (a) o recibo desta
-- IDENTIDADE existe E (b) a contagem carimbada com `version_stamp = NEW.expected_version`
-- bate com o esperado (ou o esperado é 0) — as duas condições, como a
-- versão original de 0010/0011 já garantia, só que agora atreladas à
-- identidade em vez de à versão.
--
-- Aditiva quanto a CONTEÚDO (nenhuma linha de dado é apagada por esta
-- migration) mas ALTERA o schema de `questions` (uma coluna nova, nullable,
-- via `ALTER TABLE` — não idempotente por reaplicação manual direta, mesma
-- ressalva documentada em 0010) e SUBSTITUI dois triggers específicos (o
-- núcleo<->histórico/coleção de 0010 e o de recibos de 0011) por uma versão
-- consolidada e corrigida com um NOME diferente — nunca edita os arquivos
-- .sql de 0009/0010/0011. A Sprint 8 deve começar sua própria migration em
-- `0013` — nunca reaproveitar ou renumerar 0009/0010/0011/0012.

ALTER TABLE questions ADD COLUMN last_mutation_id TEXT;

-- Retira os dois triggers de 0010/0011 — ambos checam "existe ALGO para
-- esta versão?" em vez de "isto é resultado DESTA mutação?" (ver nota
-- extensa acima). O trigger consolidado abaixo cobre tudo que os dois
-- cobriam, agora todo atrelado a `last_mutation_id`/identidade — nunca um
-- enfraquecimento, uma correção genuína do mesmo conjunto de invariantes.
DROP TRIGGER IF EXISTS trg_editorial_mutation_checks_collection_receipts;
DROP TRIGGER IF EXISTS trg_editorial_mutation_checks_bidirectional;

CREATE TRIGGER IF NOT EXISTS trg_editorial_mutation_checks_by_identity
AFTER INSERT ON editorial_mutation_checks
FOR EACH ROW
BEGIN
  -- Núcleo <-> histórico, por IDENTIDADE desta mutação específica
  -- (NEW.id É o mutationId, ou o id de histórico gerado internamente para
  -- uma transição — nunca mais um UUID de marcador sem relação com a
  -- operação, a partir desta migration).
  SELECT CASE
    WHEN (
      EXISTS (SELECT 1 FROM question_history WHERE id = NEW.id)
    ) != (
      EXISTS (SELECT 1 FROM questions WHERE id = NEW.question_id AND last_mutation_id = NEW.id AND version = NEW.expected_version)
    )
    THEN RAISE(ABORT, 'invariante violada: núcleo e histórico divergem para ESTA mutação especificamente (por identidade)')
  END;

  -- Núcleo <-> coleção, por IDENTIDADE: para cada coleção tocada por ESTA
  -- mutação (expected_count não-NULL), a coleção só é considerada
  -- "confirmada" se (a) o recibo desta identidade existe
  -- (id = '<identidade>:<coleção>' — prova que o guard do DELETE/INSERT
  -- rodou de verdade, qualquer que seja a contagem resultante) E (b) a
  -- contagem de linhas carimbadas com `version_stamp = NEW.expected_version`
  -- bate com o esperado (pulado quando o esperado é 0 — ver nota extensa
  -- em 0010/0011 original sobre por que uma contagem "= 0" é vácua e não
  -- prova nada sozinha; o recibo já cobre esse caso). Isso deve coincidir
  -- com "o núcleo avançou PARA a versão esperada POR CAUSA DESTA
  -- IDENTIDADE" — nunca com "o núcleo está NUMA versão X, seja de quem
  -- for".
  SELECT CASE
    WHEN NEW.alternatives_expected_count IS NOT NULL
     AND (
       EXISTS (SELECT 1 FROM question_collection_mutation_receipts WHERE id = NEW.id || ':question_alternatives')
       AND (
         NEW.alternatives_expected_count = 0
         OR (SELECT COUNT(*) FROM question_alternatives WHERE question_id = NEW.question_id AND version_stamp = NEW.expected_version) = NEW.alternatives_expected_count
       )
     ) != (
       EXISTS (SELECT 1 FROM questions WHERE id = NEW.question_id AND last_mutation_id = NEW.id AND version = NEW.expected_version)
     )
    THEN RAISE(ABORT, 'invariante violada: núcleo e question_alternatives (por identidade) divergem para ESTA mutação')
  END;

  SELECT CASE
    WHEN NEW.dna_expected_count IS NOT NULL
     AND (
       EXISTS (SELECT 1 FROM question_collection_mutation_receipts WHERE id = NEW.id || ':question_dna')
       AND (
         NEW.dna_expected_count = 0
         OR (SELECT COUNT(*) FROM question_dna WHERE question_id = NEW.question_id AND version_stamp = NEW.expected_version) = NEW.dna_expected_count
       )
     ) != (
       EXISTS (SELECT 1 FROM questions WHERE id = NEW.question_id AND last_mutation_id = NEW.id AND version = NEW.expected_version)
     )
    THEN RAISE(ABORT, 'invariante violada: núcleo e question_dna (por identidade) divergem para ESTA mutação')
  END;

  SELECT CASE
    WHEN NEW.patterns_expected_count IS NOT NULL
     AND (
       EXISTS (SELECT 1 FROM question_collection_mutation_receipts WHERE id = NEW.id || ':question_patterns')
       AND (
         NEW.patterns_expected_count = 0
         OR (SELECT COUNT(*) FROM question_patterns WHERE question_id = NEW.question_id AND version_stamp = NEW.expected_version) = NEW.patterns_expected_count
       )
     ) != (
       EXISTS (SELECT 1 FROM questions WHERE id = NEW.question_id AND last_mutation_id = NEW.id AND version = NEW.expected_version)
     )
    THEN RAISE(ABORT, 'invariante violada: núcleo e question_patterns (por identidade) divergem para ESTA mutação')
  END;

  SELECT CASE
    WHEN NEW.tags_expected_count IS NOT NULL
     AND (
       EXISTS (SELECT 1 FROM question_collection_mutation_receipts WHERE id = NEW.id || ':question_tags')
       AND (
         NEW.tags_expected_count = 0
         OR (SELECT COUNT(*) FROM question_tags WHERE question_id = NEW.question_id AND version_stamp = NEW.expected_version) = NEW.tags_expected_count
       )
     ) != (
       EXISTS (SELECT 1 FROM questions WHERE id = NEW.question_id AND last_mutation_id = NEW.id AND version = NEW.expected_version)
     )
    THEN RAISE(ABORT, 'invariante violada: núcleo e question_tags (por identidade) divergem para ESTA mutação')
  END;

  SELECT CASE
    WHEN NEW.images_expected_count IS NOT NULL
     AND (
       EXISTS (SELECT 1 FROM question_collection_mutation_receipts WHERE id = NEW.id || ':question_images')
       AND (
         NEW.images_expected_count = 0
         OR (SELECT COUNT(*) FROM question_images WHERE question_id = NEW.question_id AND version_stamp = NEW.expected_version) = NEW.images_expected_count
       )
     ) != (
       EXISTS (SELECT 1 FROM questions WHERE id = NEW.question_id AND last_mutation_id = NEW.id AND version = NEW.expected_version)
     )
    THEN RAISE(ABORT, 'invariante violada: núcleo e question_images (por identidade) divergem para ESTA mutação')
  END;
END;
