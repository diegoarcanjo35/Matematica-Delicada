-- CONTEÚDO TÉCNICO PROVISÓRIO — NÃO PUBLICAR
--
-- Sprint 4 v1.0 — 12 questões autorais fictícias, exclusivamente para testar
-- o MOTOR técnico do diagnóstico local (alternativas, reconhecimento
-- configurado/ausente, quatro camadas de ajuda, textos de tamanhos
-- diferentes). NÃO são diagnóstico pedagógico aprovado pela Andreia, NÃO
-- são questões oficiais do ENEM, NÃO geram nota TRI nem nível/domínio real.
--
-- Só é aplicado manualmente contra o D1 LOCAL:
--   npm run db:seed:diagnostic:local
-- (usa wrangler.local.jsonc + --local — nunca o D1 remoto). O runtime do
-- Worker também bloqueia o conteúdo fora do ambiente local explícito,
-- independentemente de estas linhas existirem no banco — ver
-- worker/src/env.ts:isLocalDiagnosticFixturesAllowed.
--
-- Espelhado (mesmo conteúdo, formato TypeScript) em
-- worker/testing/diagnosticFixtures.ts, usado pelos testes unitários com o
-- FakeD1Database — os dois arquivos precisam ser mantidos em sincronia
-- manualmente ao alterar o conteúdo de fixture.
--
-- INSERT OR IGNORE (não DELETE+INSERT): rodar este seed de novo contra um
-- D1 local que já tem tentativas/respostas de diagnóstico em andamento não
-- pode quebrar chave estrangeira nem apagar histórico — só garante que as
-- 12 questões existem, sem tocar no que já existir. Reaplicar é seguro e
-- idempotente (npm run test:e2e duas vezes seguidas depende disso).

-- Sprint 16 v1.2 — `is_local_fixture = 1` explícito em toda linha (migration
-- 0021 acrescentou a coluna, DEFAULT 0/"real"): este seed é sempre e
-- somente conteúdo técnico de fixture, nunca conteúdo real — a mesma
-- distinção que já existia para questions/schedule_activities/patterns
-- desde a Sprint 16 v1.0/v1.1 (A2) agora também se aplica ao diagnóstico.
INSERT OR IGNORE INTO diagnostic_questions (id, prompt, position, is_local_fixture) VALUES
  ('fixture-q01', '[PROVISÓRIO] Uma caixa tem 8 bolas azuis e 12 bolas vermelhas. Qual fração das bolas é azul?', 0, 1),
  ('fixture-q02', '[PROVISÓRIO] Um produto custava R$ 80 e teve um desconto de 25%. Qual o novo preço?', 1, 1),
  ('fixture-q03', '[PROVISÓRIO] Se 3 máquinas produzem 90 peças em 2 horas, quantas peças 3 máquinas produzem em 6 horas, mantendo o mesmo ritmo?', 2, 1),
  ('fixture-q04', '[PROVISÓRIO] Um mapa usa escala 1:50.000. Uma distância de 3 cm no mapa corresponde a quantos km no real?', 3, 1),
  ('fixture-q05', '[PROVISÓRIO] Numa turma de 40 alunos, 24 são meninas. Qual a razão entre meninos e meninas, na forma mais simples?', 4, 1),
  ('fixture-q06', '[PROVISÓRIO] Em uma pesquisa com 200 pessoas, 30% preferem a opção A. Quantas pessoas preferem a opção A?', 5, 1),
  ('fixture-q07', '[PROVISÓRIO] Qual o valor de x na equação 2x + 6 = 20?', 6, 1),
  ('fixture-q08', '[PROVISÓRIO] Um carro percorre 240 km em 4 horas, em velocidade constante. Qual a velocidade média, em km/h?', 7, 1),
  ('fixture-q09', '[PROVISÓRIO] Um terreno retangular tem 12 m de frente e 20 m de fundo. Qual a área do terreno, em m²?', 8, 1),
  ('fixture-q10', '[PROVISÓRIO] Um valor de R$ 500 aplicado rende 4% ao mês, em juros simples. Qual o rendimento em 3 meses?', 9, 1),
  ('fixture-q11', '[PROVISÓRIO] Numa sequência 2, 5, 8, 11, ..., qual é o próximo número?', 10, 1),
  ('fixture-q12', '[PROVISÓRIO] Uma pizza foi dividida em 8 pedaços iguais. Se 3 pessoas comeram 2 pedaços cada, qual fração da pizza restou?', 11, 1);

