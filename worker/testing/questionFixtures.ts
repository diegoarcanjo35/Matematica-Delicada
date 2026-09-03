/* Espelho de teste do Banco de Questões — Sprint 7 v1.0. Usado só pelos
   testes unitários (worker/testing/*.test.ts) via FakeD1Database, para
   semear questões completas (5 alternativas, DNA completo, padrão
   principal) prontas para exercitar o workflow sem repetir SQL em cada
   teste. Nunca usado por código de produção.

   Sprint 16 v1.1 — `isLocalFixture` (default `false`, ou seja
   `is_local_fixture = 0`) passou a ser explícito. Antes desta sprint a
   coluna era sempre gravada como 1 aqui, mas nenhuma leitura de produção
   filtrava por ela — o valor não tinha efeito algum sobre o que os testes
   exercitavam. Agora que a camada de dados endurece leituras destinadas ao
   aluno com `is_local_fixture = 0` (ver questionRepository.ts,
   dailyTrainingRepository.ts, errorNotebookRepository.ts), o padrão deste
   helper passou a representar "questão real" — o mesmo papel que ele
   sempre desempenhou nos testes existentes (uma questão de exemplo para o
   aluno treinar). Testes que precisam especificamente de uma questão
   marcada como fixture local (para provar que ela NUNCA é servida) passam
   `isLocalFixture: true` explicitamente — ver
   worker/testing/questionFixtureIsolation.test.ts. */

interface SqliteLike {
  prepare(sql: string): { run(...params: unknown[]): unknown };
}

export const FIXTURE_MARK = "FIXTURE TÉCNICA LOCAL — NÃO PUBLICAR — NÃO É QUESTÃO OFICIAL";

export interface SeedQuestionOptions {
  id?: string;
  code?: string;
  status?: string;
  version?: number;
  autorId?: string | null;
  revisorId?: string | null;
  patternId?: string;
  secondaryPatternIds?: string[];
  titularDireitos?: string | null;
  baseLicenca?: string | null;
  enunciado?: string;
  fingerprint?: string;
  withAlternatives?: boolean;
  withDna?: boolean;
  withPrincipalPattern?: boolean;
  /** Sprint 16 v1.1 — default `false` (`is_local_fixture = 0`, "questão
   *  real" para efeitos do teste). `true` semeia com `is_local_fixture = 1`
   *  — só para testes que provam isolamento de fixture (ver header). */
  isLocalFixture?: boolean;
}

/** Semeia uma questão "pronta para revisão" por padrão (5 alternativas
 *  válidas, DNA completo, padrão principal) — testes que querem provar um
 *  bloqueio específico passam `withAlternatives:false`/`withDna:false`/
 *  `withPrincipalPattern:false` para semear uma questão INCOMPLETA de
 *  propósito. */
export function seedQuestion(sqlite: SqliteLike, options: SeedQuestionOptions = {}): string {
  const id = options.id ?? `test-q-${Math.random().toString(36).slice(2, 10)}`;
  const code = options.code ?? `TEST-${id.slice(-6).toUpperCase()}`;
  const status = options.status ?? "draft";
  const version = options.version ?? 1;

  sqlite
    .prepare(
      `INSERT INTO questions
         (id, code, enunciado, resolucao_comentada, conteudo, subconteudo, habilidade, competencia,
          dificuldade, origem, tempo_estimado_segundos, tipo_calculo, necessita_calculadora,
          editorial_status, autor_id, revisor_id, titular_direitos, base_licenca, texto_atribuicao,
          fingerprint, version, is_local_fixture)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      code,
      options.enunciado ?? `${FIXTURE_MARK}. Enunciado técnico de teste ${id}.`,
      `${FIXTURE_MARK}. Resolução técnica de teste.`,
      "Conteúdo de teste",
      "Subconteúdo de teste",
      "Habilidade de teste",
      "Competência de teste",
      "media",
      "autoral",
      90,
      "misto",
      0,
      status,
      options.autorId ?? null,
      options.revisorId ?? null,
      options.titularDireitos ?? "Fixture técnica interna",
      options.baseLicenca ?? "Uso interno de desenvolvimento",
      null,
      options.fingerprint ?? `fingerprint-${id}`,
      version,
      options.isLocalFixture ? 1 : 0
    );

  if (options.withAlternatives !== false) {
    const letters = ["A", "B", "C", "D", "E"];
    letters.forEach((letter, index) => {
      sqlite
        .prepare(
          `INSERT INTO question_alternatives (id, question_id, letter, text, is_correct, position) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(`${id}-alt-${letter}`, id, letter, `Alternativa ${letter} de teste`, letter === "B" ? 1 : 0, index);
    });
  }

  if (options.withDna !== false) {
    sqlite
      .prepare(
        `INSERT INTO question_dna (question_id, pista, estrategia, pegadinha, conteudo_apoio, resolucao, atalho, aprendizado_erro)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, "Pista de teste", "Estratégia de teste", "Pegadinha de teste", "Conteúdo de apoio de teste", "Resolução de teste", null, "Aprendizado de teste");
  }

  if (options.withPrincipalPattern !== false && options.patternId) {
    sqlite
      .prepare(`INSERT INTO question_patterns (id, question_id, pattern_id, role) VALUES (?, ?, ?, 'principal')`)
      .run(`${id}-pat-principal`, id, options.patternId);
  }

  (options.secondaryPatternIds ?? []).forEach((patternId, index) => {
    sqlite
      .prepare(`INSERT INTO question_patterns (id, question_id, pattern_id, role) VALUES (?, ?, ?, 'secundario')`)
      .run(`${id}-pat-sec-${index}`, id, patternId);
  });

  return id;
}
