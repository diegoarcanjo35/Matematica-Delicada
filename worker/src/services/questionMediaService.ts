/* Serviço de mídia do Banco de Questões — Sprint 18, seções 8-13 da ordem.

   Deliberadamente um pipeline SEPARADO do resto de questionService.ts: upload
   e remoção de imagem nunca bumpam `questions.version`, nunca tocam
   `question_history`/`editorial_mutation_checks`/
   `question_collection_mutation_receipts` — nenhum desses triggers dispara
   por um INSERT/DELETE isolado em `question_images` (0009 reage a UPDATE em
   `questions` com version alterada; 0010/0011/0012 reagem a INSERT em
   `editorial_mutation_checks`/`question_collection_mutation_receipts`,
   nunca diretamente a `question_images`) — confirmado lendo os próprios
   triggers antes de desenhar este serviço. Isso é o que a ordem pede
   textualmente: "imagens passam a ter endpoints/operações dedicados".

   Consistência R2<->D1 (seção 12 da ordem) — D1 e R2 NUNCA compartilham uma
   transação:
     ADD:    valida tudo -> gera imageId/mutationId estável -> grava no R2 ->
             grava metadado no D1 -> se o D1 falhar depois de um upload NOVO
             desta chamada, apaga o objeto R2 recém-criado (nunca deixa D1
             apontando para nada e nunca deixa um objeto R2 conscientemente
             solto sem tentar limpar).
     DELETE: remove a referência D1 PRIMEIRO -> só depois tenta remover do
             R2 -> se a limpeza R2 falhar, o pior estado aceitável é um
             objeto R2 órfão (nunca uma questão apontando para um objeto
             ausente). */

import {
  ALLOWED_IMAGE_UPLOAD_MIME_TYPES,
  MAX_IMAGES_PER_QUESTION,
  MAX_IMAGE_UPLOAD_BYTES,
  buildR2AssetKey,
  validateImageAltText,
  validateImageCaption,
  validateImagePlacement,
  type AllowedImageUploadMimeType,
} from "../lib/questionsValidation";
import { isDeclaredMimeConsistent, sniffImageMimeType } from "../lib/imageSniffing";
import { sha256HexOfBytes } from "../lib/crypto";
import {
  buildGuardedQuestionImageAuditStatement,
  buildStandaloneDeleteImageStatement,
  buildStandaloneInsertImageStatement,
  buildStandaloneUpdateImageMetadataStatement,
  countImagesForQuestion,
  findImageById,
  findQuestionById,
  type QuestionImageRow,
} from "../repositories/questionRepository";
import type { AuditEventType } from "../repositories/auditRepository";

export interface QuestionImageDto {
  id: string;
  assetRef: string;
  altText: string;
  caption: string | null;
  position: number;
  placement: "enunciado" | "alternativa";
  alternativeLetter: string | null;
  /** Sprint 18.1, seção C da correção — o cliente precisa saber qual regime
   *  de exibição usar: 'r2' vai por /api/question-media/:id (rota
   *  controlada); 'local' é um asset estático do próprio repositório
   *  (compatibilidade com imagens pré-Sprint-18, nunca servidas por
   *  question-media). */
  storageKind: "local" | "r2";
}

function toImageDto(row: QuestionImageRow): QuestionImageDto {
  return {
    id: row.id,
    assetRef: row.asset_ref,
    altText: row.alt_text,
    caption: row.caption,
    position: row.position,
    placement: row.placement,
    alternativeLetter: row.alternative_letter,
    storageKind: row.storage_kind,
  };
}

/** Sprint 18.1, seção F da correção — metadado mínimo aceitável para a
 *  trilha de auditoria do pipeline de imagens: NUNCA bytes, alt text
 *  completo, nome original de arquivo ou conteúdo da questão — só os
 *  identificadores técnicos que provam O QUE mudou, nunca o CONTEÚDO. */
