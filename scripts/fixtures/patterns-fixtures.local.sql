-- CONTEÚDO TÉCNICO PROVISÓRIO PARA DESENVOLVIMENTO LOCAL — NÃO PUBLICAR
--
-- Sprint 6 v1.0 — os CINCO nomes de padrão citados literalmente no Documento
-- Mestre (seção 3 da ordem): Razão em Gráfico, Escala, Porcentagem Direta,
-- Mediana e Frequência, Projeção Ortogonal.
--
-- Todo o texto pedagógico abaixo é PROVISÓRIO e TÉCNICO: existe só para
-- exercitar o catálogo, a ficha, a busca, os filtros e a paginação em
-- ambiente local. NÃO é a taxonomia oficial, NÃO é conteúdo revisado nem
-- aprovado pela Andreia, e NÃO reproduz nenhuma questão oficial do ENEM.
-- Cada campo pedagógico carrega a marcação explícita
-- "[CONTEÚDO TÉCNICO PROVISÓRIO PARA DESENVOLVIMENTO LOCAL — NÃO PUBLICAR]"
-- para que nunca seja confundido com conteúdo final, nem no banco nem na UI.
--
-- Só é aplicado manualmente contra o D1 LOCAL:
--   npm run db:seed:patterns:local
-- (usa wrangler.local.jsonc + --local — nunca o D1 remoto). Independentemente
-- destas linhas existirem no banco, o runtime do Worker bloqueia o conteúdo
-- fora do ambiente local explícito — ver
-- worker/src/env.ts:isLocalPatternFixturesAllowed.
--
-- Espelhado (mesmo conteúdo conceitual, formato TypeScript) em
-- worker/testing/patternFixtures.ts, usado pelos testes unitários com o
-- FakeD1Database — os dois arquivos precisam ser mantidos em sincronia
-- manualmente ao alterar o conteúdo de fixture.
--
-- IDEMPOTÊNCIA: INSERT OR IGNORE em todas as tabelas (mesma convenção de
-- scripts/fixtures/diagnostic-fixtures.local.sql e schedule-fixtures.local.sql).
-- Nunca DELETE+INSERT: reaplicar contra um D1 local que já tem progresso de
-- aluno não pode quebrar chave estrangeira nem apagar histórico. Todos os
-- IDs abaixo são determinísticos (nunca UUID aleatório), justamente para que
-- reaplicar não duplique nada.
--
-- NENHUMA linha de student_pattern_progress é semeada aqui: o progresso
-- pertence exclusivamente ao aluno e só pode nascer de evidência real. Por
-- isso, num ambiente recém-semeado, os três índices são legitimamente NULL
-- e a UI mostra "Ainda sem evidências suficientes" — nunca 0%.

INSERT OR IGNORE INTO patterns
  (id, code, slug, name, recognition_phrase, description, main_strategy, introductory_example, strategic_summary, editorial_status, is_local_fixture)
