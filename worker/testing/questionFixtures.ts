/* Espelho de teste do Banco de Questões — Sprint 7 v1.0. Usado só pelos
   testes unitários (worker/testing/*.test.ts) via FakeD1Database, para
   semear questões completas (5 alternativas, DNA completo, padrão
   principal) prontas para exercitar o workflow sem repetir SQL em cada
   teste. Nunca usado por código de produção. */

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
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
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
      version
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