-- Auto-corretivo para um D1 local que já tinha estas 12 linhas ANTES da
-- migration 0021 (quando a coluna não existia e por isso o INSERT OR
-- IGNORE acima não as re-escreve): garante que ficam marcadas como fixture
-- mesmo num banco local mais antigo, sem exigir recriar o D1 do zero.
UPDATE diagnostic_questions SET is_local_fixture = 1 WHERE id LIKE 'fixture-q%';

INSERT OR IGNORE INTO diagnostic_question_options (id, question_id, position, text, is_correct) VALUES
  ('fixture-q01-a', 'fixture-q01', 0, '2/5', 1),
  ('fixture-q01-b', 'fixture-q01', 1, '3/5', 0),
  ('fixture-q01-c', 'fixture-q01', 2, '2/3', 0),
  ('fixture-q01-d', 'fixture-q01', 3, '4/5', 0),

  ('fixture-q02-a', 'fixture-q02', 0, 'R$ 55', 0),
  ('fixture-q02-b', 'fixture-q02', 1, 'R$ 60', 1),
  ('fixture-q02-c', 'fixture-q02', 2, 'R$ 65', 0),
  ('fixture-q02-d', 'fixture-q02', 3, 'R$ 70', 0),

  ('fixture-q03-a', 'fixture-q03', 0, '180 peças', 0),
  ('fixture-q03-b', 'fixture-q03', 1, '270 peças', 1),
  ('fixture-q03-c', 'fixture-q03', 2, '360 peças', 0),
  ('fixture-q03-d', 'fixture-q03', 3, '90 peças', 0),

  ('fixture-q04-a', 'fixture-q04', 0, '1,5 km', 1),
  ('fixture-q04-b', 'fixture-q04', 1, '15 km', 0),
  ('fixture-q04-c', 'fixture-q04', 2, '0,15 km', 0),
  ('fixture-q04-d', 'fixture-q04', 3, '150 km', 0),

  ('fixture-q05-a', 'fixture-q05', 0, '2 para 3', 1),
  ('fixture-q05-b', 'fixture-q05', 1, '3 para 5', 0),
  ('fixture-q05-c', 'fixture-q05', 2, '3 para 2', 0),
  ('fixture-q05-d', 'fixture-q05', 3, '5 para 3', 0),

  ('fixture-q06-a', 'fixture-q06', 0, '40 pessoas', 0),
  ('fixture-q06-b', 'fixture-q06', 1, '50 pessoas', 0),
  ('fixture-q06-c', 'fixture-q06', 2, '60 pessoas', 1),
  ('fixture-q06-d', 'fixture-q06', 3, '70 pessoas', 0),

  ('fixture-q07-a', 'fixture-q07', 0, 'x = 5', 0),
  ('fixture-q07-b', 'fixture-q07', 1, 'x = 6', 0),
  ('fixture-q07-c', 'fixture-q07', 2, 'x = 7', 1),
  ('fixture-q07-d', 'fixture-q07', 3, 'x = 8', 0),

  ('fixture-q08-a', 'fixture-q08', 0, '40 km/h', 0),
  ('fixture-q08-b', 'fixture-q08', 1, '50 km/h', 0),
  ('fixture-q08-c', 'fixture-q08', 2, '60 km/h', 1),
  ('fixture-q08-d', 'fixture-q08', 3, '80 km/h', 0),

  ('fixture-q09-a', 'fixture-q09', 0, '32 m²', 0),
  ('fixture-q09-b', 'fixture-q09', 1, '120 m²', 0),
  ('fixture-q09-c', 'fixture-q09', 2, '240 m²', 1),
  ('fixture-q09-d', 'fixture-q09', 3, '260 m²', 0),

  ('fixture-q10-a', 'fixture-q10', 0, 'R$ 20', 0),
  ('fixture-q10-b', 'fixture-q10', 1, 'R$ 40', 0),
  ('fixture-q10-c', 'fixture-q10', 2, 'R$ 60', 1),
  ('fixture-q10-d', 'fixture-q10', 3, 'R$ 80', 0),

  ('fixture-q11-a', 'fixture-q11', 0, '12', 0),
  ('fixture-q11-b', 'fixture-q11', 1, '13', 0),
  ('fixture-q11-c', 'fixture-q11', 2, '14', 1),
  ('fixture-q11-d', 'fixture-q11', 3, '15', 0),

  ('fixture-q12-a', 'fixture-q12', 0, '1/4', 1),
  ('fixture-q12-b', 'fixture-q12', 1, '1/2', 0),
  ('fixture-q12-c', 'fixture-q12', 2, '3/8', 0),
  ('fixture-q12-d', 'fixture-q12', 3, '5/8', 0);