function buildImageAuditMetadata(params: {
  questionId: string;
  imageId: string;
  placement: "enunciado" | "alternativa";
  alternativeLetter: string | null;
  storageKind: "local" | "r2";
}): Record<string, string | number | boolean> {
  const metadata: Record<string, string | number | boolean> = {
    questionId: params.questionId,
    imageId: params.imageId,
    placement: params.placement,
    storageKind: params.storageKind,
  };
  if (params.alternativeLetter) metadata.alternativeLetter = params.alternativeLetter;
  return metadata;
}

/* Mesmo formato "achatado" (um único tipo, campos de motivo de falha todos
 *  opcionais) já usado por MutationResult<T> em questionService.ts — nunca
 *  uma union discriminada aqui, para que `result.notFound`/`result.conflict`
 *  etc. sejam acessíveis diretamente pela rota sem narrowing extra. */
export interface AddImageResult {
  ok: boolean;
  value?: QuestionImageDto;
  changed?: boolean;
  notFound?: boolean;
  forbidden?: boolean;
  conflict?: boolean;
  fieldErrors?: Record<string, string>;
}

function questionEditableStatusError(status: string): Record<string, string> {
  return status === "published"
    ? { editorial_status: "Questão publicada não pode ter mídia alterada diretamente nesta sprint." }
    : { editorial_status: "Questão não está num status editável." };
}

