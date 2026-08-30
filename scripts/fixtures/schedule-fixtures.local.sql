-- CONTEÚDO TÉCNICO PROVISÓRIO — NÃO PUBLICAR
--
-- Sprint 5 v1.0 — atividades técnicas fictícias, exclusivamente para testar
-- o MOTOR técnico do cronograma adaptativo (todos os 12 tipos, os três
-- modos de conclusão, atividades dispensáveis e não dispensáveis). NÃO são
-- priorização pedagógica aprovada — cada explicação diz explicitamente que
-- é demonstração técnica baseada na disponibilidade configurada, nunca
-- inferência sobre domínio/déficit do aluno (seção 2 da ordem).
--
-- Só cria as DEFINIÇÕES de atividade (schedule_activities) — a atribuição
-- concreta a um aluno (schedule_activity_assignments) é semeada sob demanda
-- pelo próprio Worker na primeira leitura de GET /api/schedule/summary de
-- cada usuário elegível ao gate local (ver
-- worker/src/services/scheduleService.ts:ensureFixtureAssignmentsSeeded),
-- já que, ao contrário das questões do diagnóstico, uma atividade de
-- cronograma só faz sentido depois de ter um dono.
--
-- Só é aplicado manualmente contra o D1 LOCAL:
--   npm run db:seed:schedule:local
-- (usa wrangler.local.jsonc + --local — nunca o D1 remoto). O runtime do
-- Worker também bloqueia o conteúdo fora do ambiente local explícito,
-- independentemente de estas linhas existirem no banco — ver
-- worker/src/env.ts:isLocalScheduleFixturesAllowed.
--
-- Espelhado (mesmo conteúdo, formato TypeScript) em
-- worker/testing/scheduleFixtures.ts, usado pelos testes unitários com o
-- FakeD1Database — os dois arquivos precisam ser mantidos em sincronia
-- manualmente ao alterar o conteúdo de fixture.
--
-- INSERT OR IGNORE (não DELETE+INSERT): reaplicar contra um D1 local que já
-- tem atribuições em andamento não pode quebrar chave estrangeira nem
-- apagar histórico.

INSERT OR IGNORE INTO schedule_activities
  (id, type, title, objective, estimated_minutes, completion_criteria, explanation, completion_mode, origin, dismissible, is_local_fixture)
VALUES
  ('fixture-sched-01', 'diagnostico', '[PROVISÓRIO] Concluir o diagnóstico inicial', 'Mapear seu ponto de partida.', 20, 'Diagnóstico marcado como concluído.', 'Demonstração técnica baseada somente na disponibilidade configurada — não é uma recomendação pedagógica.', 'manual', 'diagnostic', 1, 1),
  ('fixture-sched-02', 'reconhecimento', '[PROVISÓRIO] Reconhecimento de padrões — treino curto', 'Exercitar o reconhecimento de padrões antes da resolução.', 15, 'Todas as questões de reconhecimento respondidas.', 'Demonstração técnica baseada somente na disponibilidade configurada — não é uma recomendação pedagógica.', 'manual', 'system', 1, 1),
  ('fixture-sched-03', 'estudo_de_padrao', '[PROVISÓRIO] Estudo de um padrão recorrente', 'Aprofundar a compreensão de um padrão.', 25, 'Material revisado integralmente (marcação manual nesta sprint).', 'Demonstração técnica baseada somente na disponibilidade configurada — não é uma recomendação pedagógica.', 'manual', 'system', 1, 1),
  ('fixture-sched-04', 'conteudo_de_base', '[PROVISÓRIO] Reforço de conteúdo de base', 'Revisar um pré-requisito antes de avançar.', 30, 'Conteúdo revisado (marcação manual nesta sprint).', 'Demonstração técnica baseada somente na disponibilidade configurada — não é uma recomendação pedagógica.', 'manual', 'system', 1, 1),
  ('fixture-sched-05', 'aula_video', '[PROVISÓRIO] Aula em vídeo de exemplo', 'Assistir a uma aula curta sobre um padrão.', 20, 'Vídeo assistido integralmente (evidência futura — bloqueada nesta sprint).', 'Demonstração técnica baseada somente na disponibilidade configurada — não é uma recomendação pedagógica.', 'automatic', 'system', 1, 1),
  ('fixture-sched-06', 'treino_de_questoes', '[PROVISÓRIO] Treino de questões — sessão curta', 'Praticar questões de um padrão específico.', 30, 'Todas as questões da sessão respondidas.', 'Demonstração técnica baseada somente na disponibilidade configurada — não é uma recomendação pedagógica.', 'manual', 'system', 1, 1),
  ('fixture-sched-07', 'correcao_de_erro', '[PROVISÓRIO] Corrigir um erro do caderno', 'Revisar e corrigir um erro registrado anteriormente.', 15, 'Erro revisado e correção registrada (marcação manual nesta sprint).', 'Demonstração técnica baseada somente na disponibilidade configurada — não é uma recomendação pedagógica.', 'manual', 'system', 0, 1),
  ('fixture-sched-08', 'revisao_espacada', '[PROVISÓRIO] Revisão espaçada agendada', 'Reforçar um conteúdo já estudado, no intervalo certo.', 15, 'Revisão marcada como concluída.', 'Demonstração técnica baseada somente na disponibilidade configurada — não é uma recomendação pedagógica.', 'manual', 'review', 1, 1),
  ('fixture-sched-09', 'lista_do_professor', '[PROVISÓRIO] Lista de exercícios do professor', 'Completar a lista atribuída.', 40, 'Todos os itens da lista respondidos.', 'Demonstração técnica baseada somente na disponibilidade configurada — não é uma recomendação pedagógica.', 'manual', 'teacher', 0, 1),
  ('fixture-sched-10', 'simulado', '[PROVISÓRIO] Simulado curto de exemplo', 'Praticar sob condição cronometrada.', 90, 'Simulado corrigido (evidência futura — bloqueada nesta sprint).', 'Demonstração técnica baseada somente na disponibilidade configurada — não é uma recomendação pedagógica.', 'external_evidence', 'system', 1, 1),
  ('fixture-sched-11', 'live', '[PROVISÓRIO] Live de exemplo', 'Participar de uma sessão ao vivo.', 60, 'Presença registrada (evidência futura — bloqueada nesta sprint).', 'Demonstração técnica baseada somente na disponibilidade configurada — não é uma recomendação pedagógica.', 'external_evidence', 'system', 1, 1),
  ('fixture-sched-12', 'leitura_de_resumo', '[PROVISÓRIO] Leitura de resumo estratégico', 'Ler um resumo curto de um padrão.', 10, 'Resumo lido integralmente (marcação manual nesta sprint).', 'Demonstração técnica baseada somente na disponibilidade configurada — não é uma recomendação pedagógica.', 'manual', 'system', 1, 1);