-- Reconhecimento configurado só em metade das questões (q01-q06) — testa
-- "configurado e ausente" (q07-q12 não têm nenhuma linha aqui de propósito).
INSERT OR IGNORE INTO diagnostic_question_recognition_options (id, question_id, position, text, is_correct) VALUES
  ('fixture-q01-r-a', 'fixture-q01', 0, 'Proporção/parte-todo', 1),
  ('fixture-q01-r-b', 'fixture-q01', 1, 'Regra de três composta', 0),

  ('fixture-q02-r-a', 'fixture-q02', 0, 'Porcentagem direta', 1),
  ('fixture-q02-r-b', 'fixture-q02', 1, 'Juros compostos', 0),

  ('fixture-q03-r-a', 'fixture-q03', 0, 'Regra de três simples', 0),
  ('fixture-q03-r-b', 'fixture-q03', 1, 'Regra de três composta', 1),

  ('fixture-q04-r-a', 'fixture-q04', 0, 'Escala', 1),
  ('fixture-q04-r-b', 'fixture-q04', 1, 'Proporção/parte-todo', 0),

  ('fixture-q05-r-a', 'fixture-q05', 0, 'Razão', 1),
  ('fixture-q05-r-b', 'fixture-q05', 1, 'Proporção/parte-todo', 0),

  ('fixture-q06-r-a', 'fixture-q06', 0, 'Porcentagem direta', 1),
  ('fixture-q06-r-b', 'fixture-q06', 1, 'Razão', 0);