export async function addQuestionImage(
  db: D1Database,
  bucket: R2Bucket,
  questionId: string,
  actorUserId: string,
  input: {
    mutationId: string;
    placement: unknown;
    alternativeLetter: unknown;
    altText: unknown;
    caption: unknown;
    fileBytes: Uint8Array;
    declaredMimeType: string | null;
  }
): Promise<AddImageResult> {
  // Sprint 18.1, seção G da correção — ORDEM obrigatória: 1) validar/
  // sniffar/hashear o REQUEST inteiro (nunca depende de estado do banco);
  // 2) só então verificar se este mutationId já foi aplicado (retry); 3) só
  // para uma operação GENUINAMENTE NOVA (mutationId nunca visto), aplicar o
  // gate de status editável. Isso é o que permite um retry LEGÍTIMO
  // continuar reconhecido mesmo que a questão tenha mudado de status depois
  // da primeira aplicação — a prova de "já foi feito" é a IDENTIDADE exata
  // da operação, nunca o status atual da questão.
  const placementResult = validateImagePlacement(input.placement, input.alternativeLetter);
  if (!placementResult.ok) return { ok: false, fieldErrors: { placement: placementResult.error! } };
  const altTextResult = validateImageAltText(input.altText);
  if (!altTextResult.ok) return { ok: false, fieldErrors: { altText: altTextResult.error! } };
  const captionResult = validateImageCaption(input.caption);
  if (!captionResult.ok) return { ok: false, fieldErrors: { caption: captionResult.error! } };

  if (input.fileBytes.byteLength === 0) return { ok: false, fieldErrors: { file: "Arquivo vazio." } };
  if (input.fileBytes.byteLength > MAX_IMAGE_UPLOAD_BYTES) {
    return { ok: false, fieldErrors: { file: `Arquivo excede o limite de ${MAX_IMAGE_UPLOAD_BYTES} bytes.` } };
  }

  const sniffed = sniffImageMimeType(input.fileBytes);
  if (!sniffed) {
    return {
      ok: false,
      fieldErrors: { file: `Formato de imagem não reconhecido. Aceitos: ${ALLOWED_IMAGE_UPLOAD_MIME_TYPES.join(", ")}.` },
    };
  }
  if (!isDeclaredMimeConsistent(input.declaredMimeType, sniffed)) {
    return { ok: false, fieldErrors: { file: "O tipo declarado do arquivo não corresponde ao conteúdo real." } };
  }

  const altText = altTextResult.value!;
  const caption = captionResult.value ?? null;
  const placement = placementResult.value!.placement;
  const alternativeLetter = placementResult.value!.alternativeLetter;
  const contentSha256 = await sha256HexOfBytes(input.fileBytes);

  // 2) Retry — reconhecido SÓ quando TODOS os componentes de identidade da
  //    operação coincidem com o que já foi gravado sob este mutationId.
  //    Qualquer divergência (arquivo diferente, altText diferente,
  //    placement diferente, etc.) é 409 — nunca um "sucesso" silencioso
  //    sobre dados diferentes de um mutationId reutilizado por engano.
  const existingByMutationId = await findImageById(db, input.mutationId);
  if (existingByMutationId) {
    if (existingByMutationId.question_id !== questionId) return { ok: false, conflict: true };
    const identityMatches =
      existingByMutationId.placement === placement &&
      existingByMutationId.alternative_letter === alternativeLetter &&
      existingByMutationId.alt_text === altText &&
      (existingByMutationId.caption ?? null) === caption &&
      existingByMutationId.mime_type === sniffed &&
      existingByMutationId.size_bytes === input.fileBytes.byteLength &&
      existingByMutationId.content_sha256 === contentSha256;
    if (!identityMatches) return { ok: false, conflict: true };
    return { ok: true, changed: false, value: toImageDto(existingByMutationId) };
  }

  // 3) Operação GENUINAMENTE NOVA — só agora o gate de status se aplica.
  const question = await findQuestionById(db, questionId);
  if (!question) return { ok: false, notFound: true };
  if (question.editorial_status !== "draft" && question.editorial_status !== "changes_requested") {
    return { ok: false, fieldErrors: questionEditableStatusError(question.editorial_status) };
  }

  const existingCount = await countImagesForQuestion(db, questionId);
  if (existingCount >= MAX_IMAGES_PER_QUESTION) {
    return { ok: false, fieldErrors: { file: `Esta questão já atingiu o limite de ${MAX_IMAGES_PER_QUESTION} imagens.` } };
  }

  const imageId = input.mutationId;
  const assetRef = buildR2AssetKey(questionId, imageId, sniffed as AllowedImageUploadMimeType);

  // 1) Grava no R2 PRIMEIRO. Se o passo seguinte (D1) falhar, este objeto é
  //    o que precisa ser limpo (seção 12 da ordem) — nunca o contrário
  //    (nunca gravamos metadado no D1 apontando para um objeto que ainda
  //    não existe no R2).
  await bucket.put(assetRef, input.fileBytes, { httpMetadata: { contentType: sniffed } });

  try {
    const result = await db.batch([
      buildStandaloneInsertImageStatement(db, {
        id: imageId,
        questionId,
        assetRef,
        altText,
        caption,
        position: existingCount,
        placement,
        alternativeLetter,
        storageKind: "r2",
        mimeType: sniffed,
        sizeBytes: input.fileBytes.byteLength,
        contentSha256,
      }),
      // Sprint 18.1, seção F — mesmo batch da imagem: só grava trilha
      // quando a imagem REALMENTE foi inserida nesta chamada (mesma guarda
      // de status, ver buildGuardedQuestionImageAuditStatement).
      buildGuardedQuestionImageAuditStatement(db, {
        id: input.mutationId,
        questionId,
        eventType: "editorial_question_image_added" satisfies AuditEventType,
        userId: actorUserId,
        metadata: buildImageAuditMetadata({ questionId, imageId, placement, alternativeLetter, storageKind: "r2" }),
      }),
    ]);
    if (result[0].meta.changes !== 1) {
      // O guard (status editável) falhou entre a checagem acima e agora —
      // corrida real, rara. O objeto R2 recém-criado NESTA chamada nunca
      // pode ficar solto sem tentativa de limpeza.
      await safeDeleteR2Object(bucket, assetRef);
      const after = await findQuestionById(db, questionId);
      if (!after) return { ok: false, notFound: true };
      return { ok: false, fieldErrors: questionEditableStatusError(after.editorial_status) };
    }
  } catch (error) {
    // Falha real do D1 após um upload NOVO desta operação — remove o objeto
    // R2 recém-criado (seção 12 da ordem: "se D1 falhar após um upload NOVO
    // desta operação, remover o objeto criado"). Nunca deixa D1 apontando
    // conscientemente para um objeto inexistente é o caso oposto (aqui é o
    // R2 que sobrou sem D1 — o mesmo cuidado de limpeza, direção inversa).
    await safeDeleteR2Object(bucket, assetRef);
    throw error;
  }

  const row = await findImageById(db, imageId);
  if (!row) return { ok: false, notFound: true };
  return { ok: true, changed: true, value: toImageDto(row) };
}