VALUES
  ('fixture-pat-01', 'PAD-01', 'razao-em-grafico', 'Razão em Gráfico',
   '[CONTEÚDO TÉCNICO PROVISÓRIO PARA DESENVOLVIMENTO LOCAL — NÃO PUBLICAR] O enunciado pede comparar duas grandezas lidas de um mesmo gráfico.',
   '[CONTEÚDO TÉCNICO PROVISÓRIO PARA DESENVOLVIMENTO LOCAL — NÃO PUBLICAR] Descrição técnica de desenvolvimento: a questão apresenta um gráfico e pede a razão entre dois valores extraídos dele.',
   '[CONTEÚDO TÉCNICO PROVISÓRIO PARA DESENVOLVIMENTO LOCAL — NÃO PUBLICAR] Ler os dois valores diretamente do eixo antes de montar a razão.',
   '[CONTEÚDO TÉCNICO PROVISÓRIO PARA DESENVOLVIMENTO LOCAL — NÃO PUBLICAR] Exemplo introdutório fictício, criado apenas para teste de interface.',
   '[CONTEÚDO TÉCNICO PROVISÓRIO PARA DESENVOLVIMENTO LOCAL — NÃO PUBLICAR] Resumo estratégico provisório, sem validação pedagógica.',
   'published', 1),
  ('fixture-pat-02', 'PAD-02', 'escala', 'Escala',
   '[CONTEÚDO TÉCNICO PROVISÓRIO PARA DESENVOLVIMENTO LOCAL — NÃO PUBLICAR] O enunciado relaciona uma medida no desenho com a medida real correspondente.',
   '[CONTEÚDO TÉCNICO PROVISÓRIO PARA DESENVOLVIMENTO LOCAL — NÃO PUBLICAR] Descrição técnica de desenvolvimento: conversão entre medida representada e medida real por um fator de escala.',
   '[CONTEÚDO TÉCNICO PROVISÓRIO PARA DESENVOLVIMENTO LOCAL — NÃO PUBLICAR] Escrever a escala como razão e converter as unidades antes de multiplicar.',
   '[CONTEÚDO TÉCNICO PROVISÓRIO PARA DESENVOLVIMENTO LOCAL — NÃO PUBLICAR] Exemplo introdutório fictício, criado apenas para teste de interface.',
   '[CONTEÚDO TÉCNICO PROVISÓRIO PARA DESENVOLVIMENTO LOCAL — NÃO PUBLICAR] Resumo estratégico provisório, sem validação pedagógica.',
   'published', 1),
  ('fixture-pat-03', 'PAD-03', 'porcentagem-direta', 'Porcentagem Direta',
   '[CONTEÚDO TÉCNICO PROVISÓRIO PARA DESENVOLVIMENTO LOCAL — NÃO PUBLICAR] O enunciado pede uma porcentagem de um valor conhecido, sem acréscimos sucessivos.',
   '[CONTEÚDO TÉCNICO PROVISÓRIO PARA DESENVOLVIMENTO LOCAL — NÃO PUBLICAR] Descrição técnica de desenvolvimento: aplicação direta de uma taxa percentual sobre um valor dado.',
   '[CONTEÚDO TÉCNICO PROVISÓRIO PARA DESENVOLVIMENTO LOCAL — NÃO PUBLICAR] Transformar a porcentagem em fração decimal e multiplicar pelo valor de referência.',
   '[CONTEÚDO TÉCNICO PROVISÓRIO PARA DESENVOLVIMENTO LOCAL — NÃO PUBLICAR] Exemplo introdutório fictício, criado apenas para teste de interface.',
   '[CONTEÚDO TÉCNICO PROVISÓRIO PARA DESENVOLVIMENTO LOCAL — NÃO PUBLICAR] Resumo estratégico provisório, sem validação pedagógica.',
   'published', 1),
  ('fixture-pat-04', 'PAD-04', 'mediana-e-frequencia', 'Mediana e Frequência',
   '[CONTEÚDO TÉCNICO PROVISÓRIO PARA DESENVOLVIMENTO LOCAL — NÃO PUBLICAR] O enunciado traz uma tabela de frequências e pede uma medida de posição.',
   '[CONTEÚDO TÉCNICO PROVISÓRIO PARA DESENVOLVIMENTO LOCAL — NÃO PUBLICAR] Descrição técnica de desenvolvimento: leitura de tabela de frequência para obter mediana ou moda.',
   '[CONTEÚDO TÉCNICO PROVISÓRIO PARA DESENVOLVIMENTO LOCAL — NÃO PUBLICAR] Acumular as frequências até localizar a posição central antes de responder.',
   '[CONTEÚDO TÉCNICO PROVISÓRIO PARA DESENVOLVIMENTO LOCAL — NÃO PUBLICAR] Exemplo introdutório fictício, criado apenas para teste de interface.',
   '[CONTEÚDO TÉCNICO PROVISÓRIO PARA DESENVOLVIMENTO LOCAL — NÃO PUBLICAR] Resumo estratégico provisório, sem validação pedagógica.',
   'published', 1),
  ('fixture-pat-05', 'PAD-05', 'projecao-ortogonal', 'Projeção Ortogonal',
   '[CONTEÚDO TÉCNICO PROVISÓRIO PARA DESENVOLVIMENTO LOCAL — NÃO PUBLICAR] O enunciado mostra um sólido e pede a vista de frente, de cima ou lateral.',
   '[CONTEÚDO TÉCNICO PROVISÓRIO PARA DESENVOLVIMENTO LOCAL — NÃO PUBLICAR] Descrição técnica de desenvolvimento: identificação da vista ortogonal correspondente a um sólido representado.',
   '[CONTEÚDO TÉCNICO PROVISÓRIO PARA DESENVOLVIMENTO LOCAL — NÃO PUBLICAR] Fixar a direção do olhar e descartar as alternativas que mudam a silhueta.',
   '[CONTEÚDO TÉCNICO PROVISÓRIO PARA DESENVOLVIMENTO LOCAL — NÃO PUBLICAR] Exemplo introdutório fictício, criado apenas para teste de interface.',
   '[CONTEÚDO TÉCNICO PROVISÓRIO PARA DESENVOLVIMENTO LOCAL — NÃO PUBLICAR] Resumo estratégico provisório, sem validação pedagógica.',
   'published', 1);