-- Quatro camadas de ajuda em todas as 12 questões (Documento Mestre, seção
-- 3.2). Textos curtos e provisórios — nunca o gabarito na camada 1-3.
INSERT OR IGNORE INTO diagnostic_question_help_layers (question_id, layer, content) VALUES
  ('fixture-q01', 1, '[PROVISÓRIO] Pista: pense em "parte" dividida pelo "todo".'),
  ('fixture-q01', 2, '[PROVISÓRIO] Padrão: proporção parte-todo — quantas bolas azuis, de quantas no total?'),
  ('fixture-q01', 3, '[PROVISÓRIO] Estratégia: some o total de bolas primeiro, depois divida a parte azul pelo total.'),
  ('fixture-q01', 4, '[PROVISÓRIO] Resolução: 8 azuis + 12 vermelhas = 20 no total. 8/20 simplifica para 2/5.'),

  ('fixture-q02', 1, '[PROVISÓRIO] Pista: desconto de 25% significa que sobra 75% do preço.'),
  ('fixture-q02', 2, '[PROVISÓRIO] Padrão: porcentagem direta sobre um valor.'),
  ('fixture-q02', 3, '[PROVISÓRIO] Estratégia: calcule 75% de R$ 80 diretamente.'),
  ('fixture-q02', 4, '[PROVISÓRIO] Resolução: 75% de 80 = 0,75 × 80 = 60. O novo preço é R$ 60.'),

  ('fixture-q03', 1, '[PROVISÓRIO] Pista: o número de máquinas não muda — só o tempo.'),
  ('fixture-q03', 2, '[PROVISÓRIO] Padrão: proporcionalidade direta entre tempo e produção.'),
  ('fixture-q03', 3, '[PROVISÓRIO] Estratégia: descubra quantas peças por hora e multiplique pelas 6 horas.'),
  ('fixture-q03', 4, '[PROVISÓRIO] Resolução: 90 peças em 2h = 45 peças/hora. Em 6h: 45 × 6 = 270 peças.'),

  ('fixture-q04', 1, '[PROVISÓRIO] Pista: a escala 1:50.000 diz que cada cm no mapa vale 50.000 cm reais.'),
  ('fixture-q04', 2, '[PROVISÓRIO] Padrão: escala — conversão de unidade de mapa para unidade real.'),
  ('fixture-q04', 3, '[PROVISÓRIO] Estratégia: multiplique os 3 cm por 50.000 e converta o resultado para km.'),
  ('fixture-q04', 4, '[PROVISÓRIO] Resolução: 3 × 50.000 = 150.000 cm = 1.500 m = 1,5 km.'),

  ('fixture-q05', 1, '[PROVISÓRIO] Pista: primeiro descubra quantos são meninos.'),
  ('fixture-q05', 2, '[PROVISÓRIO] Padrão: razão entre duas quantidades da mesma turma.'),
  ('fixture-q05', 3, '[PROVISÓRIO] Estratégia: 40 − 24 = meninos; depois simplifique a razão meninos:meninas.'),
  ('fixture-q05', 4, '[PROVISÓRIO] Resolução: 40 − 24 = 16 meninos. 16:24 simplifica para 2:3.'),

  ('fixture-q06', 1, '[PROVISÓRIO] Pista: 30% de 200 é o mesmo que 30/100 × 200.'),
  ('fixture-q06', 2, '[PROVISÓRIO] Padrão: porcentagem direta sobre uma quantidade de pessoas.'),
  ('fixture-q06', 3, '[PROVISÓRIO] Estratégia: multiplique 200 por 0,30.'),
  ('fixture-q06', 4, '[PROVISÓRIO] Resolução: 200 × 0,30 = 60 pessoas.'),

  ('fixture-q07', 1, '[PROVISÓRIO] Pista: isole o termo com x primeiro.'),
  ('fixture-q07', 2, '[PROVISÓRIO] Padrão: equação do primeiro grau.'),
  ('fixture-q07', 3, '[PROVISÓRIO] Estratégia: subtraia 6 dos dois lados, depois divida por 2.'),
  ('fixture-q07', 4, '[PROVISÓRIO] Resolução: 2x + 6 = 20 → 2x = 14 → x = 7.'),

  ('fixture-q08', 1, '[PROVISÓRIO] Pista: velocidade média é distância dividida por tempo.'),
  ('fixture-q08', 2, '[PROVISÓRIO] Padrão: razão distância/tempo (velocidade média).'),
  ('fixture-q08', 3, '[PROVISÓRIO] Estratégia: divida 240 km pelas 4 horas.'),
  ('fixture-q08', 4, '[PROVISÓRIO] Resolução: 240 ÷ 4 = 60 km/h.'),

  ('fixture-q09', 1, '[PROVISÓRIO] Pista: área de retângulo é base vezes altura.'),
  ('fixture-q09', 2, '[PROVISÓRIO] Padrão: área de figura plana retangular.'),
  ('fixture-q09', 3, '[PROVISÓRIO] Estratégia: multiplique frente por fundo.'),
  ('fixture-q09', 4, '[PROVISÓRIO] Resolução: 12 × 20 = 240 m².'),

  ('fixture-q10', 1, '[PROVISÓRIO] Pista: em juros simples, o rendimento mensal é sempre o mesmo valor.'),
  ('fixture-q10', 2, '[PROVISÓRIO] Padrão: juros simples sobre um capital fixo.'),
  ('fixture-q10', 3, '[PROVISÓRIO] Estratégia: calcule o rendimento de 1 mês e multiplique por 3.'),
  ('fixture-q10', 4, '[PROVISÓRIO] Resolução: 4% de 500 = 20 por mês. Em 3 meses: 20 × 3 = 60.'),

  ('fixture-q11', 1, '[PROVISÓRIO] Pista: observe a diferença entre cada número da sequência.'),
  ('fixture-q11', 2, '[PROVISÓRIO] Padrão: sequência aritmética (progressão de razão constante).'),
  ('fixture-q11', 3, '[PROVISÓRIO] Estratégia: descubra a razão constante e some ao último termo.'),
  ('fixture-q11', 4, '[PROVISÓRIO] Resolução: a razão é 3 (5−2, 8−5, 11−8). 11 + 3 = 14.'),

  ('fixture-q12', 1, '[PROVISÓRIO] Pista: primeiro descubra quantos pedaços foram comidos ao todo.'),
  ('fixture-q12', 2, '[PROVISÓRIO] Padrão: proporção parte-todo com subtração.'),
  ('fixture-q12', 3, '[PROVISÓRIO] Estratégia: 3 pessoas × 2 pedaços = pedaços comidos; subtraia do total de 8.'),
  ('fixture-q12', 4, '[PROVISÓRIO] Resolução: 3 × 2 = 6 pedaços comidos. 8 − 6 = 2 restantes. 2/8 simplifica para 1/4.');