async function safeDeleteR2Object(bucket: R2Bucket, key: string): Promise<void> {
  try {
    await bucket.delete(key);
  } catch (error) {
    // Nunca guardar conteúdo sensível/integral no log (seção 20 da ordem) —
    // só a chave técnica (nunca é PII) e o fato de a limpeza ter falhado.
    // Pior estado aceitável documentado na seção 12: um objeto R2 órfão.
    console.error("questionMediaService: falha ao limpar objeto R2 órfão", { key, error: error instanceof Error ? error.message : String(error) });
  }
}

/* ------------------------------ Metadado (alt text) -------------------------
   Sprint 18.1, seção B da correção — edição dedicada de alt text/legenda,
   SEM tocar bytes/R2/asset_ref. Andreia não precisa mais remover e reenviar
   uma imagem só para corrigir a descrição. */

export interface UpdateImageMetadataResult {
  ok: boolean;
  value?: QuestionImageDto;
  changed?: boolean;
  notFound?: boolean;
  fieldErrors?: Record<string, string>;
}

export async function updateQuestionImageMetadata(
  db: D1Database,
  questionId: string,
  imageId: string,
  actorUserId: string,
  input: { mutationId: string; altText: unknown; caption: unknown }
): Promise<UpdateImageMetadataResult> {
  const image = await findImageById(db, imageId);
  if (!image || image.question_id !== questionId) return { ok: false, notFound: true };

  const question = await findQuestionById(db, questionId);
  if (!question) return { ok: false, notFound: true };
  if (question.editorial_status !== "draft" && question.editorial_status !== "changes_requested") {
    return { ok: false, fieldErrors: questionEditableStatusError(question.editorial_status) };
  }

  const altTextResult = validateImageAltText(input.altText);
  if (!altTextResult.ok) return { ok: false, fieldErrors: { altText: altTextResult.error! } };
  const captionResult = validateImageCaption(input.caption);
  if (!captionResult.ok) return { ok: false, fieldErrors: { caption: captionResult.error! } };

  const newAltText = altTextResult.value!;
  const newCaption = captionResult.value ?? null;
  const changed = newAltText !== image.alt_text || newCaption !== (image.caption ?? null);
  if (!changed) {
    // Idempotente: reenviar exatamente o que já está gravado nunca duplica
    // trilha de auditoria nem toca o banco (seção F da correção: "auditar
    // somente quando changed=true").
    return { ok: true, changed: false, value: toImageDto(image) };
  }

  const result = await db.batch([
    buildStandaloneUpdateImageMetadataStatement(db, { id: imageId, questionId, altText: newAltText, caption: newCaption }),
    buildGuardedQuestionImageAuditStatement(db, {
      id: input.mutationId,
      questionId,
      eventType: "editorial_question_image_updated" satisfies AuditEventType,
      userId: actorUserId,
      metadata: buildImageAuditMetadata({
        questionId,
        imageId,
        placement: image.placement,
        alternativeLetter: image.alternative_letter,
        storageKind: image.storage_kind,
      }),
    }),
  ]);
  if (result[0].meta.changes !== 1) {
    const after = await findQuestionById(db, questionId);
    if (!after) return { ok: false, notFound: true };
    return { ok: false, fieldErrors: questionEditableStatusError(after.editorial_status) };
  }

  const row = await findImageById(db, imageId);
  if (!row) return { ok: false, notFound: true };
  return { ok: true, changed: true, value: toImageDto(row) };
}

