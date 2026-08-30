/* Serviço do Banco de Questões — Sprint 7 v1.0.

   Orquestra validação (worker/src/lib/questionsValidation.ts), RBAC
   (worker/src/lib/rbac.ts) e atomicidade (db.batch()). Nunca deixa erro cru
   do banco vazar para a rota — todo resultado é um DTO tipado com motivo
   fechado de falha. Transição + histórico SEMPRE no mesmo db.batch()
   (seção 6 da ordem) — ver buildTransitionStatement +
   buildConditionalHistoryStatement em questionRepository.ts. */

import { computeQuestionFingerprint } from "../lib/fingerprint";
import {
  allImagesHaveAlt,
  hasPrincipalPattern,
  hasRequiredRightsForPublication,
  isDnaComplete,
  QUESTION_TRANSITIONS,
  TRANSITION_MIN_ROLE,
  transitionKey,
  validateAlternativeSet,
  validateAlternativeSetForPatch,
  validatePatternLinks,
  validateQuestionDna,
  validateQuestionImages,
  validateTags,
  type AlternativeInput,
  type QuestionDifficulty,
  type QuestionDnaInput,
  type QuestionEditorialStatus,
  type QuestionImageInput,
  type QuestionOrigin,
  type QuestionPatternInput,
} from "../lib/questionsValidation";
import type { EditorialRole } from "../lib/rbac";
import { roleSatisfies } from "../lib/rbac";
import {
  buildConditionalHistoryStatement,
  buildDeleteAlternativesStatement,
  buildDeleteImagesStatement,
  buildDeletePatternLinksStatement,
  buildDeleteTagsStatement,
  buildGuardedInsertAlternativeStatement,
  buildGuardedInsertImageStatement,
  buildGuardedInsertPatternLinkStatement,
  buildGuardedInsertTagStatement,
  buildGuardedUpsertDnaStatement,
  buildInsertAlternativeStatement,
  buildInsertImageStatement,
  buildInsertPatternLinkStatement,
  buildInsertQuestionStatement,
  buildInsertTagStatement,
  buildTransitionStatement,
  buildUpdateQuestionCoreStatement,
  buildUpsertDnaStatement,
  countQuestions,
  findDna,
  findQuestionByCode,
  findQuestionById,
  findQuestionsByFingerprint,
  listAlternatives,
  listAlternativesForQuestions,
  listImages,
  listImagesForQuestions,
  listPatternLinksForQuestions,
  listPatternsForQuestion,
  listQuestions,
  listQuestionsByIds,
  listTags,
  type QuestionAlternativeRow,
  type QuestionDnaRow,
  type QuestionImageRow,
  type QuestionListFilters,
  type QuestionPatternRow,
  type QuestionRow,
  type QuestionTagRow,
} from "../repositories/questionRepository";

function newId(): string {
  return crypto.randomUUID();
}

/** Sprint 7 v1.1, Correção C — o algoritmo real vive em
 *  worker/src/lib/fingerprint.ts (documentado e testado diretamente ali;
 *  ver worker/testing/fingerprint.test.ts). Este helper só adapta o formato
 *  de alternativas já validado (`AlternativeInput[]`) para a assinatura
 *  genérica de `computeQuestionFingerprint`. */
async function computeFingerprint(enunciado: string, alternatives: AlternativeInput[]): Promise<string> {
  return computeQuestionFingerprint(
    enunciado,
    alternatives.map((alt) => ({ letter: alt.letter, text: alt.text, isCorrect: alt.isCorrect }))
  );
}

export interface QuestionInput {
  code: string;
  enunciado: string;
  resolucaoComentada: string;
  conteudo: string;
  subconteudo: string;
  habilidade: string;
  competencia: string;
  dificuldade: QuestionDifficulty;
  origem: QuestionOrigin;
  prova: string | null;
  ano: number | null;
  tempoEstimadoSegundos: number | null;
  tipoCalculo: string;
  necessitaCalculadora: boolean;
  titularDireitos: string | null;
  baseLicenca: string | null;
  textoAtribuicao: string | null;
  alternativas: AlternativeInput[];
  dna: QuestionDnaInput;
  padroes: QuestionPatternInput[];
  tags: string[];
  imagens: QuestionImageInput[];
}

export interface MutationResult<T> {
  ok: boolean;
  value?: T;
  notFound?: boolean;
  conflict?: boolean;
  fieldErrors?: Record<string, string>;
  forbidden?: boolean;
}