-- Estruturas multivaloradas — TODAS na tabela genérica pattern_attributes,
-- com o enum fechado de attribute_type (decisão de modelagem justificada em
-- docs/PADROES_ENEM.md). Nenhuma lista separada por vírgula em nenhum campo.
INSERT OR IGNORE INTO pattern_attributes (id, pattern_id, attribute_type, position, content) VALUES
  -- PAD-01 Razão em Gráfico
  ('fixture-attr-01-clue-1', 'fixture-pat-01', 'frequent_clue', 0, '[PROVISÓRIO] Dois pontos destacados no mesmo eixo.'),
  ('fixture-attr-01-clue-2', 'fixture-pat-01', 'frequent_clue', 1, '[PROVISÓRIO] Pergunta comparativa entre duas colunas do gráfico.'),
  ('fixture-attr-01-phrase-1', 'fixture-pat-01', 'recurring_phrase', 0, '[PROVISÓRIO] "quantas vezes maior"'),
  ('fixture-attr-01-phrase-2', 'fixture-pat-01', 'recurring_phrase', 1, '[PROVISÓRIO] "razão entre"'),
  ('fixture-attr-01-visual-1', 'fixture-pat-01', 'recurring_visual_element', 0, '[PROVISÓRIO] Gráfico de barras com eixo vertical numerado.'),
  ('fixture-attr-01-alt-1', 'fixture-pat-01', 'alternative_strategy', 0, '[PROVISÓRIO] Estimar a razão pela altura relativa das barras antes de calcular.'),
  ('fixture-attr-01-content-1', 'fixture-pat-01', 'required_content', 0, 'Razão e proporção'),
  ('fixture-attr-01-content-2', 'fixture-pat-01', 'required_content', 1, 'Leitura de gráficos'),
  ('fixture-attr-01-prereq-1', 'fixture-pat-01', 'prerequisite_content', 0, 'Operações com números racionais'),
  ('fixture-attr-01-mistake-1', 'fixture-pat-01', 'common_mistake', 0, '[PROVISÓRIO] Inverter numerador e denominador da razão.'),
  ('fixture-attr-01-mistake-2', 'fixture-pat-01', 'common_mistake', 1, '[PROVISÓRIO] Ler o valor na escala errada do eixo.'),
  ('fixture-attr-01-tag-1', 'fixture-pat-01', 'tag', 0, 'grafico'),
  ('fixture-attr-01-tag-2', 'fixture-pat-01', 'tag', 1, 'proporcionalidade'),

  -- PAD-02 Escala
  ('fixture-attr-02-clue-1', 'fixture-pat-02', 'frequent_clue', 0, '[PROVISÓRIO] Uma razão do tipo 1:N aparece na legenda.'),
  ('fixture-attr-02-clue-2', 'fixture-pat-02', 'frequent_clue', 1, '[PROVISÓRIO] Unidades diferentes entre desenho e realidade.'),
  ('fixture-attr-02-phrase-1', 'fixture-pat-02', 'recurring_phrase', 0, '[PROVISÓRIO] "na escala de"'),
  ('fixture-attr-02-phrase-2', 'fixture-pat-02', 'recurring_phrase', 1, '[PROVISÓRIO] "medida real"'),
  ('fixture-attr-02-visual-1', 'fixture-pat-02', 'recurring_visual_element', 0, '[PROVISÓRIO] Planta baixa ou mapa com legenda de escala.'),
  ('fixture-attr-02-alt-1', 'fixture-pat-02', 'alternative_strategy', 0, '[PROVISÓRIO] Montar uma regra de três com as unidades já convertidas.'),
  ('fixture-attr-02-content-1', 'fixture-pat-02', 'required_content', 0, 'Razão e proporção'),
  ('fixture-attr-02-content-2', 'fixture-pat-02', 'required_content', 1, 'Unidades de medida'),
  ('fixture-attr-02-prereq-1', 'fixture-pat-02', 'prerequisite_content', 0, 'Multiplicação e divisão por potências de dez'),
  ('fixture-attr-02-mistake-1', 'fixture-pat-02', 'common_mistake', 0, '[PROVISÓRIO] Esquecer de converter centímetros para metros.'),
  ('fixture-attr-02-mistake-2', 'fixture-pat-02', 'common_mistake', 1, '[PROVISÓRIO] Multiplicar quando o caso pede divisão.'),
  ('fixture-attr-02-tag-1', 'fixture-pat-02', 'tag', 0, 'medidas'),
  ('fixture-attr-02-tag-2', 'fixture-pat-02', 'tag', 1, 'proporcionalidade'),

  -- PAD-03 Porcentagem Direta
  ('fixture-attr-03-clue-1', 'fixture-pat-03', 'frequent_clue', 0, '[PROVISÓRIO] Um único percentual aplicado a um único valor.'),
  ('fixture-attr-03-clue-2', 'fixture-pat-03', 'frequent_clue', 1, '[PROVISÓRIO] Nenhum acréscimo ou desconto sucessivo no enunciado.'),
  ('fixture-attr-03-phrase-1', 'fixture-pat-03', 'recurring_phrase', 0, '[PROVISÓRIO] "corresponde a"'),
  ('fixture-attr-03-phrase-2', 'fixture-pat-03', 'recurring_phrase', 1, '[PROVISÓRIO] "do total de"'),
  ('fixture-attr-03-visual-1', 'fixture-pat-03', 'recurring_visual_element', 0, '[PROVISÓRIO] Tabela simples com valores absolutos e percentuais.'),
  ('fixture-attr-03-alt-1', 'fixture-pat-03', 'alternative_strategy', 0, '[PROVISÓRIO] Calcular 10% e ajustar por múltiplos, quando o percentual é redondo.'),
  ('fixture-attr-03-content-1', 'fixture-pat-03', 'required_content', 0, 'Porcentagem'),
  ('fixture-attr-03-content-2', 'fixture-pat-03', 'required_content', 1, 'Razão e proporção'),
  ('fixture-attr-03-prereq-1', 'fixture-pat-03', 'prerequisite_content', 0, 'Operações com números decimais'),
  ('fixture-attr-03-mistake-1', 'fixture-pat-03', 'common_mistake', 0, '[PROVISÓRIO] Somar o percentual em vez de aplicá-lo sobre o valor.'),
  ('fixture-attr-03-mistake-2', 'fixture-pat-03', 'common_mistake', 1, '[PROVISÓRIO] Usar o valor final como base quando a base é o inicial.'),
  ('fixture-attr-03-tag-1', 'fixture-pat-03', 'tag', 0, 'porcentagem'),
  ('fixture-attr-03-tag-2', 'fixture-pat-03', 'tag', 1, 'proporcionalidade'),

  -- PAD-04 Mediana e Frequência
  ('fixture-attr-04-clue-1', 'fixture-pat-04', 'frequent_clue', 0, '[PROVISÓRIO] Tabela com coluna de frequência.'),
  ('fixture-attr-04-clue-2', 'fixture-pat-04', 'frequent_clue', 1, '[PROVISÓRIO] Pergunta por valor central ou mais frequente.'),
  ('fixture-attr-04-phrase-1', 'fixture-pat-04', 'recurring_phrase', 0, '[PROVISÓRIO] "valor mediano"'),
  ('fixture-attr-04-phrase-2', 'fixture-pat-04', 'recurring_phrase', 1, '[PROVISÓRIO] "número de ocorrências"'),
  ('fixture-attr-04-visual-1', 'fixture-pat-04', 'recurring_visual_element', 0, '[PROVISÓRIO] Tabela de frequência com totais na última linha.'),
  ('fixture-attr-04-alt-1', 'fixture-pat-04', 'alternative_strategy', 0, '[PROVISÓRIO] Escrever a sequência ordenada completa quando a amostra é pequena.'),
  ('fixture-attr-04-content-1', 'fixture-pat-04', 'required_content', 0, 'Estatística descritiva'),
  ('fixture-attr-04-content-2', 'fixture-pat-04', 'required_content', 1, 'Leitura de tabelas'),
  ('fixture-attr-04-prereq-1', 'fixture-pat-04', 'prerequisite_content', 0, 'Ordenação de números'),
  ('fixture-attr-04-mistake-1', 'fixture-pat-04', 'common_mistake', 0, '[PROVISÓRIO] Confundir mediana com média.'),
  ('fixture-attr-04-mistake-2', 'fixture-pat-04', 'common_mistake', 1, '[PROVISÓRIO] Esquecer de repetir os valores conforme a frequência.'),
  ('fixture-attr-04-tag-1', 'fixture-pat-04', 'tag', 0, 'estatistica'),
  ('fixture-attr-04-tag-2', 'fixture-pat-04', 'tag', 1, 'tabela'),

  -- PAD-05 Projeção Ortogonal
  ('fixture-attr-05-clue-1', 'fixture-pat-05', 'frequent_clue', 0, '[PROVISÓRIO] Alternativas com silhuetas parecidas entre si.'),
  ('fixture-attr-05-clue-2', 'fixture-pat-05', 'frequent_clue', 1, '[PROVISÓRIO] Sólido montado por blocos ou cubos.'),
  ('fixture-attr-05-phrase-1', 'fixture-pat-05', 'recurring_phrase', 0, '[PROVISÓRIO] "vista superior"'),
  ('fixture-attr-05-phrase-2', 'fixture-pat-05', 'recurring_phrase', 1, '[PROVISÓRIO] "observador que olha de frente"'),
  ('fixture-attr-05-visual-1', 'fixture-pat-05', 'recurring_visual_element', 0, '[PROVISÓRIO] Desenho em perspectiva de um sólido composto.'),
  ('fixture-attr-05-alt-1', 'fixture-pat-05', 'alternative_strategy', 0, '[PROVISÓRIO] Contar quantos blocos aparecem em cada coluna da vista pedida.'),
  ('fixture-attr-05-content-1', 'fixture-pat-05', 'required_content', 0, 'Geometria espacial'),
  ('fixture-attr-05-content-2', 'fixture-pat-05', 'required_content', 1, 'Geometria plana'),
  ('fixture-attr-05-prereq-1', 'fixture-pat-05', 'prerequisite_content', 0, 'Reconhecimento de sólidos geométricos'),
  ('fixture-attr-05-mistake-1', 'fixture-pat-05', 'common_mistake', 0, '[PROVISÓRIO] Trocar a vista lateral pela vista de frente.'),
  ('fixture-attr-05-mistake-2', 'fixture-pat-05', 'common_mistake', 1, '[PROVISÓRIO] Considerar profundidade numa projeção que não a mostra.'),
  ('fixture-attr-05-tag-1', 'fixture-pat-05', 'tag', 0, 'geometria'),
  ('fixture-attr-05-tag-2', 'fixture-pat-05', 'tag', 1, 'vistas');

-- Relações dirigidas entre padrões. Convenção documentada em
-- docs/PADROES_ENEM.md: a aresta vai DO padrão da ficha PARA o padrão
-- relacionado — 'prerequisite' significa "o destino é pré-requisito da
-- origem". Nunca há auto-relação (CHECK na migration) nem duplicidade da
-- mesma tripla (UNIQUE na migration). As relações usam o ID estável, nunca
-- slug/code, para que renomear um slug não quebre nenhuma aresta.
INSERT OR IGNORE INTO pattern_relations (id, from_pattern_id, to_pattern_id, relation_type) VALUES
  ('fixture-rel-01', 'fixture-pat-01', 'fixture-pat-03', 'related'),
  ('fixture-rel-02', 'fixture-pat-01', 'fixture-pat-02', 'prerequisite'),
  ('fixture-rel-03', 'fixture-pat-03', 'fixture-pat-01', 'often_confused_with'),
  ('fixture-rel-04', 'fixture-pat-02', 'fixture-pat-01', 'related'),
  ('fixture-rel-05', 'fixture-pat-04', 'fixture-pat-03', 'related'),
  ('fixture-rel-06', 'fixture-pat-05', 'fixture-pat-02', 'prerequisite');
