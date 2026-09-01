-- FIXTURE TÉCNICA LOCAL — NÃO PUBLICAR — NÃO É QUESTÃO OFICIAL
--
-- Sprint 8 v1.1 — correção: duas alternativas (fixture-q-04-alt-c,
-- fixture-q-05-alt-b) traziam literalmente "(correto)"/"(correta)" no
-- PRÓPRIO TEXTO da alternativa. Isto nunca vazava nada na tela editorial
-- (Sprint 7), mas o Player de Questão (Sprint 8) mostra o texto de toda
-- alternativa antes da confirmação — o marcador entre parênteses vazava o
-- gabarito na tela, violando a garantia central da seção 3 da ordem do
-- Player ("respostas corretas... não podem aparecer antes da
-- confirmação"). Removido do texto; `is_correct` continua marcando a
-- alternativa certa normalmente, só nunca mais dentro do texto visível.
--
-- Sprint 7 v1.0 — questões sintéticas suficientes para exercitar o Banco de
-- Questões em ambiente local (catálogo, editor, workflow, importação e
-- screenshots). TODO enunciado/resolução carrega literalmente o prefixo
-- "FIXTURE TÉCNICA LOCAL — NÃO PUBLICAR — NÃO É QUESTÃO OFICIAL" (seção 3 da
-- ordem). Nenhuma questão oficial, nenhum logotipo/prova oficial reproduzida,
-- nenhuma imagem (nenhum asset de licença desconhecida foi usado — esta
-- sprint optou por NÃO incluir nenhuma imagem de fixture, só metadados
-- textuais, exatamente para não correr risco de licença — ver
-- docs/BANCO_QUESTOES.md, seção "Fixtures").
--
-- Vinculadas apenas aos cinco padrões provisórios da Sprint 6
-- (fixture-pat-01..05, ver scripts/fixtures/patterns-fixtures.local.sql —
-- este seed DEPENDE de patterns-fixtures.local.sql já ter sido aplicado).
--
-- Só é aplicado manualmente contra o D1 LOCAL:
--   npm run db:seed:questions:local
-- Independentemente destas linhas existirem no banco, o runtime do Worker
-- não concede papel editorial nem serve conteúdo fora do gate — ver
-- worker/src/env.ts:isLocalEditorialFixturesAllowed. A LEITURA do banco de
-- questões pela API editorial, no entanto, depende só do RBAC (não deste
-- gate) — o gate aqui protege o BOOTSTRAP DE PAPEL, não a leitura de uma
-- questão já existente; ver docs/BANCO_QUESTOES.md.
--
-- IDEMPOTÊNCIA: INSERT OR IGNORE em todas as tabelas, IDs determinísticos.
-- `autor_id`/`revisor_id` ficam NULL propositalmente — nenhum usuário fixo
-- é criado por este seed (autoria real só existe quando um editor de
-- verdade cria/edita pela API).

INSERT OR IGNORE INTO questions
  (id, code, enunciado, resolucao_comentada, conteudo, subconteudo, habilidade, competencia,
   dificuldade, origem, prova, ano, tempo_estimado_segundos, tipo_calculo, necessita_calculadora,
   editorial_status, titular_direitos, base_licenca, texto_atribuicao, fingerprint, is_local_fixture)
VALUES
  ('fixture-q-01', 'FIX-Q-01',
   'FIXTURE TÉCNICA LOCAL — NÃO PUBLICAR — NÃO É QUESTÃO OFICIAL. Um gráfico de barras mostra a arrecadação de duas lojas fictícias em um mês técnico de teste. Qual é a razão entre a arrecadação da loja A e da loja B?',
   'FIXTURE TÉCNICA LOCAL — NÃO PUBLICAR — NÃO É QUESTÃO OFICIAL. Resolução técnica: ler os dois valores do eixo e montar a razão pedida.',
   'Razão e proporção', 'Leitura de gráficos', 'Comparar grandezas em um gráfico', 'Interpretar dados estatísticos',
   'media', 'autoral', NULL, NULL, 90, 'misto', 0,
   'draft', 'Fixture técnica interna', 'Uso interno de desenvolvimento — não publicável', NULL,
   'fixture-fingerprint-q-01', 1),
  ('fixture-q-02', 'FIX-Q-02',
   'FIXTURE TÉCNICA LOCAL — NÃO PUBLICAR — NÃO É QUESTÃO OFICIAL. Uma planta baixa fictícia usa escala 1:50. Uma parede mede 4 cm no desenho técnico de teste. Qual é a medida real da parede?',
   'FIXTURE TÉCNICA LOCAL — NÃO PUBLICAR — NÃO É QUESTÃO OFICIAL. Resolução técnica: multiplicar a medida do desenho pelo fator de escala.',
   'Razão e proporção', 'Unidades de medida', 'Converter escala em medida real', 'Aplicar proporcionalidade',
   'facil', 'autoral', NULL, NULL, 60, 'escrito', 0,
   'in_review', 'Fixture técnica interna', 'Uso interno de desenvolvimento — não publicável', NULL,
   'fixture-fingerprint-q-02', 1),
  ('fixture-q-03', 'FIX-Q-03',
   'FIXTURE TÉCNICA LOCAL — NÃO PUBLICAR — NÃO É QUESTÃO OFICIAL. Um produto fictício custa R$ 200 técnicos e recebe desconto de 15% num teste de desenvolvimento. Qual o valor do desconto?',
   'FIXTURE TÉCNICA LOCAL — NÃO PUBLICAR — NÃO É QUESTÃO OFICIAL. Resolução técnica: aplicar 15% diretamente sobre o valor de referência.',
   'Porcentagem', 'Porcentagem', 'Calcular percentual direto', 'Aplicar proporcionalidade',
   'facil', 'autoral', NULL, NULL, 60, 'mental', 0,
   'changes_requested', 'Fixture técnica interna', 'Uso interno de desenvolvimento — não publicável', NULL,
   'fixture-fingerprint-q-03', 1),
  ('fixture-q-04', 'FIX-Q-04',
   'FIXTURE TÉCNICA LOCAL — NÃO PUBLICAR — NÃO É QUESTÃO OFICIAL. Uma tabela de frequência técnica de teste traz 7 valores distintos. Qual é o valor mediano dessa amostra fictícia?',
   'FIXTURE TÉCNICA LOCAL — NÃO PUBLICAR — NÃO É QUESTÃO OFICIAL. Resolução técnica: ordenar os valores e localizar a posição central.',
   'Estatística descritiva', 'Leitura de tabelas', 'Calcular mediana', 'Interpretar dados estatísticos',
   'media', 'autoral', NULL, NULL, 90, 'escrito', 0,
   'approved', 'Fixture técnica interna', 'Uso interno de desenvolvimento — não publicável', NULL,
   'fixture-fingerprint-q-04', 1),
  ('fixture-q-05', 'FIX-Q-05',
   'FIXTURE TÉCNICA LOCAL — NÃO PUBLICAR — NÃO É QUESTÃO OFICIAL. Um sólido técnico de teste, montado por cubos fictícios, é observado de frente. Qual alternativa mostra a vista frontal correta?',
   'FIXTURE TÉCNICA LOCAL — NÃO PUBLICAR — NÃO É QUESTÃO OFICIAL. Resolução técnica: fixar a direção do olhar e descartar silhuetas incompatíveis.',
   'Geometria espacial', 'Geometria plana', 'Reconhecer projeção ortogonal', 'Visualizar figuras espaciais',
   'dificil', 'autoral', NULL, NULL, 120, 'misto', 0,
   'draft', 'Fixture técnica interna', 'Uso interno de desenvolvimento — não publicável', NULL,
   'fixture-fingerprint-q-05', 1),
  -- Sprint 9 v1.0 — segunda questão PUBLICADA do MESMO padrão principal de
  -- fixture-q-04 (fixture-pat-04, "Mediana e Frequência"). Necessária para
  -- demonstrar/testar o Caderno de Erros: sem uma segunda questão
  -- semelhante publicada, a seleção determinística (seção 7 da ordem)
  -- nunca teria uma alternativa real além da própria questão original, e o
  -- critério de "outro contexto" (seção 6.1) nunca seria demonstrável de
  -- ponta a ponta. Inserida já `published` diretamente (sem passar por
  -- draft/in_review/approved) porque é uma fixture nova, não uma correção
  -- de conteúdo existente — mesma convenção de simplicidade já usada para
  -- não complicar o seed com um workflow editorial que não é o foco desta
  -- sprint.
  ('fixture-q-06', 'FIX-Q-06',
   'FIXTURE TÉCNICA LOCAL — NÃO PUBLICAR — NÃO É QUESTÃO OFICIAL. Uma segunda tabela de frequência técnica de teste traz 9 valores distintos. Qual é o valor mediano dessa amostra fictícia?',
   'FIXTURE TÉCNICA LOCAL — NÃO PUBLICAR — NÃO É QUESTÃO OFICIAL. Resolução técnica: ordenar os valores e localizar a posição central.',
   'Estatística descritiva', 'Leitura de tabelas', 'Calcular mediana', 'Interpretar dados estatísticos',
   'media', 'autoral', NULL, NULL, 90, 'escrito', 0,
   'published', 'Fixture técnica interna', 'Uso interno de desenvolvimento — não publicável', NULL,
   'fixture-fingerprint-q-06', 1);

-- A questão FIX-Q-04 (aprovada) é elevada a `published` só neste seed — isto
-- NUNCA acontece via API (publicação real exige workflow e papel admin
-- reais); aqui é só para o catálogo local ter ao menos um exemplo
-- `published` para telas/screenshots que dependem desse estado.
--
-- Sprint 8 v1.1 — correção: um seed em banco TOTALMENTE vazio (sem nenhum
-- histórico de execuções anteriores) disparava
-- trg_questions_require_history_after_update (migrations/0009): o UPDATE
-- abaixo muda `version` de 3 para 4 sem nenhuma linha de `question_history`
-- na versão 4 já existir — a mesma ordem "histórico ANTES do UPDATE, na
-- mesma transação" exigida de todo o resto do código
-- (worker/src/services/questionService.ts) também vale aqui. Isto só não
-- tinha sido pego antes porque o D1 local nunca tinha sido testado a partir
-- de um estado zerado nesta sprint — descoberto ao truncar
-- .wrangler/state/v3/d1 antes da rodada final de E2E da Sprint 8.
INSERT OR IGNORE INTO question_history (id, question_id, user_id, action, from_status, to_status, version, metadata) VALUES
  ('fixture-q-04-hist-4', 'fixture-q-04', NULL, 'published', 'approved', 'published', 4, NULL);
UPDATE questions SET editorial_status = 'published', version = 4 WHERE id = 'fixture-q-04' AND editorial_status = 'approved';

INSERT OR IGNORE INTO question_alternatives (id, question_id, letter, text, is_correct, position) VALUES
  ('fixture-q-01-alt-a', 'fixture-q-01', 'A', '[FIXTURE] 1 para 2', 0, 0),
  ('fixture-q-01-alt-b', 'fixture-q-01', 'B', '[FIXTURE] 2 para 1', 1, 1),
  ('fixture-q-01-alt-c', 'fixture-q-01', 'C', '[FIXTURE] 1 para 1', 0, 2),
  ('fixture-q-01-alt-d', 'fixture-q-01', 'D', '[FIXTURE] 3 para 1', 0, 3),
  ('fixture-q-01-alt-e', 'fixture-q-01', 'E', '[FIXTURE] 1 para 3', 0, 4),

  ('fixture-q-02-alt-a', 'fixture-q-02', 'A', '[FIXTURE] 1 metro', 0, 0),
  ('fixture-q-02-alt-b', 'fixture-q-02', 'B', '[FIXTURE] 2 metros', 1, 1),
  ('fixture-q-02-alt-c', 'fixture-q-02', 'C', '[FIXTURE] 3 metros', 0, 2),
  ('fixture-q-02-alt-d', 'fixture-q-02', 'D', '[FIXTURE] 4 metros', 0, 3),
  ('fixture-q-02-alt-e', 'fixture-q-02', 'E', '[FIXTURE] 5 metros', 0, 4),

  ('fixture-q-03-alt-a', 'fixture-q-03', 'A', '[FIXTURE] R$ 20', 0, 0),
  ('fixture-q-03-alt-b', 'fixture-q-03', 'B', '[FIXTURE] R$ 30', 1, 1),
  ('fixture-q-03-alt-c', 'fixture-q-03', 'C', '[FIXTURE] R$ 40', 0, 2),
  ('fixture-q-03-alt-d', 'fixture-q-03', 'D', '[FIXTURE] R$ 50', 0, 3),
  ('fixture-q-03-alt-e', 'fixture-q-03', 'E', '[FIXTURE] R$ 60', 0, 4),

  ('fixture-q-04-alt-a', 'fixture-q-04', 'A', '[FIXTURE] Valor X', 0, 0),
  ('fixture-q-04-alt-b', 'fixture-q-04', 'B', '[FIXTURE] Valor Y', 0, 1),
  ('fixture-q-04-alt-c', 'fixture-q-04', 'C', '[FIXTURE] Valor Z', 1, 2),
  ('fixture-q-04-alt-d', 'fixture-q-04', 'D', '[FIXTURE] Valor W', 0, 3),
  ('fixture-q-04-alt-e', 'fixture-q-04', 'E', '[FIXTURE] Valor V', 0, 4),

  ('fixture-q-05-alt-a', 'fixture-q-05', 'A', '[FIXTURE] Vista A', 0, 0),
  ('fixture-q-05-alt-b', 'fixture-q-05', 'B', '[FIXTURE] Vista B', 1, 1),
  ('fixture-q-05-alt-c', 'fixture-q-05', 'C', '[FIXTURE] Vista C', 0, 2),
  ('fixture-q-05-alt-d', 'fixture-q-05', 'D', '[FIXTURE] Vista D', 0, 3),
  ('fixture-q-05-alt-e', 'fixture-q-05', 'E', '[FIXTURE] Vista E', 0, 4),

  ('fixture-q-06-alt-a', 'fixture-q-06', 'A', '[FIXTURE] Valor P', 0, 0),
  ('fixture-q-06-alt-b', 'fixture-q-06', 'B', '[FIXTURE] Valor Q', 1, 1),
  ('fixture-q-06-alt-c', 'fixture-q-06', 'C', '[FIXTURE] Valor R', 0, 2),
  ('fixture-q-06-alt-d', 'fixture-q-06', 'D', '[FIXTURE] Valor S', 0, 3),
  ('fixture-q-06-alt-e', 'fixture-q-06', 'E', '[FIXTURE] Valor T', 0, 4);

INSERT OR IGNORE INTO question_dna (question_id, pista, estrategia, pegadinha, conteudo_apoio, resolucao, atalho, aprendizado_erro) VALUES
  ('fixture-q-01', '[FIXTURE] Dois valores no mesmo eixo.', '[FIXTURE] Ler os valores e montar a razão.', '[FIXTURE] Inverter numerador e denominador.', '[FIXTURE] Razão e proporção.', '[FIXTURE] Resolução técnica de teste.', NULL, '[FIXTURE] Confira sempre a ordem pedida na razão.'),
  ('fixture-q-02', '[FIXTURE] Escala do tipo 1:N.', '[FIXTURE] Multiplicar pela escala.', '[FIXTURE] Esquecer de converter unidade.', '[FIXTURE] Razão e proporção.', '[FIXTURE] Resolução técnica de teste.', '[FIXTURE] Atalho técnico de teste.', '[FIXTURE] Sempre converta a unidade antes de multiplicar.'),
  ('fixture-q-03', '[FIXTURE] Percentual único sobre valor único.', '[FIXTURE] Aplicar a taxa diretamente.', '[FIXTURE] Somar em vez de multiplicar.', '[FIXTURE] Porcentagem.', '[FIXTURE] Resolução técnica de teste.', NULL, '[FIXTURE] Porcentagem se aplica sobre o valor de referência.'),
  ('fixture-q-04', '[FIXTURE] Tabela de frequência.', '[FIXTURE] Ordenar e localizar o centro.', '[FIXTURE] Confundir mediana com média.', '[FIXTURE] Estatística descritiva.', '[FIXTURE] Resolução técnica de teste.', NULL, '[FIXTURE] Mediana exige ordenação prévia.'),
  ('fixture-q-05', '[FIXTURE] Silhuetas parecidas nas alternativas.', '[FIXTURE] Fixar a direção do olhar.', '[FIXTURE] Considerar profundidade indevida.', '[FIXTURE] Geometria espacial.', '[FIXTURE] Resolução técnica de teste.', NULL, '[FIXTURE] Projeção ortogonal ignora a profundidade.'),
  ('fixture-q-06', '[FIXTURE] Segunda tabela de frequência.', '[FIXTURE] Ordenar e localizar o centro.', '[FIXTURE] Confundir mediana com média.', '[FIXTURE] Estatística descritiva.', '[FIXTURE] Resolução técnica de teste.', NULL, '[FIXTURE] Mediana exige ordenação prévia.');

INSERT OR IGNORE INTO question_patterns (id, question_id, pattern_id, role) VALUES
  ('fixture-q-01-pat', 'fixture-q-01', 'fixture-pat-01', 'principal'),
  ('fixture-q-02-pat', 'fixture-q-02', 'fixture-pat-02', 'principal'),
  ('fixture-q-03-pat', 'fixture-q-03', 'fixture-pat-03', 'principal'),
  ('fixture-q-04-pat', 'fixture-q-04', 'fixture-pat-04', 'principal'),
  ('fixture-q-05-pat', 'fixture-q-05', 'fixture-pat-05', 'principal'),
  ('fixture-q-06-pat', 'fixture-q-06', 'fixture-pat-04', 'principal');

INSERT OR IGNORE INTO question_tags (id, question_id, content, position) VALUES
  ('fixture-q-01-tag-1', 'fixture-q-01', 'fixture', 0),
  ('fixture-q-02-tag-1', 'fixture-q-02', 'fixture', 0),
  ('fixture-q-03-tag-1', 'fixture-q-03', 'fixture', 0),
  ('fixture-q-04-tag-1', 'fixture-q-04', 'fixture', 0),
  ('fixture-q-05-tag-1', 'fixture-q-05', 'fixture', 0),
  ('fixture-q-06-tag-1', 'fixture-q-06', 'fixture', 0);

INSERT OR IGNORE INTO question_history (id, question_id, user_id, action, from_status, to_status, version, metadata) VALUES
  ('fixture-q-01-hist-1', 'fixture-q-01', NULL, 'created', NULL, 'draft', 1, NULL),
  ('fixture-q-02-hist-1', 'fixture-q-02', NULL, 'created', NULL, 'draft', 1, NULL),
  ('fixture-q-02-hist-2', 'fixture-q-02', NULL, 'submitted_review', 'draft', 'in_review', 2, NULL),
  ('fixture-q-03-hist-1', 'fixture-q-03', NULL, 'created', NULL, 'draft', 1, NULL),
  ('fixture-q-03-hist-2', 'fixture-q-03', NULL, 'submitted_review', 'draft', 'in_review', 2, NULL),
  ('fixture-q-03-hist-3', 'fixture-q-03', NULL, 'changes_requested', 'in_review', 'changes_requested', 3, '{"reason":"fixture de teste"}'),
  ('fixture-q-04-hist-1', 'fixture-q-04', NULL, 'created', NULL, 'draft', 1, NULL),
  ('fixture-q-04-hist-2', 'fixture-q-04', NULL, 'submitted_review', 'draft', 'in_review', 2, NULL),
  ('fixture-q-04-hist-3', 'fixture-q-04', NULL, 'approved', 'in_review', 'approved', 3, NULL),
  ('fixture-q-05-hist-1', 'fixture-q-05', NULL, 'created', NULL, 'draft', 1, NULL),
  ('fixture-q-06-hist-1', 'fixture-q-06', NULL, 'created', NULL, 'published', 1, NULL);