async function validatePatternIdsExist(db: D1Database, patternIds: string[]): Promise<boolean> {
  if (patternIds.length === 0) return true;
  const placeholders = patternIds.map(() => "?").join(", ");
  const result = await db
    .prepare(`SELECT id FROM patterns WHERE id IN (${placeholders})`)
    .bind(...patternIds)
    .all<{ id: string }>();
  const found = new Set((result.results ?? []).map((r) => r.id));
  return patternIds.every((id) => found.has(id));
}

/** Cria uma questão nova em `draft`. Sempre exige `alternativas`+`dna`
 *  presentes no corpo (mesmo que incompletos no conteúdo — só a completude
 *  é exigida mais tarde, antes de revisão/aprovação). */
export async function createQuestion(
  db: D1Database,
  actorUserId: string,
  input: Partial<QuestionInput>
): Promise<MutationResult<{ id: string }>> {
  const fieldErrors: Record<string, string> = {};

  if (!input.code || typeof input.code !== "string") fieldErrors.code = "Código editorial é obrigatório.";
  if (!input.enunciado || typeof input.enunciado !== "string" || input.enunciado.trim().length === 0) {
    fieldErrors.enunciado = "Enunciado é obrigatório.";
  }
  if (!input.dificuldade) fieldErrors.dificuldade = "Dificuldade é obrigatória.";
  if (!input.origem) fieldErrors.origem = "Origem/tipo é obrigatório.";

  const altResult = validateAlternativeSet(input.alternativas ?? []);
  if (!altResult.ok) fieldErrors.alternativas = altResult.error!;

  const dnaResult = validateQuestionDna(input.dna ?? {});
  if (!dnaResult.ok) fieldErrors.dna = dnaResult.error!;

  const patternsResult = validatePatternLinks(input.padroes ?? []);
  if (!patternsResult.ok) fieldErrors.padroes = patternsResult.error!;

  const tagsResult = validateTags(input.tags ?? []);
  if (!tagsResult.ok) fieldErrors.tags = tagsResult.error!;

  const imagesResult = validateQuestionImages(input.imagens ?? []);
  if (!imagesResult.ok) fieldErrors.imagens = imagesResult.error!;

  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors };

  if (patternsResult.value!.length > 0) {
    const patternsExist = await validatePatternIdsExist(
      db,
      patternsResult.value!.map((p) => p.patternId)
    );
    if (!patternsExist) return { ok: false, fieldErrors: { padroes: "Um ou mais padrões informados não existem." } };
  }

  const existingCode = await findQuestionByCode(db, input.code!);
  if (existingCode) return { ok: false, fieldErrors: { code: "Já existe uma questão com este código." } };

  const fingerprint = await computeFingerprint(input.enunciado!, altResult.value!);
  const duplicates = await findQuestionsByFingerprint(db, fingerprint);
  if (duplicates.length > 0) {
    return { ok: false, fieldErrors: { enunciado: "Já existe uma questão com enunciado equivalente (fingerprint duplicada)." } };
  }

  const id = newId();
  const statements = [
    buildInsertQuestionStatement(db, {
      id,
      code: input.code!,
      enunciado: input.enunciado!,
      resolucaoComentada: input.resolucaoComentada ?? "",
      conteudo: input.conteudo ?? "",
      subconteudo: input.subconteudo ?? "",
      habilidade: input.habilidade ?? "",
      competencia: input.competencia ?? "",
      dificuldade: input.dificuldade!,
      origem: input.origem!,
      prova: input.prova ?? null,
      ano: input.ano ?? null,
      tempoEstimadoSegundos: input.tempoEstimadoSegundos ?? null,
      tipoCalculo: (input.tipoCalculo as never) ?? "misto",
      necessitaCalculadora: input.necessitaCalculadora ? 1 : 0,
      autorId: actorUserId,
      titularDireitos: input.titularDireitos ?? null,
      baseLicenca: input.baseLicenca ?? null,
      textoAtribuicao: input.textoAtribuicao ?? null,
      fingerprint,
      isLocalFixture: 0,
    }),
    buildUpsertDnaStatement(db, id, dnaResult.value!),
  ];
  altResult.value!.forEach((alt, index) => statements.push(buildInsertAlternativeStatement(db, id, newId(), alt, index)));
  patternsResult.value!.forEach((link) => statements.push(buildInsertPatternLinkStatement(db, id, newId(), link)));
  tagsResult.value!.forEach((tag, index) => statements.push(buildInsertTagStatement(db, id, newId(), tag, index)));
  imagesResult.value!.forEach((image) => statements.push(buildInsertImageStatement(db, id, newId(), image)));
  statements.push(
    buildConditionalHistoryStatement(db, {
      id: newId(),
      questionId: id,
      userId: actorUserId,
      action: "created",
      fromStatus: null,
      toStatus: "draft",
      versionAfter: 1,
      metadata: null,
    })
  );

  await db.batch(statements);
  return { ok: true, value: { id } };
}

