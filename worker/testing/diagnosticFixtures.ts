/* CONTEÚDO TÉCNICO PROVISÓRIO — NÃO PUBLICAR.
   Espelho, em TypeScript, do conteúdo conceitual de
   scripts/fixtures/diagnostic-fixtures.local.sql — usado só pelos testes
   unitários (worker/testing/*.test.ts) via FakeD1Database. Um conjunto
   menor (3 questões) é suficiente para exercitar as mesmas dimensões
   (reconhecimento configurado/ausente, quatro camadas de ajuda) sem
   duplicar as 12 questões completas aqui. */

export const TEST_QUESTIONS = [
  {
    id: "test-q1",
    prompt: "[PROVISÓRIO] Questão de teste 1 — com reconhecimento.",
    position: 0,
    options: [
      { id: "test-q1-a", position: 0, text: "Opção A", isCorrect: true },
      { id: "test-q1-b", position: 1, text: "Opção B", isCorrect: false },
    ],
    recognitionOptions: [
      { id: "test-q1-r-a", position: 0, text: "Padrão A", isCorrect: true },
      { id: "test-q1-r-b", position: 1, text: "Padrão B", isCorrect: false },
    ],
    helpLayers: {
      1: "[PROVISÓRIO] Pista da questão 1.",
      2: "[PROVISÓRIO] Padrão da questão 1.",
      3: "[PROVISÓRIO] Estratégia da questão 1.",
      4: "[PROVISÓRIO] Resolução da questão 1.",
    },
  },
  {
    id: "test-q2",
    prompt: "[PROVISÓRIO] Questão de teste 2 — sem reconhecimento.",
    position: 1,
    options: [
      { id: "test-q2-a", position: 0, text: "Opção A", isCorrect: false },
      { id: "test-q2-b", position: 1, text: "Opção B", isCorrect: true },
    ],
    recognitionOptions: [],
    helpLayers: {
      1: "[PROVISÓRIO] Pista da questão 2.",
      2: "[PROVISÓRIO] Padrão da questão 2.",
      3: "[PROVISÓRIO] Estratégia da questão 2.",
      4: "[PROVISÓRIO] Resolução da questão 2.",
    },
  },
  {
    id: "test-q3",
    prompt: "[PROVISÓRIO] Questão de teste 3 — sem reconhecimento.",
    position: 2,
    options: [
      { id: "test-q3-a", position: 0, text: "Opção A", isCorrect: true },
      { id: "test-q3-b", position: 1, text: "Opção B", isCorrect: false },
    ],
    recognitionOptions: [],
    helpLayers: {
      1: "[PROVISÓRIO] Pista da questão 3.",
      2: "[PROVISÓRIO] Padrão da questão 3.",
      3: "[PROVISÓRIO] Estratégia da questão 3.",
      4: "[PROVISÓRIO] Resolução da questão 3.",
    },
  },
] as const;

interface SqliteLike {
  exec(sql: string): void;
  prepare(sql: string): { run(...params: unknown[]): unknown };
}

/** Insere TEST_QUESTIONS diretamente via node:sqlite (FakeD1Database.sqlite)
 *  — mais simples e rápido que passar pelo wrapper D1 para um setup de teste. */
export function seedDiagnosticFixtures(sqlite: SqliteLike): void {
  for (const question of TEST_QUESTIONS) {
    sqlite
      .prepare("INSERT INTO diagnostic_questions (id, prompt, position) VALUES (?, ?, ?)")
      .run(question.id, question.prompt, question.position);

    for (const option of question.options) {
      sqlite
        .prepare(
          "INSERT INTO diagnostic_question_options (id, question_id, position, text, is_correct) VALUES (?, ?, ?, ?, ?)"
        )
        .run(option.id, question.id, option.position, option.text, option.isCorrect ? 1 : 0);
    }

    for (const option of question.recognitionOptions) {
      sqlite
        .prepare(
          "INSERT INTO diagnostic_question_recognition_options (id, question_id, position, text, is_correct) VALUES (?, ?, ?, ?, ?)"
        )
        .run(option.id, question.id, option.position, option.text, option.isCorrect ? 1 : 0);
    }

    for (const [layer, content] of Object.entries(question.helpLayers)) {
      sqlite
        .prepare("INSERT INTO diagnostic_question_help_layers (question_id, layer, content) VALUES (?, ?, ?)")
        .run(question.id, Number(layer), content);
    }
  }
}
