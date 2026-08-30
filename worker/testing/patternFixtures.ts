/* CONTEÚDO TÉCNICO PROVISÓRIO PARA DESENVOLVIMENTO LOCAL — NÃO PUBLICAR.
   Espelho, em TypeScript, do conteúdo conceitual de
   scripts/fixtures/patterns-fixtures.local.sql — usado só pelos testes
   unitários (worker/testing/*.test.ts) via FakeD1Database.

   Os cinco nomes são os citados literalmente no Documento Mestre (seção 3 da
   ordem da Sprint 6). Nenhuma linha de student_pattern_progress é semeada
   aqui: progresso pertence ao aluno e só nasce de evidência real — nos
   testes, quem precisa de progresso o insere explicitamente. */

export const PROVISIONAL_MARK = "[CONTEÚDO TÉCNICO PROVISÓRIO PARA DESENVOLVIMENTO LOCAL — NÃO PUBLICAR]";

export interface TestPatternFixture {
  id: string;
  code: string;
  slug: string;
  name: string;
  editorialStatus: string;
  requiredContents: string[];
  tags: string[];
}

export const TEST_PATTERNS: TestPatternFixture[] = [
  {
    id: "fixture-pat-01",
    code: "PAD-01",
    slug: "razao-em-grafico",
    name: "Razão em Gráfico",
    editorialStatus: "published",
    requiredContents: ["Razão e proporção", "Leitura de gráficos"],
    tags: ["grafico", "proporcionalidade"],
  },
  {
    id: "fixture-pat-02",
    code: "PAD-02",
    slug: "escala",
    name: "Escala",
    editorialStatus: "published",
    requiredContents: ["Razão e proporção", "Unidades de medida"],
    tags: ["medidas", "proporcionalidade"],
  },
  {
    id: "fixture-pat-03",
    code: "PAD-03",
    slug: "porcentagem-direta",
    name: "Porcentagem Direta",
    editorialStatus: "published",
    requiredContents: ["Porcentagem", "Razão e proporção"],
    tags: ["porcentagem", "proporcionalidade"],
  },
  {
    id: "fixture-pat-04",
    code: "PAD-04",
    slug: "mediana-e-frequencia",
    name: "Mediana e Frequência",
    editorialStatus: "published",
    requiredContents: ["Estatística descritiva", "Leitura de tabelas"],
    tags: ["estatistica", "tabela"],
  },
  {
    id: "fixture-pat-05",
    code: "PAD-05",
    slug: "projecao-ortogonal",
    name: "Projeção Ortogonal",
    editorialStatus: "published",
    requiredContents: ["Geometria espacial", "Geometria plana"],
    tags: ["geometria", "vistas"],
  },
];

/** Um sexto padrão deliberadamente NÃO publicado — existe só para provar que
 *  rascunho editorial nunca aparece no catálogo e que sua ficha responde o
 *  mesmo 404 de um slug inexistente. */
export const TEST_DRAFT_PATTERN: TestPatternFixture = {
  id: "fixture-pat-06",
  code: "PAD-06",
  slug: "rascunho-nao-publicado",
  name: "Rascunho Não Publicado",
  editorialStatus: "draft",
  requiredContents: ["Razão e proporção"],
  tags: ["proporcionalidade"],
};

export const TEST_RELATIONS = [
  { id: "fixture-rel-01", from: "fixture-pat-01", to: "fixture-pat-03", type: "related" },
  { id: "fixture-rel-02", from: "fixture-pat-01", to: "fixture-pat-02", type: "prerequisite" },
  { id: "fixture-rel-03", from: "fixture-pat-03", to: "fixture-pat-01", type: "often_confused_with" },
  { id: "fixture-rel-04", from: "fixture-pat-02", to: "fixture-pat-01", type: "related" },
  { id: "fixture-rel-05", from: "fixture-pat-04", to: "fixture-pat-03", type: "related" },
  { id: "fixture-rel-06", from: "fixture-pat-05", to: "fixture-pat-02", type: "prerequisite" },
] as const;

interface SqliteLike {
  prepare(sql: string): { run(...params: unknown[]): unknown };
}

function insertPattern(sqlite: SqliteLike, pattern: TestPatternFixture): void {
  sqlite
    .prepare(
      `INSERT INTO patterns
         (id, code, slug, name, recognition_phrase, description, main_strategy,
          introductory_example, strategic_summary, editorial_status, is_local_fixture)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
    )
    .run(
      pattern.id,
      pattern.code,
      pattern.slug,
      pattern.name,
      `${PROVISIONAL_MARK} Frase de reconhecimento de ${pattern.name}.`,
      `${PROVISIONAL_MARK} Descrição técnica de ${pattern.name}.`,
      `${PROVISIONAL_MARK} Estratégia principal de ${pattern.name}.`,
      `${PROVISIONAL_MARK} Exemplo introdutório de ${pattern.name}.`,
      `${PROVISIONAL_MARK} Resumo estratégico de ${pattern.name}.`,
      pattern.editorialStatus
    );

  const attributes: Array<{ type: string; content: string }> = [
    { type: "frequent_clue", content: `[PROVISÓRIO] Pista frequente de ${pattern.name}.` },
    { type: "recurring_phrase", content: `[PROVISÓRIO] Expressão recorrente de ${pattern.name}.` },
    { type: "recurring_visual_element", content: `[PROVISÓRIO] Elemento visual de ${pattern.name}.` },
    { type: "alternative_strategy", content: `[PROVISÓRIO] Estratégia alternativa de ${pattern.name}.` },
    { type: "prerequisite_content", content: `[PROVISÓRIO] Pré-requisito de ${pattern.name}.` },
    { type: "common_mistake", content: `[PROVISÓRIO] Erro frequente em ${pattern.name}.` },
    ...pattern.requiredContents.map((content) => ({ type: "required_content", content })),
    ...pattern.tags.map((content) => ({ type: "tag", content })),
  ];

  attributes.forEach((attribute, index) => {
    sqlite
      .prepare(
        "INSERT INTO pattern_attributes (id, pattern_id, attribute_type, position, content) VALUES (?, ?, ?, ?, ?)"
      )
      .run(`${pattern.id}-attr-${index}`, pattern.id, attribute.type, index, attribute.content);
  });
}

/** Semeia os cinco padrões publicados + o rascunho não publicado + as
 *  relações entre eles. Determinístico: mesmos IDs a cada chamada. */
export function seedPatterns(sqlite: SqliteLike): void {
  for (const pattern of TEST_PATTERNS) insertPattern(sqlite, pattern);
  insertPattern(sqlite, TEST_DRAFT_PATTERN);
  for (const relation of TEST_RELATIONS) {
    sqlite
      .prepare("INSERT INTO pattern_relations (id, from_pattern_id, to_pattern_id, relation_type) VALUES (?, ?, ?, ?)")
      .run(relation.id, relation.from, relation.to, relation.type);
  }
}