/** Campos escalares não-anuláveis do PATCH — enviar `null` para qualquer um
 *  destes é 400, nunca gravado (Correção A, seção 2 da ordem v1.1). `code`
 *  fica de fora: o PATCH nunca altera o código editorial (imutável após a
 *  criação), então não faz parte nem do grupo anulável nem deste. */
const NON_NULLABLE_SCALAR_FIELDS = [
  "enunciado",
  "resolucaoComentada",
  "conteudo",
  "subconteudo",
  "habilidade",
  "competencia",
  "dificuldade",
  "origem",
  "tipoCalculo",
  "necessitaCalculadora",
] as const;

/** `true` se a chave está presente no corpo (mesmo que o valor seja
 *  `null`) — `undefined` só ocorre quando a chave está genuinamente AUSENTE
 *  do JSON recebido (nunca quando o cliente mandou `null` de propósito). */
function isProvided<T extends object>(input: T, key: keyof T): boolean {
  return input[key] !== undefined;
}

/** Edita o conteúdo de uma questão em `draft`/`changes_requested` — PATCH
 *  PARCIAL de verdade (Sprint 7 v1.1, Correção A): um campo/coleção AUSENTE
 *  do corpo preserva o valor atual; uma coleção enviada como `[]` limpa
 *  explicitamente; `null` só é aceito nos campos anuláveis
 *  (`NULLABLE_QUESTION_SCALAR_FIELDS`), senão é 400 sem gravar nada.
 *  Publicada NUNCA é editável (seção 6 da ordem) — o guard SQL do UPDATE já
 *  restringe isso, e aqui é verificado ANTES também, para devolver um erro
 *  específico em vez de um 409 genérico de versão quando o problema é outro.
 *
 *  Atomicidade: o UPDATE escalar roda SEMPRE (é o próprio "core" da operação
 *  e o único jeito de expressar o guard de versão condicionado num único
 *  statement) — isso garante que o lote NUNCA fica vazio mesmo quando
 *  nenhuma coleção foi enviada, então nunca há necessidade de um
 *  `db.batch([])` dinâmico vazio (a preocupação da seção 2 da ordem v1.1).
 *  Só as coleções EXPLICITAMENTE presentes no corpo entram no lote (DELETE +
 *  INSERTs guardados pela MESMA versão-alvo do UPDATE escalar) — uma coleção
 *  ausente não gera nenhum statement, então nunca é apagada por omissão. */
