/* Serviço do Banco de Questões — Sprint 7 v1.0.

   Orquestra validação (worker/src/lib/questionsValidation.ts), RBAC
   (worker/src/lib/rbac.ts) e atomicidade (db.batch()). Nunca deixa erro cru
   do banco vazar para a rota — todo resultado é um DTO tipado com motivo
   fechado de falha. Transição + histórico SEMPRE no mesmo db.batch()
   (seção 6 da ordem) — ver buildTransitionStatement +
   buildConditionalHistoryStatement em questionRepository.ts. */

import { computeQuestionFingerprint } from "../lib/fingerprint";
import { validateBatchResults, type ExpectedBatchStatement } from "../lib/batchValidation";
import { recordAuditEvent } from "../repositories/auditRepository";
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
  buildMutationCheckStatement,
  buildTransitionStatement,
  buildUpdateQuestionCoreStatement,
  buildUpsertDnaStatement,
  countQuestions,
  findDna,
  findHistoryById,
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
  /** Sprint 7 v1.2, Correção A — distingue uma mutação real (`true`) de um
   *  no-op ou de uma repetição idempotente reconhecida pelo `mutationId`
   *  (`false`). Só `changed: true` grava `audit_log`. */
  changed?: boolean;
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
      guardVersion: 1,
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

const ALL_SCALAR_FIELDS = [
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
] as const;
const ALL_COLLECTION_FIELDS = ["alternativas", "dna", "padroes", "tags", "imagens"] as const;

/* --------------------- Comparação CANÔNICA (Correção A, v1.2) ------------------
   Usada só para decidir se um PATCH é um no-op (seção "PATCH vazio/no-op" da
   ordem v1.2) — NUNCA para decidir idempotência de retry (isso agora é
   função exclusiva do `mutationId`, nunca de comparação de conteúdo). */

function alternativesCanonicallyEqual(a: AlternativeInput[], b: AlternativeInput[]): boolean {
  if (a.length !== b.length) return false;
  const sort = (arr: AlternativeInput[]) => [...arr].sort((x, y) => x.letter.localeCompare(y.letter));
  const sa = sort(a);
  const sb = sort(b);
  return sa.every(
    (alt, i) =>
      alt.letter === sb[i].letter &&
      alt.text === sb[i].text &&
      alt.isCorrect === sb[i].isCorrect &&
      (alt.distractorExplanation ?? null) === (sb[i].distractorExplanation ?? null)
  );
}

function dnaCanonicallyEqual(a: QuestionDnaInput, b: QuestionDnaInput): boolean {
  return (
    a.pista === b.pista &&
    a.estrategia === b.estrategia &&
    a.pegadinha === b.pegadinha &&
    a.conteudoApoio === b.conteudoApoio &&
    a.resolucao === b.resolucao &&
    (a.atalho ?? null) === (b.atalho ?? null) &&
    a.aprendizadoErro === b.aprendizadoErro
  );
}

function patternsCanonicallyEqual(a: QuestionPatternInput[], b: QuestionPatternInput[]): boolean {
  if (a.length !== b.length) return false;
  const key = (p: QuestionPatternInput) => `${p.patternId}:${p.role}`;
  const sa = a.map(key).sort();
  const sb = b.map(key).sort();
  return sa.every((k, i) => k === sb[i]);
}

function tagsCanonicallyEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((t, i) => t === sb[i]);
}

function imagesCanonicallyEqual(a: QuestionImageInput[], b: QuestionImageInput[]): boolean {
  if (a.length !== b.length) return false;
  return a.every(
    (img, i) =>
      img.assetRef === b[i].assetRef &&
      img.altText === b[i].altText &&
      (img.caption ?? null) === (b[i].caption ?? null) &&
      img.position === b[i].position &&
      (img.titularDireitos ?? null) === (b[i].titularDireitos ?? null) &&
      (img.baseLicenca ?? null) === (b[i].baseLicenca ?? null)
  );
}

