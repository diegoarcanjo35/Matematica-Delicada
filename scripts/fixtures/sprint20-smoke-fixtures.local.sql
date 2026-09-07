-- FIXTURE TÉCNICA LOCAL TEMPORÁRIA — SPRINT 20 SMOKE
-- Só para o smoke manual local da Sprint 20 (seção 30 da ordem) — nunca
-- aplicado em produção. Adiciona mais 2 questões PUBLICADAS ao padrão
-- fixture-pat-04 ("Mediana e Frequência"), que já tinha 1 (fixture-q-04),
-- totalizando 3 — suficiente para exercitar o Treino por Padrão de verdade.
-- INSERT OR IGNORE + IDs determinísticos — idempotente, nunca duplica.

INSERT OR IGNORE INTO questions
  (id, code, enunciado, resolucao_comentada, conteudo, subconteudo, habilidade, competencia,
   dificuldade, origem, prova, ano, tempo_estimado_segundos, tipo_calculo, necessita_calculadora,
   editorial_status, titular_direitos, base_licenca, texto_atribuicao, fingerprint, is_local_fixture)
VALUES
  ('smoke20-q-01', 'SMOKE20-Q01',
   'FIXTURE TÉCNICA LOCAL — NÃO PUBLICAR — NÃO É QUESTÃO OFICIAL. Smoke Sprint 20: um conjunto técnico de dados tem mediana X. Qual alternativa representa esse valor?',
   'FIXTURE TÉCNICA LOCAL — NÃO PUBLICAR — NÃO É QUESTÃO OFICIAL. Resolução técnica de smoke.',
   'Estatística descritiva', 'Mediana', 'Localizar o valor central', 'Interpretar dados',
   'media', 'autoral', NULL, NULL, 90, 'misto', 0,
   'published', 'Fixture técnica interna', 'Uso interno de desenvolvimento — não publicável', NULL,
   'smoke20-fingerprint-01', 1),
  ('smoke20-q-02', 'SMOKE20-Q02',
   'FIXTURE TÉCNICA LOCAL — NÃO PUBLICAR — NÃO É QUESTÃO OFICIAL. Smoke Sprint 20: uma tabela de frequência técnica mostra a distribuição de um conjunto fictício. Qual valor é o mais frequente?',
   'FIXTURE TÉCNICA LOCAL — NÃO PUBLICAR — NÃO É QUESTÃO OFICIAL. Resolução técnica de smoke.',
   'Estatística descritiva', 'Moda', 'Localizar o valor mais frequente', 'Interpretar dados',
   'facil', 'autoral', NULL, NULL, 60, 'misto', 0,
   'published', 'Fixture técnica interna', 'Uso interno de desenvolvimento — não publicável', NULL,
   'smoke20-fingerprint-02', 1);

INSERT OR IGNORE INTO question_alternatives (id, question_id, letter, text, is_correct, position) VALUES
  ('smoke20-q-01-alt-a', 'smoke20-q-01', 'A', '[SMOKE] Valor A', 0, 0),
  ('smoke20-q-01-alt-b', 'smoke20-q-01', 'B', '[SMOKE] Valor B', 0, 1),
  ('smoke20-q-01-alt-c', 'smoke20-q-01', 'C', '[SMOKE] Valor C', 1, 2),
  ('smoke20-q-01-alt-d', 'smoke20-q-01', 'D', '[SMOKE] Valor D', 0, 3),
  ('smoke20-q-01-alt-e', 'smoke20-q-01', 'E', '[SMOKE] Valor E', 0, 4),
  ('smoke20-q-02-alt-a', 'smoke20-q-02', 'A', '[SMOKE] Valor A', 0, 0),
  ('smoke20-q-02-alt-b', 'smoke20-q-02', 'B', '[SMOKE] Valor B', 1, 1),
  ('smoke20-q-02-alt-c', 'smoke20-q-02', 'C', '[SMOKE] Valor C', 0, 2),
  ('smoke20-q-02-alt-d', 'smoke20-q-02', 'D', '[SMOKE] Valor D', 0, 3),
  ('smoke20-q-02-alt-e', 'smoke20-q-02', 'E', '[SMOKE] Valor E', 0, 4);

INSERT OR IGNORE INTO question_dna (question_id, pista, estrategia, pegadinha, conteudo_apoio, resolucao, atalho, aprendizado_erro) VALUES
  ('smoke20-q-01', '[SMOKE] Pista.', '[SMOKE] Estratégia.', '[SMOKE] Pegadinha.', '[SMOKE] Apoio.', '[SMOKE] Resolução.', NULL, '[SMOKE] Aprendizado.'),
  ('smoke20-q-02', '[SMOKE] Pista.', '[SMOKE] Estratégia.', '[SMOKE] Pegadinha.', '[SMOKE] Apoio.', '[SMOKE] Resolução.', NULL, '[SMOKE] Aprendizado.');

INSERT OR IGNORE INTO question_patterns (id, question_id, pattern_id, role) VALUES
  ('smoke20-q-01-pat', 'smoke20-q-01', 'fixture-pat-04', 'principal'),
  ('smoke20-q-02-pat', 'smoke20-q-02', 'fixture-pat-04', 'principal');