export async function updateQuestion(
  db: D1Database,
  actorUserId: string,
  questionId: string,
  expectedVersion: number,
  input: Partial<QuestionInput>
): Promise<MutationResult<{ id: string }>> {
  const before = await findQuestionById(db, questionId);
  if (!before) return { ok: false, notFound: true };

  if (before.editorial_status === "published") {
    return { ok: false, fieldErrors: { editorial_status: "Questão publicada não pode ser editada nesta sprint — arquive e crie uma revisão futura." } };
  }
  if (before.editorial_status !== "draft" && before.editorial_status !== "changes_requested") {
    return { ok: false, fieldErrors: { editorial_status: "Questão não está num status editável." } };
  }

  const fieldErrors: Record<string, string> = {};

  // `null` explícito só é aceito nos campos anuláveis — verificado ANTES de
  // qualquer outra validação/consulta, para nunca escrever nada quando isto falha.
  for (const field of NON_NULLABLE_SCALAR_FIELDS) {
    if (isProvided(input, field) && (input as Record<string, unknown>)[field] === null) {
      fieldErrors[field] = "Este campo não pode ser nulo.";
    }
  }
  // Coleções também não são anuláveis — `null` é rejeitado; `[]` é a forma
  // válida de limpar.
  for (const field of ["alternativas", "dna", "padroes", "tags", "imagens"] as const) {
    if (isProvided(input, field) && (input as Record<string, unknown>)[field] === null) {
      fieldErrors[field] = "Este campo não pode ser nulo — envie um array vazio para limpar.";
    }
  }
  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors };

  const enunciadoProvided = isProvided(input, "enunciado");
  if (enunciadoProvided && input.enunciado!.trim().length === 0) fieldErrors.enunciado = "Enunciado não pode ser vazio.";

  const alternativesProvided = isProvided(input, "alternativas");
  const altResult = alternativesProvided ? validateAlternativeSetForPatch(input.alternativas) : null;
  if (altResult && !altResult.ok) fieldErrors.alternativas = altResult.error!;

  const dnaProvided = isProvided(input, "dna");
  const dnaResult = dnaProvided ? validateQuestionDna(input.dna) : null;
  if (dnaResult && !dnaResult.ok) fieldErrors.dna = dnaResult.error!;

  const patternsProvided = isProvided(input, "padroes");
  const patternsResult = patternsProvided ? validatePatternLinks(input.padroes) : null;
  if (patternsResult && !patternsResult.ok) fieldErrors.padroes = patternsResult.error!;

  const tagsProvided = isProvided(input, "tags");
  const tagsResult = tagsProvided ? validateTags(input.tags) : null;
  if (tagsResult && !tagsResult.ok) fieldErrors.tags = tagsResult.error!;

  const imagesProvided = isProvided(input, "imagens");
  const imagesResult = imagesProvided ? validateQuestionImages(input.imagens) : null;
  if (imagesResult && !imagesResult.ok) fieldErrors.imagens = imagesResult.error!;

  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors };

  if (patternsResult?.value && patternsResult.value.length > 0) {
    const patternsExist = await validatePatternIdsExist(db, patternsResult.value.map((p) => p.patternId));
    if (!patternsExist) return { ok: false, fieldErrors: { padroes: "Um ou mais padrões informados não existem." } };
  }

  // Estado EFETIVO após o PATCH (mesclando o que foi enviado com o que já
  // existia) — usado tanto para o fingerprint (Correção C: depende de
  // enunciado + alternativas, então precisa do conjunto EFETIVO de
  // alternativas mesmo quando elas não vieram neste PATCH) quanto para o
  // UPDATE escalar em si.
  const effectiveEnunciado = enunciadoProvided ? input.enunciado! : before.enunciado;
  let effectiveAlternatives: AlternativeInput[];
  if (alternativesProvided) {
    effectiveAlternatives = altResult!.value!;
  } else {
    const existing = await listAlternatives(db, questionId);
    effectiveAlternatives = existing.map((a) => ({
      letter: a.letter as never,
      text: a.text,
      isCorrect: a.is_correct === 1,
      distractorExplanation: a.distractor_explanation,
    }));
  }

  const fingerprint = await computeFingerprint(effectiveEnunciado, effectiveAlternatives);
  if (fingerprint !== before.fingerprint) {
    const duplicates = (await findQuestionsByFingerprint(db, fingerprint)).filter((q) => q.id !== questionId);
    if (duplicates.length > 0) {
      return { ok: false, fieldErrors: { enunciado: "Já existe uma questão com enunciado equivalente (fingerprint duplicada)." } };
    }
  }

  const versionAfter = expectedVersion + 1;
  const mergedScalars = {
    enunciado: effectiveEnunciado,
    resolucaoComentada: isProvided(input, "resolucaoComentada") ? input.resolucaoComentada! : before.resolucao_comentada,
    conteudo: isProvided(input, "conteudo") ? input.conteudo! : before.conteudo,
    subconteudo: isProvided(input, "subconteudo") ? input.subconteudo! : before.subconteudo,
    habilidade: isProvided(input, "habilidade") ? input.habilidade! : before.habilidade,
    competencia: isProvided(input, "competencia") ? input.competencia! : before.competencia,
    dificuldade: isProvided(input, "dificuldade") ? input.dificuldade! : before.dificuldade,
    origem: isProvided(input, "origem") ? input.origem! : before.origem,
    prova: isProvided(input, "prova") ? input.prova! : before.prova,
    ano: isProvided(input, "ano") ? input.ano! : before.ano,
    tempoEstimadoSegundos: isProvided(input, "tempoEstimadoSegundos") ? input.tempoEstimadoSegundos! : before.tempo_estimado_segundos,
    tipoCalculo: (isProvided(input, "tipoCalculo") ? input.tipoCalculo : before.tipo_calculo) as never,
    necessitaCalculadora: (isProvided(input, "necessitaCalculadora")
      ? (input.necessitaCalculadora ? 1 : 0)
      : before.necessita_calculadora) as 0 | 1,
    titularDireitos: isProvided(input, "titularDireitos") ? input.titularDireitos! : before.titular_direitos,
    baseLicenca: isProvided(input, "baseLicenca") ? input.baseLicenca! : before.base_licenca,
    textoAtribuicao: isProvided(input, "textoAtribuicao") ? input.textoAtribuicao! : before.texto_atribuicao,
    fingerprint,
  };
  const coreUpdate = buildUpdateQuestionCoreStatement(db, questionId, expectedVersion, mergedScalars);

  // Só as coleções EXPLICITAMENTE presentes entram no lote — cada uma como
  // par DELETE+INSERTs guardado pela MESMA `versionAfter` do UPDATE escalar
  // (o mesmo padrão de guard condicionado do v1.0, agora aplicado
  // seletivamente por coleção em vez de sempre-todas). O array de campos
  // alterados vira metadado do histórico (nomes só, nunca conteúdo).
  const statements = [coreUpdate];
  const changedFields: string[] = [];

  for (const field of [
    "enunciado",
    "resolucaoComentada",
    "conteudo",
    "subconteudo",
    "habilidade",
    "competencia",
    "dificuldade",
    "origem",
    "prova",
    "ano",
    "tempoEstimadoSegundos",
    "tipoCalculo",
    "necessitaCalculadora",
    "titularDireitos",
    "baseLicenca",
    "textoAtribuicao",
  ] as const) {
    if (isProvided(input, field)) changedFields.push(field);
  }

  if (alternativesProvided) {
    changedFields.push("alternativas");
    statements.push(buildDeleteAlternativesStatement(db, questionId, versionAfter));
    effectiveAlternatives.forEach((alt, index) =>
      statements.push(buildGuardedInsertAlternativeStatement(db, questionId, newId(), alt, index, versionAfter))
    );
  }
  if (dnaProvided) {
    changedFields.push("dna");
    statements.push(buildGuardedUpsertDnaStatement(db, questionId, dnaResult!.value!, versionAfter));
  }
  if (patternsProvided) {
    changedFields.push("padroes");
    statements.push(buildDeletePatternLinksStatement(db, questionId, versionAfter));
    patternsResult!.value!.forEach((link) =>
      statements.push(buildGuardedInsertPatternLinkStatement(db, questionId, newId(), link, versionAfter))
    );
  }
  if (tagsProvided) {
    changedFields.push("tags");
    statements.push(buildDeleteTagsStatement(db, questionId, versionAfter));
    tagsResult!.value!.forEach((tag, index) =>
      statements.push(buildGuardedInsertTagStatement(db, questionId, newId(), tag, index, versionAfter))
    );
  }
  if (imagesProvided) {
    changedFields.push("imagens");
    statements.push(buildDeleteImagesStatement(db, questionId, versionAfter));
    imagesResult!.value!.forEach((image) =>
      statements.push(buildGuardedInsertImageStatement(db, questionId, newId(), image, versionAfter))
    );
  }

  statements.push(
    buildConditionalHistoryStatement(db, {
      id: newId(),
      questionId,
      userId: actorUserId,
      action: "updated",
      fromStatus: before.editorial_status,
      toStatus: before.editorial_status,
      versionAfter,
      // Só os NOMES dos grupos alterados — nunca o conteúdo integral
      // (Correção A, seção 2: "histórico deve indicar quais grupos de
      // campos mudaram, sem guardar o conteúdo integral").
      metadata: { fields: changedFields.join(",") },
    })
  );

  // Validação de cada resultado do lote (seção 2 da ordem v1.1): o único
  // statement cujo `meta.changes` decide sucesso/falha é o UPDATE escalar
  // (índice 0) — todos os demais são condicionados pela MESMA versão-alvo,
  // então uma falha ali (ex.: injetada por teste) já reflete no UPDATE
  // escalar não tendo sido a causa raiz; uma falha lançada por QUALQUER
  // statement do lote (ex.: erro forçado) propaga a exceção do `db.batch()`
  // inteiro, revertendo TUDO (nenhuma escrita parcial).
  const [coreResult] = await db.batch(statements);
  if (coreResult.meta.changes === 1) return { ok: true, value: { id: questionId } };

  const after = await findQuestionById(db, questionId);
  if (!after) return { ok: false, notFound: true };
  // Repetição idempotente (Correção A, seção 2 da ordem v1.1): o UPDATE não
  // mudou nada agora (a `expectedVersion` enviada já está obsoleta), mas se
  // a questão está EXATAMENTE na versão que ESTA chamada teria produzido
  // (`versionAfter`) e o conteúdo escalar mesclado bate byte a byte com o
  // que está gravado, é a MESMA chamada sendo reenviada (ex.: retry de
  // rede) — não um conflito real com edição de outra pessoa. Reconhecer
  // isso evita um 409 espúrio E confirma que o guard `NOT EXISTS` do
  // histórico (por versão) já impediu a duplicação, sem escrever de novo.
  if (
    after.version === versionAfter &&
    after.enunciado === mergedScalars.enunciado &&
    after.conteudo === mergedScalars.conteudo &&
    after.dificuldade === mergedScalars.dificuldade &&
    after.origem === mergedScalars.origem &&
    after.fingerprint === mergedScalars.fingerprint
  ) {
    return { ok: true, value: { id: questionId } };
  }
  if (after.version !== expectedVersion) return { ok: false, conflict: true };
  return { ok: false, fieldErrors: { editorial_status: "Questão não está num status editável." } };
}