/** Edita o conteúdo de uma questão em `draft`/`changes_requested` — PATCH
 *  PARCIAL de verdade (Sprint 7 v1.1/v1.2, Correções A). Um campo/coleção
 *  AUSENTE do corpo preserva o valor atual; uma coleção enviada como `[]`
 *  limpa explicitamente; `null` só é aceito nos campos anuláveis
 *  (`NULLABLE_QUESTION_SCALAR_FIELDS`), senão é 400 sem gravar nada.
 *  Publicada NUNCA é editável (seção 6 da ordem) — o guard SQL do UPDATE já
 *  restringe isso, e aqui é verificado ANTES também, para devolver um erro
 *  específico em vez de um 409 genérico de versão quando o problema é outro.
 *
 *  v1.2, Correção A — IDEMPOTÊNCIA POR CHAVE DE OPERAÇÃO: a heurística da
 *  v1.1 (comparar versão-alvo + um punhado de escalares mesclados) foi
 *  REMOVIDA — ela podia confundir uma edição concorrente DIFERENTE (que só
 *  mudasse tags, DNA, imagens, direitos ou texto explicativo de alternativa)
 *  com "a mesma chamada sendo repetida", porque nenhum desses campos entrava
 *  na comparação. A prova de retry agora é EXCLUSIVAMENTE o `mutationId`
 *  (UUID gerado pelo cliente), reaproveitando `question_history.id` como
 *  chave de idempotência (sem migration nova): a linha de histórico já
 *  registra ator/questão/ação/versão, então uma consulta por esse ID basta
 *  para confirmar "esta EXATA operação já foi aplicada". Conteúdo parecido
 *  NUNCA é aceito como prova de retry.
 *
 *  v1.2, Correção A — PATCH vazio/no-op: corpo sem nenhum campo/coleção
 *  editável é 400 sem incrementar versão; corpo com campos/coleções
 *  presentes mas cujo valor EFETIVO é idêntico ao já gravado (comparação
 *  canônica — ver funções `*CanonicallyEqual` acima) retorna
 *  `ok:true, changed:false` sem gravar versão/histórico/auditoria novos.
 *
 *  Atomicidade: o UPDATE escalar roda sempre que uma escrita real é
 *  decidida (nunca para no-op/idempotente) — é o único jeito de expressar o
 *  guard de versão condicionado num único statement. Só as coleções
 *  EXPLICITAMENTE presentes no corpo entram no lote (DELETE + INSERTs
 *  guardados pela MESMA versão-alvo do UPDATE escalar) — uma coleção
 *  ausente não gera nenhum statement, então nunca é apagada por omissão.
 *
 *  v1.2, Correção B — VALIDAÇÃO DE TODO O LOTE: depois que o UPDATE escalar
 *  confirma sucesso (`meta.changes === 1`), TODOS os demais resultados do
 *  lote (INSERTs de coleção e o INSERT de `question_history`) são
 *  verificados contra a expectativa declarada de cada um
 *  (`worker/src/lib/batchValidation.ts`) — nunca só o resultado do UPDATE
 *  central. Um descompasso (ex.: o histórico afetando 0 linhas mesmo com o
 *  core tendo mudado) lança `BatchInvariantError`, que NUNCA é convertida em
 *  sucesso — propaga como erro interno controlado (seção "Validação do
 *  lote" de docs/BANCO_QUESTOES.md documenta a limitação: como o lote já foi
 *  commitado, esta é a melhor forma de "erro controlado" alcançável sem uma
 *  transação de compensação). */