/* --------------------------------- Leitura --------------------------------- */

export interface ImageDeliveryInfo {
  image: QuestionImageRow;
  questionEditorialStatus: string;
  /** Sprint 18.1, seção D da correção — a rota de mídia precisa saber se a
   *  questão dona da imagem é uma FIXTURE TÉCNICA LOCAL para aplicar o
   *  MESMO gate fail-closed já usado para conteúdo do aluno (nunca vaza
   *  fixture fora de dev local com a flag explícita, mesmo que a fixture
   *  esteja, por erro, marcada como `published`). */
  isLocalFixture: boolean;
}

/** Sprint 18, seção 13 da ordem — busca o metadado da imagem E o status da
 *  questão associada, para a ROTA decidir autorização (editor/admin sempre;
 *  aluno autenticado só quando `published`) sem duplicar a lógica de RBAC
 *  aqui. Nunca aceita nem devolve uma object key arbitrária — o chamador só
 *  tem acesso ao ID técnico da imagem, nunca à chave R2 em si (exposta só
 *  internamente, para o próprio `bucket.get()`). */
export async function findImageForDelivery(db: D1Database, imageId: string): Promise<ImageDeliveryInfo | null> {
  const image = await findImageById(db, imageId);
  if (!image) return null;
  const question = await findQuestionById(db, image.question_id);
  if (!question) return null;
  return { image, questionEditorialStatus: question.editorial_status, isLocalFixture: question.is_local_fixture === 1 };
}

export interface DeleteImageResult {
  ok: boolean;
  changed?: boolean;
  notFound?: boolean;
  fieldErrors?: Record<string, string>;
}

export async function deleteQuestionImage(
  db: D1Database,
  bucket: R2Bucket,
  questionId: string,
  imageId: string,
  actorUserId: string
): Promise<DeleteImageResult> {
  const image = await findImageById(db, imageId);
  if (!image || image.question_id !== questionId) {
    // Já não existe (ou nunca existiu para esta questão) — remoção
    // repetida é idempotente, nunca um erro assustador para um duplo-clique.
    return { ok: true, changed: false };
  }

  const question = await findQuestionById(db, questionId);
  if (!question) return { ok: false, notFound: true };
  if (question.editorial_status !== "draft" && question.editorial_status !== "changes_requested") {
    return { ok: false, fieldErrors: questionEditableStatusError(question.editorial_status) };
  }

  // 1) D1 primeiro (seção 12 da ordem) — a referência precisa deixar de
  //    existir ANTES de qualquer tentativa de apagar o objeto do R2. Mesmo
  //    batch da auditoria (seção F da correção) — só grava trilha quando a
  //    remoção realmente aconteceu nesta chamada (mesma guarda).
  const result = await db.batch([
    buildStandaloneDeleteImageStatement(db, imageId, questionId),
    buildGuardedQuestionImageAuditStatement(db, {
      id: crypto.randomUUID(),
      questionId,
      eventType: "editorial_question_image_removed" satisfies AuditEventType,
      userId: actorUserId,
      metadata: buildImageAuditMetadata({
        questionId,
        imageId,
        placement: image.placement,
        alternativeLetter: image.alternative_letter,
        storageKind: image.storage_kind,
      }),
    }),
  ]);
  if (result[0].meta.changes !== 1) {
    // Guard falhou entre a checagem acima e agora (corrida rara) — nada foi
    // removido, nenhuma limpeza R2 é tentada.
    return { ok: false, fieldErrors: questionEditableStatusError(question.editorial_status) };
  }

  // 2) só depois, melhor esforço no R2 — se falhar, o pior estado aceitável
  //    é objeto órfão (nunca reverte o DELETE do D1, nunca lança para o
  //    chamador: o objetivo do usuário — "a imagem sumiu da questão" — já
  //    foi alcançado e confirmado no D1).
  if (image.storage_kind === "r2") {
    await safeDeleteR2Object(bucket, image.asset_ref);
  }

  return { ok: true, changed: true };
}