/* --------------------------------- Leitura DTO -------------------------------- */

export interface QuestionSummaryDto {
  id: string;
  code: string;
  enunciado: string;
  dificuldade: string;
  origem: string;
  editorialStatus: string;
  autorId: string | null;
  revisorId: string | null;
  ano: number | null;
  hasImage: boolean;
  version: number;
  isLocalFixture: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface QuestionDetailDto extends QuestionSummaryDto {
  resolucaoComentada: string;
  conteudo: string;
  subconteudo: string;
  habilidade: string;
  competencia: string;
  prova: string | null;
  tempoEstimadoSegundos: number | null;
  tipoCalculo: string;
  necessitaCalculadora: boolean;
  titularDireitos: string | null;
  baseLicenca: string | null;
  textoAtribuicao: string | null;
  fingerprint: string;
  alternativas: Array<{ letter: string; text: string; isCorrect: boolean; distractorExplanation: string | null }>;
  imagens: Array<{ id: string; assetRef: string; altText: string; caption: string | null; position: number }>;
  padroes: Array<{ patternId: string; role: string }>;
  tags: string[];
  dna: {
    pista: string;
    estrategia: string;
    pegadinha: string;
    conteudoApoio: string;
    resolucao: string;
    atalho: string | null;
    aprendizadoErro: string;
  } | null;
}

function toSummaryDto(row: QuestionRow, hasImage: boolean): QuestionSummaryDto {
  return {
    id: row.id,
    code: row.code,
    enunciado: row.enunciado,
    dificuldade: row.dificuldade,
    origem: row.origem,
    editorialStatus: row.editorial_status,
    autorId: row.autor_id,
    revisorId: row.revisor_id,
    ano: row.ano,
    hasImage,
    version: row.version,
    isLocalFixture: row.is_local_fixture === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listQuestionsService(
  db: D1Database,
  filters: QuestionListFilters,
  page: number,
  pageSize: number
): Promise<{ questions: QuestionSummaryDto[]; page: number; pageSize: number; total: number; totalPages: number }> {
  const total = await countQuestions(db, filters);
  const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize);
  const offset = (page - 1) * pageSize;
  const rows = await listQuestions(db, filters, pageSize, offset);
  const ids = rows.map((r) => r.id);
  const images = await listImagesForQuestions(db, ids);
  const imageQuestionIds = new Set(images.map((i) => i.question_id));
  return {
    questions: rows.map((row) => toSummaryDto(row, imageQuestionIds.has(row.id))),
    page,
    pageSize,
    total,
    totalPages,
  };
}

function toDetailDto(
  row: QuestionRow,
  alternatives: QuestionAlternativeRow[],
  images: QuestionImageRow[],
  patterns: QuestionPatternRow[],
  tags: QuestionTagRow[],
  dna: QuestionDnaRow | null
): QuestionDetailDto {
  return {
    ...toSummaryDto(row, images.length > 0),
    resolucaoComentada: row.resolucao_comentada,
    conteudo: row.conteudo,
    subconteudo: row.subconteudo,
    habilidade: row.habilidade,
    competencia: row.competencia,
    prova: row.prova,
    tempoEstimadoSegundos: row.tempo_estimado_segundos,
    tipoCalculo: row.tipo_calculo,
    necessitaCalculadora: row.necessita_calculadora === 1,
    titularDireitos: row.titular_direitos,
    baseLicenca: row.base_licenca,
    textoAtribuicao: row.texto_atribuicao,
    fingerprint: row.fingerprint,
    alternativas: alternatives.map((a) => ({
      letter: a.letter,
      text: a.text,
      isCorrect: a.is_correct === 1,
      distractorExplanation: a.distractor_explanation,
    })),
    imagens: images.map((i) => ({ id: i.id, assetRef: i.asset_ref, altText: i.alt_text, caption: i.caption, position: i.position })),
    padroes: patterns.map((p) => ({ patternId: p.pattern_id, role: p.role })),
    tags: tags.map((t) => t.content),
    dna: dna
      ? {
          pista: dna.pista,
          estrategia: dna.estrategia,
          pegadinha: dna.pegadinha,
          conteudoApoio: dna.conteudo_apoio,
          resolucao: dna.resolucao,
          atalho: dna.atalho,
          aprendizadoErro: dna.aprendizado_erro,
        }
      : null,
  };
}

export async function getQuestionDetail(db: D1Database, id: string): Promise<QuestionDetailDto | null> {
  const row = await findQuestionById(db, id);
  if (!row) return null;
  const [alternatives, images, patterns, tags, dna] = await Promise.all([
    listAlternatives(db, id),
    listImages(db, id),
    listPatternsForQuestion(db, id),
    listTags(db, id),
    findDna(db, id),
  ]);
  return toDetailDto(row, alternatives, images, patterns, tags, dna);
}

/* -------------------------------- Workflow ------------------------------------ */

export interface TransitionResult {
  ok: boolean;
  changed?: boolean;
  notFound?: boolean;
  conflict?: boolean;
  forbidden?: boolean;
  fieldErrors?: Record<string, string>;
}

async function readinessForReview(db: D1Database, questionId: string): Promise<string | null> {
  const [alternatives, images, patterns] = await Promise.all([
    listAlternatives(db, questionId),
    listImages(db, questionId),
    listPatternsForQuestion(db, questionId),
  ]);
  const altSet = validateAlternativeSet(
    alternatives.map((a) => ({
      letter: a.letter as never,
      text: a.text,
      isCorrect: a.is_correct === 1,
      distractorExplanation: a.distractor_explanation,
    }))
  );
  if (!altSet.ok) return altSet.error!;
  if (!allImagesHaveAlt(images.map((i) => ({ assetRef: i.asset_ref, altText: i.alt_text, caption: i.caption, position: i.position, titularDireitos: null, baseLicenca: null })))) {
    return "Toda imagem precisa de texto alternativo antes de enviar para revisão.";
  }
  const patternLinks: QuestionPatternInput[] = patterns.map((p) => ({ patternId: p.pattern_id, role: p.role as never }));
  if (!hasPrincipalPattern(patternLinks)) return "É necessário um padrão principal antes de enviar para revisão.";
  return null;
}

async function readinessForApproval(db: D1Database, questionId: string): Promise<string | null> {
  const reviewError = await readinessForReview(db, questionId);
  if (reviewError) return reviewError;
  const dna = await findDna(db, questionId);
  const dnaInput = dna
    ? {
        pista: dna.pista,
        estrategia: dna.estrategia,
        pegadinha: dna.pegadinha,
        conteudoApoio: dna.conteudo_apoio,
        resolucao: dna.resolucao,
        atalho: dna.atalho,
        aprendizadoErro: dna.aprendizado_erro,
      }
    : null;
  if (!isDnaComplete(dnaInput)) return "DNA da questão incompleto — obrigatório antes de aprovação/publicação.";
  return null;
}

async function applyTransition(
  db: D1Database,
  params: {
    actorUserId: string;
    role: EditorialRole;
    questionId: string;
    expectedVersion: number;
    from: QuestionEditorialStatus[];
    to: QuestionEditorialStatus;
    action: string;
    revisorId?: string | null;
    metadata?: Record<string, string | number | boolean> | null;
    minRole: "editor" | "admin";
    precheck?: () => Promise<string | null>;
  }
): Promise<TransitionResult> {
  if (!roleSatisfies(params.role, params.minRole)) return { ok: false, forbidden: true };

  const before = await findQuestionById(db, params.questionId);
  if (!before) return { ok: false, notFound: true };

  // Nenhum pré-corte por status aqui: diferente de um "fail fast", um corte
  // antecipado baseado em `before.editorial_status` quebraria a idempotência
  // de um reenvio tardio (a leitura "before" já reflete o efeito da chamada
  // anterior bem-sucedida — status já não está mais em `params.from`, mesmo
  // que a transição em si tenha sido a correta). A ÚNICA fonte de verdade é
  // o resultado do UPDATE condicionado abaixo, interpretado depois — mesmo
  // padrão de scheduleService.ts:applyGuardedTransition.
  if (params.precheck) {
    const error = await params.precheck();
    if (error) return { ok: false, fieldErrors: { readiness: error } };
  }

  const versionAfter = params.expectedVersion + 1;
  const transitionStatement = buildTransitionStatement(db, {
    id: params.questionId,
    expectedVersion: params.expectedVersion,
    fromStatuses: params.from,
    toStatus: params.to,
    revisorId: params.revisorId,
  });
  const historyStatement = buildConditionalHistoryStatement(db, {
    id: newId(),
    questionId: params.questionId,
    userId: params.actorUserId,
    action: params.action,
    fromStatus: before.editorial_status,
    toStatus: params.to,
    versionAfter,
    metadata: params.metadata ?? null,
  });

  const [updateResult] = await db.batch([transitionStatement, historyStatement]);
  if (updateResult.meta.changes === 1) return { ok: true, changed: true };

  const after = await findQuestionById(db, params.questionId);
  if (!after) return { ok: false, notFound: true };
  if (after.editorial_status === params.to && after.version === versionAfter) {
    // Repetição idempotente: a transição já ocorreu antes; o histórico já
    // foi gravado na primeira vez (guard NOT EXISTS por versão) e não
    // duplica agora.
    return { ok: true, changed: false };
  }
  if (after.version !== params.expectedVersion) return { ok: false, conflict: true };
  return { ok: false, fieldErrors: { editorial_status: "Transição não permitida a partir do status atual." } };
}

export async function submitForReview(
  db: D1Database,
  actorUserId: string,
  role: EditorialRole,
  questionId: string,
  expectedVersion: number
): Promise<TransitionResult> {
  return applyTransition(db, {
    actorUserId,
    role,
    questionId,
    expectedVersion,
    from: ["draft", "changes_requested"],
    to: "in_review",
    action: "submitted_review",
    minRole: TRANSITION_MIN_ROLE[transitionKey("draft", "in_review")] as "editor",
    precheck: () => readinessForReview(db, questionId),
  });
}

export async function requestChanges(
  db: D1Database,
  actorUserId: string,
  role: EditorialRole,
  questionId: string,
  expectedVersion: number,
  reason: string
): Promise<TransitionResult> {
  if (!reason || reason.trim().length === 0) {
    return { ok: false, fieldErrors: { reason: "Motivo é obrigatório para solicitar correção." } };
  }
  return applyTransition(db, {
    actorUserId,
    role,
    questionId,
    expectedVersion,
    from: ["in_review"],
    to: "changes_requested",
    action: "changes_requested",
    minRole: "admin",
    metadata: { reason: reason.slice(0, 200) },
  });
}

export async function approveQuestion(
  db: D1Database,
  actorUserId: string,
  role: EditorialRole,
  questionId: string,
  expectedVersion: number
): Promise<TransitionResult> {
  return applyTransition(db, {
    actorUserId,
    role,
    questionId,
    expectedVersion,
    from: ["in_review"],
    to: "approved",
    action: "approved",
    revisorId: actorUserId,
    minRole: "admin",
    precheck: () => readinessForApproval(db, questionId),
  });
}

export async function publishQuestion(
  db: D1Database,
  actorUserId: string,
  role: EditorialRole,
  questionId: string,
  expectedVersion: number
): Promise<TransitionResult> {
  return applyTransition(db, {
    actorUserId,
    role,
    questionId,
    expectedVersion,
    from: ["approved"],
    to: "published",
    action: "published",
    minRole: "admin",
    precheck: async () => {
      const readinessError = await readinessForApproval(db, questionId);
      if (readinessError) return readinessError;
      const question = await findQuestionById(db, questionId);
      if (
        !question ||
        !hasRequiredRightsForPublication({
          origem: question.origem,
          titularDireitos: question.titular_direitos,
          baseLicenca: question.base_licenca,
          autorId: question.autor_id,
          revisorId: question.revisor_id,
        })
      ) {
        return "Direitos/licença incompletos — obrigatório antes de publicação.";
      }
      return null;
    },
  });
}

export async function archiveQuestion(
  db: D1Database,
  actorUserId: string,
  role: EditorialRole,
  questionId: string,
  expectedVersion: number
): Promise<TransitionResult> {
  return applyTransition(db, {
    actorUserId,
    role,
    questionId,
    expectedVersion,
    from: ["draft", "in_review", "changes_requested", "approved"],
    to: "archived",
    action: "archived",
    minRole: "admin",
  });
}

/* Reexport de tipos usados pelos batches de import (evita import circular). */
export { QUESTION_TRANSITIONS };
export { listQuestionsByIds, listAlternativesForQuestions, listPatternLinksForQuestions };