export async function updateQuestion(
  db: D1Database,
  actorUserId: string,
  questionId: string,
  expectedVersion: number,
  mutationId: string,
  input: Partial<QuestionInput>
): Promise<MutationResult<{ id: string }>> {
  // Chave de idempotência PRIMEIRO — antes de qualquer outra leitura/escrita.
  // Reaproveita question_history.id (PK, unicidade garantida pelo banco).
  const existingMutation = await findHistoryById(db, mutationId);
  if (existingMutation) {
    if (existingMutation.question_id !== questionId || existingMutation.user_id !== actorUserId || existingMutation.action !== "updated") {
      // Colisão: o mesmo mutationId já foi usado para outra questão, outro
      // ator ou outra ação — nunca tratado como retry válido.
      return {
        ok: false,
        conflict: true,
        fieldErrors: { mutationId: "Este identificador de mutação já foi usado para outra operação." },
      };
    }
    // Mesma mutação, já aplicada — sucesso idempotente, SEM tocar o banco de
    // novo (nenhuma escrita, nenhum histórico/auditoria duplicados).
    return { ok: true, changed: false, value: { id: questionId } };
  }

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
  for (const field of ALL_COLLECTION_FIELDS) {
    if (isProvided(input, field) && (input as Record<string, unknown>)[field] === null) {
      fieldErrors[field] = "Este campo não pode ser nulo — envie um array vazio para limpar.";
    }
  }
  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors };

  // v1.2, Correção A — corpo sem NENHUM campo/coleção editável é 400, sem
  // incrementar versão (nenhuma leitura adicional nem consulta de duplicidade).
  const anyScalarProvided = ALL_SCALAR_FIELDS.some((field) => isProvided(input, field));
  const anyCollectionProvided = ALL_COLLECTION_FIELDS.some((field) => isProvided(input, field));
  if (!anyScalarProvided && !anyCollectionProvided) {
    return { ok: false, fieldErrors: { _body: "Nenhum campo editável foi enviado." } };
  }

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

  // Alternativas EXISTENTES são sempre carregadas — usadas tanto para
  // completar o conjunto EFETIVO (quando não enviadas) quanto para a
  // comparação canônica de no-op (quando enviadas).
  const existingAlternativeRows = await listAlternatives(db, questionId);
  const existingAlternatives: AlternativeInput[] = existingAlternativeRows.map((a) => ({
    letter: a.letter as never,
    text: a.text,
    isCorrect: a.is_correct === 1,
    distractorExplanation: a.distractor_explanation,
  }));

  const effectiveEnunciado = enunciadoProvided ? input.enunciado! : before.enunciado;
  const effectiveAlternatives = alternativesProvided ? altResult!.value! : existingAlternatives;

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
  };

  // v1.2, Correção A — detecção de NO-OP: só os campos/coleções REALMENTE
  // enviados entram na comparação (um campo ausente nunca "muda" nada, por
  // definição). Comparação canônica, nunca por fingerprint (a v2 do
  // fingerprint exclui gabarito/explicação — comparar só fingerprint
  // mascararia uma mudança real de isCorrect/distractorExplanation).
  let hasRealChange =
    mergedScalars.enunciado !== before.enunciado ||
    mergedScalars.resolucaoComentada !== before.resolucao_comentada ||
    mergedScalars.conteudo !== before.conteudo ||
    mergedScalars.subconteudo !== before.subconteudo ||
    mergedScalars.habilidade !== before.habilidade ||
    mergedScalars.competencia !== before.competencia ||
    mergedScalars.dificuldade !== before.dificuldade ||
    mergedScalars.origem !== before.origem ||
    mergedScalars.prova !== before.prova ||
    mergedScalars.ano !== before.ano ||
    mergedScalars.tempoEstimadoSegundos !== before.tempo_estimado_segundos ||
    mergedScalars.tipoCalculo !== before.tipo_calculo ||
    mergedScalars.necessitaCalculadora !== before.necessita_calculadora ||
    mergedScalars.titularDireitos !== before.titular_direitos ||
    mergedScalars.baseLicenca !== before.base_licenca ||
    mergedScalars.textoAtribuicao !== before.texto_atribuicao;

  if (!hasRealChange && alternativesProvided && !alternativesCanonicallyEqual(effectiveAlternatives, existingAlternatives)) {
    hasRealChange = true;
  }
  if (!hasRealChange && dnaProvided) {
    const existingDna = await findDna(db, questionId);
    const existingDnaForCompare: QuestionDnaInput = existingDna
      ? {
          pista: existingDna.pista,
          estrategia: existingDna.estrategia,
          pegadinha: existingDna.pegadinha,
          conteudoApoio: existingDna.conteudo_apoio,
          resolucao: existingDna.resolucao,
          atalho: existingDna.atalho,
          aprendizadoErro: existingDna.aprendizado_erro,
        }
      : { pista: "", estrategia: "", pegadinha: "", conteudoApoio: "", resolucao: "", atalho: null, aprendizadoErro: "" };
    if (!dnaCanonicallyEqual(dnaResult!.value!, existingDnaForCompare)) hasRealChange = true;
  }
  if (!hasRealChange && patternsProvided) {
    const existingPatterns = await listPatternsForQuestion(db, questionId);
    const existingPatternInputs: QuestionPatternInput[] = existingPatterns.map((p) => ({ patternId: p.pattern_id, role: p.role as never }));
    if (!patternsCanonicallyEqual(patternsResult!.value!, existingPatternInputs)) hasRealChange = true;
  }
  if (!hasRealChange && tagsProvided) {
    const existingTags = await listTags(db, questionId);
    if (!tagsCanonicallyEqual(tagsResult!.value!, existingTags.map((t) => t.content))) hasRealChange = true;
  }
  if (!hasRealChange && imagesProvided) {
    const existingImages = await listImages(db, questionId);
    const existingImageInputs: QuestionImageInput[] = existingImages.map((i) => ({
      assetRef: i.asset_ref,
      altText: i.alt_text,
      caption: i.caption,
      position: i.position,
      titularDireitos: i.titular_direitos,
      baseLicenca: i.base_licenca,
    }));
    if (!imagesCanonicallyEqual(imagesResult!.value!, existingImageInputs)) hasRealChange = true;
  }

  if (!hasRealChange) {
    // No-op documentado (seção "PATCH vazio/no-op" da ordem v1.2): valores
    // enviados idênticos ao estado atual — sucesso sem gravar versão,
    // histórico ou auditoria novos.
    return { ok: true, changed: false, value: { id: questionId } };
  }

  const fingerprint = await computeFingerprint(effectiveEnunciado, effectiveAlternatives);
  if (fingerprint !== before.fingerprint) {
    const duplicates = (await findQuestionsByFingerprint(db, fingerprint)).filter((q) => q.id !== questionId);
    if (duplicates.length > 0) {
      return { ok: false, fieldErrors: { enunciado: "Já existe uma questão com enunciado equivalente (fingerprint duplicada)." } };
    }
  }

  const versionAfter = expectedVersion + 1;
  const coreUpdate = buildUpdateQuestionCoreStatement(db, questionId, expectedVersion, { ...mergedScalars, fingerprint });

  // v1.3 — REORDENADO: as coleções e o histórico (as "consequências") rodam
  // ANTES do UPDATE central de `questions` (a "causa"), guardados pela
  // versão ATUAL/pré-mutação (`expectedVersion`), NÃO pela resultante
  // (`versionAfter`, que só passaria a existir depois do UPDATE central —
  // impossível de checar antes dele rodar). Isso é o que permite o trigger
  // de migrations/0009_editorial_batch_invariants.sql (`AFTER UPDATE ON
  // questions ... WHEN NEW.version != OLD.version`) abortar a transação
  // INTEIRA se o UPDATE central de fato mudar a versão mas o histórico
  // correspondente não existir — porque o histórico já deveria ter sido
  // inserido momentos antes, na MESMA transação. Cada statement além do
  // core ainda declara sua EXPECTATIVA (Correção B, mantida como defesa
  // adicional em profundidade) — o DELETE sempre "any" (uma coleção já
  // vazia legitimamente afeta 0 linhas); cada INSERT guardado "exactlyOne".
  // O array de campos alterados vira metadado do histórico (nomes só,
  // nunca conteúdo).
  const childStatements: Array<{ statement: D1PreparedStatement; expectation: ExpectedBatchStatement }> = [];
  const changedFields: string[] = [];

  for (const field of ALL_SCALAR_FIELDS) {
    if (isProvided(input, field)) changedFields.push(field);
  }

  if (alternativesProvided) {
    changedFields.push("alternativas");
    childStatements.push({ statement: buildDeleteAlternativesStatement(db, questionId, expectedVersion), expectation: { label: "DELETE question_alternatives", expected: "any" } });
    effectiveAlternatives.forEach((alt, index) => {
      childStatements.push({
        // v1.4 — `versionAfter` carimba `version_stamp` (ver nota em
        // questionRepository.ts), nunca confundir com `expectedVersion`
        // (guard, valor PRÉ-mutação).
        statement: buildGuardedInsertAlternativeStatement(db, questionId, newId(), alt, index, expectedVersion, versionAfter),
        expectation: { label: `INSERT question_alternatives[${alt.letter}]`, expected: "exactlyOne" },
      });
    });
  }
  if (dnaProvided) {
    changedFields.push("dna");
    childStatements.push({
      statement: buildGuardedUpsertDnaStatement(db, questionId, dnaResult!.value!, expectedVersion, versionAfter),
      expectation: { label: "UPSERT question_dna", expected: "exactlyOne" },
    });
  }
  if (patternsProvided) {
    changedFields.push("padroes");
    childStatements.push({ statement: buildDeletePatternLinksStatement(db, questionId, expectedVersion), expectation: { label: "DELETE question_patterns", expected: "any" } });
    patternsResult!.value!.forEach((link) => {
      childStatements.push({
        statement: buildGuardedInsertPatternLinkStatement(db, questionId, newId(), link, expectedVersion, versionAfter),
        expectation: { label: `INSERT question_patterns[${link.patternId}]`, expected: "exactlyOne" },
      });
    });
  }
  if (tagsProvided) {
    changedFields.push("tags");
    childStatements.push({ statement: buildDeleteTagsStatement(db, questionId, expectedVersion), expectation: { label: "DELETE question_tags", expected: "any" } });
    tagsResult!.value!.forEach((tag, index) => {
      childStatements.push({
        statement: buildGuardedInsertTagStatement(db, questionId, newId(), tag, index, expectedVersion, versionAfter),
        expectation: { label: `INSERT question_tags[${index}]`, expected: "exactlyOne" },
      });
    });
  }
  if (imagesProvided) {
    changedFields.push("imagens");
    childStatements.push({ statement: buildDeleteImagesStatement(db, questionId, expectedVersion), expectation: { label: "DELETE question_images", expected: "any" } });
    imagesResult!.value!.forEach((image, index) => {
      childStatements.push({
        statement: buildGuardedInsertImageStatement(db, questionId, newId(), image, expectedVersion, versionAfter),
        expectation: { label: `INSERT question_images[${index}]`, expected: "exactlyOne" },
      });
    });
  }

  // mutationId reaproveitado como question_history.id — a chave de
  // idempotência da operação inteira (Correção A). A checagem de colisão já
  // rodou no topo da função, então este INSERT é sempre seguro (nenhum
  // conflito de PK esperado nesta linha). Guardado pela versão ATUAL
  // (`expectedVersion`) — roda ANTES do UPDATE central (v1.3).
  childStatements.push({
    statement: buildConditionalHistoryStatement(db, {
      id: mutationId,
      questionId,
      userId: actorUserId,
      action: "updated",
      fromStatus: before.editorial_status,
      toStatus: before.editorial_status,
      guardVersion: expectedVersion,
      versionAfter,
      // MESMA lista de status editáveis do UPDATE central
      // (buildUpdateQuestionCoreStatement) — guards idênticos, só podem
      // concordar (v1.3).
      guardStatuses: ["draft", "changes_requested"],
      // Só os NOMES dos grupos alterados — nunca o conteúdo integral.
      metadata: { fields: changedFields.join(",") },
    }),
    expectation: { label: "INSERT question_history", expected: "exactlyOne" },
  });

  // v1.4 — statement final e INCONDICIONAL: registra o que esta mutação
  // ESPERA ter acontecido (núcleo na versão resultante, histórico com este
  // mutationId, e a contagem esperada de cada coleção REALMENTE tocada nesta
  // chamada — `null` para as não tocadas). Por não ter WHERE algum, este
  // INSERT sempre grava exatamente 1 linha e SEMPRE dispara seu próprio
  // trigger `AFTER INSERT` (migrations/0010_editorial_bidirectional_invariants.sql),
  // que enxerga o estado (ainda não commitado) de tudo que os statements
  // anteriores desta mesma transação fizeram — mesmo se o UPDATE central,
  // logo antes dele, tiver silenciosamente afetado 0 linhas sem lançar
  // exceção. Isso fecha a direção que o trigger de 0009 (reage só a um
  // UPDATE que de fato mudou uma linha) não cobre.
  const mutationCheck = buildMutationCheckStatement(db, {
    id: newId(),
    questionId,
    expectedVersion: versionAfter,
    alternativesExpectedCount: alternativesProvided ? effectiveAlternatives.length : null,
    dnaExpectedCount: dnaProvided ? 1 : null,
    patternsExpectedCount: patternsProvided ? patternsResult!.value!.length : null,
    tagsExpectedCount: tagsProvided ? tagsResult!.value!.length : null,
    imagesExpectedCount: imagesProvided ? imagesResult!.value!.length : null,
  });

  // v1.3 — ORDEM: filhos (coleções + histórico) PRIMEIRO, UPDATE central
  // POR ÚLTIMO. Se `expectedVersion` não bater com a versão atual real, TODOS
  // os guards (filhos e central) falham consistentemente (mesma condição,
  // mesmo estado imutável durante a transação) — nenhuma escrita parcial.
  // Se bater, os filhos inserem primeiro e o UPDATE central, ao rodar por
  // último, dispara o trigger de 0009, que exige que o histórico já exista.
  // v1.4 — a checagem-marcador (`mutationCheck`) roda por ÚLTIMO de todos,
  // depois do UPDATE central, para poder enxergar o resultado real dele.
  const allStatements = [...childStatements.map((c) => c.statement), coreUpdate, mutationCheck];
  // Uma falha lançada por QUALQUER statement do lote (ex.: erro forçado, OU
  // o RAISE(ABORT) de qualquer um dos triggers de 0009/0010) propaga a
  // exceção do `db.batch()` inteiro, revertendo TUDO (nenhuma escrita
  // parcial) — garantia nativa do FakeD1Database (node:sqlite real)/D1 real,
  // provada por teste consultando o banco diretamente depois da falha,
  // nunca só a resposta HTTP.
  const results = await db.batch(allStatements);
  const coreResult = results[results.length - 2];

  if (coreResult.meta.changes !== 1) {
    const after = await findQuestionById(db, questionId);
    if (!after) return { ok: false, notFound: true };
    if (after.version !== expectedVersion) return { ok: false, conflict: true };
    return { ok: false, fieldErrors: { editorial_status: "Questão não está num status editável." } };
  }

  // v1.2, Correção B — valida TODOS os demais resultados do lote contra a
  // expectativa declarada de cada statement (defesa em profundidade — os
  // triggers de 0009/0010 já teriam abortado a transação inteira antes
  // deste ponto se núcleo/histórico/coleções divergissem; esta checagem
  // cobre outras inconsistências e nunca deveria disparar em operação
  // normal). Exclui tanto o UPDATE central quanto a checagem-marcador
  // (últimos dois statements) — só os filhos (coleções + histórico) têm
  // expectativa declarada aqui.
  validateBatchResults(
    results.slice(0, -2),
    childStatements.map((c) => c.expectation)
  );

  // audit_log só quando a mutação REALMENTE aconteceu (changed:true) —
  // nunca em no-op nem em retry idempotente (ambos retornam antes de chegar
  // aqui).
  await recordAuditEvent(db, newId(), "editorial_question_updated", actorUserId, {
    questionId,
    fields: changedFields.join(","),
  });

  return { ok: true, changed: true, value: { id: questionId } };
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
  // v1.3 — guardado pela versão ATUAL (`params.expectedVersion`), não pela
  // resultante, e inserido ANTES do UPDATE da transição no mesmo lote (ver
  // nota extensa em updateQuestion acima e
  // migrations/0009_editorial_batch_invariants.sql): se a transição de fato
  // mudar `version`, o trigger exige que este histórico já exista.
  const historyId = newId();
  const historyStatement = buildConditionalHistoryStatement(db, {
    id: historyId,
    questionId: params.questionId,
    userId: params.actorUserId,
    action: params.action,
    fromStatus: before.editorial_status,
    toStatus: params.to,
    guardVersion: params.expectedVersion,
    versionAfter,
    // MESMA lista `fromStatuses` do UPDATE da transição
    // (buildTransitionStatement) — guards idênticos, só podem concordar (v1.3).
    guardStatuses: params.from,
    metadata: params.metadata ?? null,
  });

  // v1.4 — mesmo mecanismo de marker-row de updateQuestion: transição nunca
  // toca coleções, então todas as contagens ficam `null` (nada a conferir
  // além de núcleo<->histórico).
  const mutationCheck = buildMutationCheckStatement(db, {
    id: newId(),
    questionId: params.questionId,
    expectedVersion: versionAfter,
    alternativesExpectedCount: null,
    dnaExpectedCount: null,
    patternsExpectedCount: null,
    tagsExpectedCount: null,
    imagesExpectedCount: null,
  });

  // v1.3 — histórico PRIMEIRO, UPDATE da transição POR ÚLTIMO (dispara o
  // trigger de 0009 quando `version` realmente muda). v1.4 — a
  // checagem-marcador roda por ÚLTIMA de todas, depois do UPDATE da
  // transição, para poder enxergar o resultado real dele mesmo quando ele
  // afeta 0 linhas silenciosamente.
  const [historyResult, updateResult] = await db.batch([historyStatement, transitionStatement, mutationCheck]);
  if (updateResult.meta.changes === 1) {
    // v1.2, Correção B — mantida como defesa em profundidade: os triggers de
    // 0009/0010 já teriam abortado a transação inteira (RAISE(ABORT)) antes
    // deste ponto se núcleo/histórico divergissem — esta checagem nunca
    // deveria disparar em operação normal.
    validateBatchResults([historyResult], [{ label: "INSERT question_history (transição)", expected: "exactlyOne" }]);
    return { ok: true, changed: true };
  }

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
