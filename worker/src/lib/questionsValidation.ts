/* Validação e constantes técnicas do Banco de Questões — Sprint 7 v1.0.
   Mesma convenção de patternsValidation.ts/scheduleValidation.ts: enums
   fechados e validação de parâmetro vivem só aqui; rotas/serviço apenas
   chamam estas funções. Invariantes que o SQLite/D1 NÃO consegue expressar
   num CHECK de linha única (exatamente 5 alternativas, exatamente uma
   correta, padrão principal presente antes de revisão, imagem com alt antes
   de revisão, DNA completo antes de aprovação/publicação) são impostas aqui
   e aplicadas pelo serviço — nunca só na interface. */

export const QUESTION_EDITORIAL_STATUSES = [
  "draft",
  "in_review",
  "changes_requested",
  "approved",
  "published",
  "archived",
] as const;
export type QuestionEditorialStatus = (typeof QUESTION_EDITORIAL_STATUSES)[number];

export const QUESTION_DIFFICULTIES = ["facil", "media", "dificil"] as const;
export type QuestionDifficulty = (typeof QUESTION_DIFFICULTIES)[number];

export const QUESTION_ORIGINS = [
  "oficial",
  "autoral",
  "licenciada",
  "diagnostico",
  "reconhecimento",
  "revisao_base",
] as const;
export type QuestionOrigin = (typeof QUESTION_ORIGINS)[number];

export const QUESTION_CALCULATION_TYPES = ["mental", "escrito", "misto"] as const;
export type QuestionCalculationType = (typeof QUESTION_CALCULATION_TYPES)[number];

export const QUESTION_ALTERNATIVE_LETTERS = ["A", "B", "C", "D", "E"] as const;
export type QuestionAlternativeLetter = (typeof QUESTION_ALTERNATIVE_LETTERS)[number];

export const QUESTION_PATTERN_ROLES = ["principal", "secundario"] as const;
export type QuestionPatternRole = (typeof QUESTION_PATTERN_ROLES)[number];

export const EDITORIAL_ROLES = ["editor", "admin"] as const;
export type EditorialRole = (typeof EDITORIAL_ROLES)[number];

export const ALL_ROLES = ["student", "teacher", "editor", "admin", "support", "commercial"] as const;
export type Role = (typeof ALL_ROLES)[number];

/* Matriz de transição do workflow editorial (seção 6 da ordem). Chave =
   estado de origem; valor = conjunto de estados de destino alcançáveis
   diretamente. `archived` é alcançável de qualquer estado elegível
   (qualquer estado não-`published`) — modelado explicitamente abaixo para
   nunca depender de um "else" implícito. */
export const QUESTION_TRANSITIONS: Record<QuestionEditorialStatus, QuestionEditorialStatus[]> = {
  draft: ["in_review", "archived"],
  in_review: ["changes_requested", "approved", "archived"],
  changes_requested: ["in_review", "archived"],
  approved: ["published", "archived"],
  published: [],
  archived: [],
};

export function isValidTransition(from: QuestionEditorialStatus, to: QuestionEditorialStatus): boolean {
  return QUESTION_TRANSITIONS[from]?.includes(to) ?? false;
}

/* Papel mínimo exigido por transição — "editor" cobre editor E admin
   (admin herda tudo do editor); "admin" exige estritamente admin. */
export const TRANSITION_MIN_ROLE: Record<string, "editor" | "admin"> = {
  "draft->in_review": "editor",
  "changes_requested->in_review": "editor",
  "in_review->changes_requested": "admin",
  "in_review->approved": "admin",
  "approved->published": "admin",
  "draft->archived": "admin",
  "in_review->archived": "admin",
  "changes_requested->archived": "admin",
  "approved->archived": "admin",
};

export function transitionKey(from: string, to: string): string {
  return `${from}->${to}`;
}

export interface FieldValidationResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

function ok<T>(value: T): FieldValidationResult<T> {
  return { ok: true, value };
}
function fail<T>(error: string): FieldValidationResult<T> {
  return { ok: false, error };
}

export const QUESTIONS_DEFAULT_LIMIT = 20;
export const QUESTIONS_MAX_LIMIT = 100;
export const QUESTION_CODE_MAX_LENGTH = 40;
export const QUESTION_TEXT_MAX_LENGTH = 8000;
export const QUESTION_SHORT_FIELD_MAX_LENGTH = 300;

const CODE_RE = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,38}[A-Za-z0-9])?$/;

export function isValidQuestionCode(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= QUESTION_CODE_MAX_LENGTH && CODE_RE.test(value);
}

/* Sprint 18, seção 3 da ordem — "código editorial técnico" sai da interface
   operacional da Andreia. Quando o cliente não fornece `code` (questão
   manual nova), o SERVIDOR gera um identificador técnico único e estável:
   "Q-" + UUID (39 chars, dentro do limite de QUESTION_CODE_MAX_LENGTH=40 e
   compatível com CODE_RE — hífen no meio é permitido, começa/termina em
   caractere alfanumérico). Unicidade prática garantida pelo próprio UUID
   (mesmo raciocínio já usado para `code`/`slug` de padrões na Sprint 17 —
   patternsAdminService.ts) — nenhuma consulta extra de existência
   necessária antes do INSERT (o índice UNIQUE em questions.code continua
   como defesa de banco em profundidade). NUNCA usado para uma questão já
   existente (código antigo é sempre preservado) nem quando o cliente/
   importador CSV já envia um `code` explícito (seção 3: "não quebrar o
   fluxo existente que envia códigos editoriais explícitos"). */
export function generateQuestionCode(): string {
  return `Q-${crypto.randomUUID()}`;
}

export function isValidQuestionId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 100;
}

/** Sprint 7 v1.2, Correção A — `mutationId` gerado pelo cliente para o
 *  PATCH. Aceita qualquer UUID bem formado (RFC 4122, qualquer versão —
 *  `crypto.randomUUID()` do navegador gera v4, mas não exigimos a versão
 *  exata para não acoplar a validação a uma implementação de geração
 *  específica). Reaproveitado como `question_history.id` (chave primária) —
 *  por isso PRECISA ser um formato compatível com o que já é aceito ali
 *  (TEXT), e a unicidade real é garantida pela PK da tabela, nunca só por
 *  este regex. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidMutationId(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export function validateNonEmptyText(
  value: unknown,
  fieldLabel: string,
  maxLength = QUESTION_TEXT_MAX_LENGTH
): FieldValidationResult<string> {
  if (typeof value !== "string") return fail(`${fieldLabel} é obrigatório.`);
  const trimmed = value.trim();
  if (trimmed.length === 0) return fail(`${fieldLabel} não pode ser vazio.`);
  if (value.length > maxLength) return fail(`${fieldLabel} não pode passar de ${maxLength} caracteres.`);
  return ok(value);
}

export function validateOptionalText(
  value: unknown,
  fieldLabel: string,
  maxLength = QUESTION_TEXT_MAX_LENGTH
): FieldValidationResult<string | null> {
  if (value === null || value === undefined) return ok(null);
  if (typeof value !== "string") return fail(`${fieldLabel} inválido.`);
  if (value.length > maxLength) return fail(`${fieldLabel} não pode passar de ${maxLength} caracteres.`);
  return ok(value);
}

export function validateDifficulty(value: unknown): FieldValidationResult<QuestionDifficulty> {
  if (typeof value !== "string" || !(QUESTION_DIFFICULTIES as readonly string[]).includes(value)) {
    return fail("Dificuldade inválida.");
  }
  return ok(value as QuestionDifficulty);
}

export function validateOrigin(value: unknown): FieldValidationResult<QuestionOrigin> {
  if (typeof value !== "string" || !(QUESTION_ORIGINS as readonly string[]).includes(value)) {
    return fail("Origem/tipo inválido.");
  }
  return ok(value as QuestionOrigin);
}

export function validateCalculationType(value: unknown): FieldValidationResult<QuestionCalculationType> {
  if (value === undefined || value === null) return ok("misto");
  if (typeof value !== "string" || !(QUESTION_CALCULATION_TYPES as readonly string[]).includes(value)) {
    return fail("Tipo de cálculo inválido.");
  }
  return ok(value as QuestionCalculationType);
}

export function validateYear(value: unknown): FieldValidationResult<number | null> {
  if (value === null || value === undefined || value === "") return ok(null);
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1990 || value > 2100) {
    return fail("Ano inválido.");
  }
  return ok(value);
}

export function validateEstimatedSeconds(value: unknown): FieldValidationResult<number | null> {
  if (value === null || value === undefined || value === "") return ok(null);
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > 3600) {
    return fail("Tempo estimado inválido.");
  }
  return ok(value);
}

export function validateBoolean01(value: unknown, fieldLabel: string): FieldValidationResult<0 | 1> {
  if (typeof value !== "boolean") return fail(`${fieldLabel} inválido.`);
  return ok(value ? 1 : 0);
}

/* --------------------------- Alternativas (5.2) -------------------------- */

export interface AlternativeInput {
  letter: QuestionAlternativeLetter;
  text: string;
  isCorrect: boolean;
  distractorExplanation: string | null;
}

/** Valida o conjunto completo de alternativas de uma vez — as invariantes
 *  "exatamente 5", "letras A-E sem duplicidade" e "exatamente uma correta"
 *  só fazem sentido olhando o array inteiro (impossível num CHECK de linha
 *  única do SQLite/D1). Chamado pelo serviço antes de qualquer escrita. */
export function validateAlternativeSet(value: unknown): FieldValidationResult<AlternativeInput[]> {
  if (!Array.isArray(value)) return fail("Alternativas inválidas.");
  if (value.length !== 5) return fail("É necessário informar exatamente 5 alternativas (A-E).");

  const seenLetters = new Set<string>();
  const parsed: AlternativeInput[] = [];
  let correctCount = 0;

  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) return fail("Alternativa inválida.");
    const item = raw as Record<string, unknown>;
    const letter = item.letter;
    if (typeof letter !== "string" || !(QUESTION_ALTERNATIVE_LETTERS as readonly string[]).includes(letter)) {
      return fail("Letra de alternativa inválida.");
    }
    if (seenLetters.has(letter)) return fail(`Letra ${letter} duplicada entre as alternativas.`);
    seenLetters.add(letter);

    const text = item.text;
    if (typeof text !== "string" || text.trim().length === 0) {
      return fail(`Texto da alternativa ${letter} não pode ser vazio.`);
    }
    if (text.length > QUESTION_TEXT_MAX_LENGTH) {
      return fail(`Texto da alternativa ${letter} excede o tamanho máximo.`);
    }

    const isCorrect = item.isCorrect;
    if (typeof isCorrect !== "boolean") return fail(`Indicação de correta da alternativa ${letter} inválida.`);
    if (isCorrect) correctCount++;

    const distractorExplanation = item.distractorExplanation;
    if (
      distractorExplanation !== null &&
      distractorExplanation !== undefined &&
      typeof distractorExplanation !== "string"
    ) {
      return fail(`Explicação do distrator da alternativa ${letter} inválida.`);
    }

    parsed.push({
      letter: letter as QuestionAlternativeLetter,
      text,
      isCorrect,
      distractorExplanation: (distractorExplanation as string | null | undefined) ?? null,
    });
  }

  for (const letter of QUESTION_ALTERNATIVE_LETTERS) {
    if (!seenLetters.has(letter)) return fail(`Falta a alternativa ${letter}.`);
  }
  if (correctCount !== 1) return fail("É necessário indicar exatamente uma alternativa correta.");

  return ok(parsed);
}

/** Sprint 7 v1.1, Correção A — variante usada SÓ pelo PATCH parcial:
 *  `alternativas: []` é uma limpeza EXPLÍCITA (o serviço decide, pelo status
 *  atual, se ela é permitida) — nunca confundida com "campo ausente"
 *  (ausência é tratada antes de chamar esta função, e nem chama). Qualquer
 *  array não-vazio continua exigindo o conjunto completo e válido de A-E via
 *  `validateAlternativeSet`. */
export function validateAlternativeSetForPatch(value: unknown): FieldValidationResult<AlternativeInput[]> {
  if (Array.isArray(value) && value.length === 0) return ok([]);
  return validateAlternativeSet(value);
}

/* ------------------------------ DNA (5.5) --------------------------------- */

export interface QuestionDnaInput {
  pista: string;
  estrategia: string;
  pegadinha: string;
  conteudoApoio: string;
  resolucao: string;
  atalho: string | null;
  aprendizadoErro: string;
}

export function validateQuestionDna(value: unknown): FieldValidationResult<QuestionDnaInput> {
  if (typeof value !== "object" || value === null) return fail("DNA da questão inválido.");
  const item = value as Record<string, unknown>;
  const get = (key: string): string => (typeof item[key] === "string" ? (item[key] as string) : "");

  const parsed: QuestionDnaInput = {
    pista: get("pista"),
    estrategia: get("estrategia"),
    pegadinha: get("pegadinha"),
    conteudoApoio: get("conteudoApoio"),
    resolucao: get("resolucao"),
    atalho: typeof item.atalho === "string" ? item.atalho : null,
    aprendizadoErro: get("aprendizadoErro"),
  };

  for (const key of Object.keys(parsed) as Array<keyof QuestionDnaInput>) {
    const v = parsed[key];
    if (typeof v === "string" && v.length > QUESTION_TEXT_MAX_LENGTH) {
      return fail(`Campo de DNA "${key}" excede o tamanho máximo.`);
    }
  }

  return ok(parsed);
}

/** Sprint 18, seção 6/7 da ordem — substitui `isDnaComplete` (Sprint 7),
 *  que exigia os SEIS campos legados do DNA (pista, estrategia, pegadinha,
 *  conteudoApoio, resolucao, aprendizadoErro) inteiros. A Andreia aprovou
 *  um modelo simplificado onde ela só edita "Macete / Como resolver"
 *  (`dna.estrategia`); manter uma função chamada `isDnaComplete` checando
 *  os seis campos legados ficaria com um NOME ENGANOSO (o produto não exige
 *  mais isso) — por isso ela foi removida, não apenas alterada por dentro.
 *  Esta função tem o nome e o escopo corretos para o gate atual: só os dois
 *  dados pedagógicos mínimos que a ordem lista como "realmente necessários"
 *  para aprovação/publicação, um deles nem sequer é campo de DNA
 *  (`resolucaoComentada` é coluna de `questions`, não de `question_dna`).
 *  Os demais campos legados do DNA (pista/pegadinha/conteudoApoio/
 *  resolucao/aprendizadoErro/atalho) NUNCA são exigidos por este gate —
 *  continuam podendo ficar vazios indefinidamente numa questão nova, e
 *  continuam preservados tal como estavam numa questão legada (ver
 *  updateQuestion, questionService.ts — este gate não altera nada sobre
 *  como esses campos são lidos/gravados). */
export function hasMinimumPedagogicalContentForApproval(resolucaoComentada: string, estrategia: string): boolean {
  return resolucaoComentada.trim().length > 0 && estrategia.trim().length > 0;
}

/* --------------------------- Padrões (5.4) -------------------------------- */

export interface QuestionPatternInput {
  patternId: string;
  role: QuestionPatternRole;
}

export function validatePatternLinks(value: unknown): FieldValidationResult<QuestionPatternInput[]> {
  if (!Array.isArray(value)) return fail("Padrões vinculados inválidos.");
  const seen = new Set<string>();
  let principalCount = 0;
  const parsed: QuestionPatternInput[] = [];

  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) return fail("Vínculo de padrão inválido.");
    const item = raw as Record<string, unknown>;
    const patternId = item.patternId;
    const role = item.role;
    if (typeof patternId !== "string" || patternId.length === 0) return fail("ID de padrão inválido.");
    if (typeof role !== "string" || !(QUESTION_PATTERN_ROLES as readonly string[]).includes(role)) {
      return fail("Papel do padrão inválido (principal/secundário).");
    }
    if (seen.has(patternId)) {
      return fail("O mesmo padrão não pode ser vinculado mais de uma vez (nem como principal e secundário simultaneamente).");
    }
    seen.add(patternId);
    if (role === "principal") principalCount++;
    parsed.push({ patternId, role: role as QuestionPatternRole });
  }

  if (principalCount > 1) return fail("Só pode haver um padrão principal.");
  return ok(parsed);
}

export function hasPrincipalPattern(links: QuestionPatternInput[]): boolean {
  return links.some((link) => link.role === "principal");
}

/* ---------------------------- Imagens (5.3) -------------------------------- */

export interface QuestionImageInput {
  id?: string;
  assetRef: string;
  altText: string;
  caption: string | null;
  position: number;
  titularDireitos: string | null;
  baseLicenca: string | null;
}

/** Referência de asset local do repositório — nunca uma URL externa
 *  arbitrária (seção 5.3 da ordem). Aceita apenas caminhos relativos dentro
 *  de /assets/questoes/, sem esquema, sem "..", sem barra dupla. */
const ASSET_REF_RE = /^assets\/questoes\/[A-Za-z0-9_/-]+\.(png|jpg|jpeg|svg|webp)$/;

export function isValidLocalAssetRef(value: unknown): value is string {
  return typeof value === "string" && value.length <= 200 && !value.includes("..") && ASSET_REF_RE.test(value);
}

export function validateQuestionImages(value: unknown): FieldValidationResult<QuestionImageInput[]> {
  if (value === undefined || value === null) return ok([]);
  if (!Array.isArray(value)) return fail("Imagens inválidas.");
  const parsed: QuestionImageInput[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) return fail("Imagem inválida.");
    const item = raw as Record<string, unknown>;
    if (!isValidLocalAssetRef(item.assetRef)) {
      return fail("Referência de imagem inválida — só assets locais do repositório são permitidos.");
    }
    const altText = typeof item.altText === "string" ? item.altText : "";
    if (altText.length > QUESTION_SHORT_FIELD_MAX_LENGTH) return fail("Texto alternativo da imagem excede o tamanho máximo.");
    const caption = typeof item.caption === "string" ? item.caption : null;
    const position = typeof item.position === "number" && Number.isInteger(item.position) ? item.position : parsed.length;
    parsed.push({
      id: typeof item.id === "string" ? item.id : undefined,
      assetRef: item.assetRef as string,
      altText,
      caption,
      position,
      titularDireitos: typeof item.titularDireitos === "string" ? item.titularDireitos : null,
      baseLicenca: typeof item.baseLicenca === "string" ? item.baseLicenca : null,
    });
  }
  return ok(parsed);
}

/** Imagem sem alt não pode avançar para revisão (seção 5.3). */
export function allImagesHaveAlt(images: QuestionImageInput[]): boolean {
  return images.every((image) => image.altText.trim().length > 0);
}

/* ------------------- Imagens via upload dedicado (Sprint 18) ---------------
   Seções 8-13 da ordem — endpoints PRÓPRIOS de imagem (upload/delete/serve),
   deliberadamente FORA da coleção `imagens` do PATCH geral acima (que
   permanece intocada, para quem ainda a usa — ex.: importação futura). Um
   upload novo nunca passa por `validateQuestionImages`/`isValidLocalAssetRef`
   (essas continuam existindo só para assets locais legados). */

export const QUESTION_IMAGE_PLACEMENTS = ["enunciado", "alternativa"] as const;
export type QuestionImagePlacement = (typeof QUESTION_IMAGE_PLACEMENTS)[number];

/** MIME real (sniffado pelo byte de assinatura no serviço, nunca só a
 *  extensão do arquivo) — seção 11 da ordem: PNG/JPEG/WebP; SVG NUNCA aceito
 *  em upload novo (risco de XSS via SVG inline — <script>/onload etc.). */
export const ALLOWED_IMAGE_UPLOAD_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type AllowedImageUploadMimeType = (typeof ALLOWED_IMAGE_UPLOAD_MIME_TYPES)[number];

export const MAX_IMAGE_UPLOAD_BYTES = 8 * 1024 * 1024; // 8 MB, seção 11 da ordem.
export const MAX_IMAGES_PER_QUESTION = 15; // seção 11 da ordem.

/** Sprint 18.1 (correção de auditoria, seção E) — teto do CORPO multipart
 *  inteiro (arquivo + boundary/campos de texto ao redor), verificado ANTES
 *  de `request.formData()` via um `Content-Length` OBRIGATÓRIO (nunca
 *  opcional — ver worker/src/routes/editorialQuestions.ts). Próximo do
 *  limite de arquivo + uma margem razoável de overhead de multipart (nunca
 *  um múltiplo arbitrário como "2x" o limite de arquivo, que na prática
 *  nunca rejeitava nada porque exigia um Content-Length que os clientes de
 *  teste/reais com corpo FormData tipicamente não enviam pré-calculado —
 *  ver nota extensa na rota). A checagem do tamanho REAL do arquivo, depois
 *  do parse, continua obrigatória e inalterada (MAX_IMAGE_UPLOAD_BYTES) —
 *  esta constante é só o teto do INVÓLUCRO multipart. */
export const MAX_IMAGE_MULTIPART_BYTES = MAX_IMAGE_UPLOAD_BYTES + 1024 * 1024; // 9 MB.

const MIME_TO_EXTENSION: Record<AllowedImageUploadMimeType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

export function extensionForImageMimeType(mimeType: AllowedImageUploadMimeType): string {
  return MIME_TO_EXTENSION[mimeType];
}

export function isAllowedImageUploadMimeType(value: unknown): value is AllowedImageUploadMimeType {
  return typeof value === "string" && (ALLOWED_IMAGE_UPLOAD_MIME_TYPES as readonly string[]).includes(value);
}

/** Object key R2 controlada — SEMPRE gerada pelo servidor
 *  (`questions/<questionId>/<imageId>.<ext>`), NUNCA aceita/derivada de
 *  entrada do cliente (seção 10 da ordem). Esta função existe para validar
 *  a própria chave que o servidor construiu antes de usá-la (defesa em
 *  profundidade — nunca confiar cegamente até numa string que "nós mesmos"
 *  montamos), e para reconhecer chaves já gravadas ao servir/apagar. Nunca
 *  aceita esquema (http/https), nunca ".." — mesmo espírito de
 *  isValidLocalAssetRef, namespace diferente. */
const R2_ASSET_KEY_RE = /^questions\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\.(png|jpg|webp)$/;

export function isValidR2AssetKey(value: unknown): value is string {
  return typeof value === "string" && value.length <= 200 && !value.includes("..") && !/^[a-z]+:\/\//i.test(value) && R2_ASSET_KEY_RE.test(value);
}

export function buildR2AssetKey(questionId: string, imageId: string, mimeType: AllowedImageUploadMimeType): string {
  return `questions/${questionId}/${imageId}.${extensionForImageMimeType(mimeType)}`;
}

export interface ImagePlacementInput {
  placement: QuestionImagePlacement;
  alternativeLetter: QuestionAlternativeLetter | null;
}

/** Coerência placement/alternativeLetter no SERVIÇO (primeira linha de
 *  defesa, erro 400 controlado) — o banco também impõe isto via trigger
 *  aditivo (migrations/0022_question_images_placement_r2.sql), nunca só
 *  aqui (seção 8 da ordem: "validar... no serviço E, se tecnicamente
 *  adequado, com trigger/check aditivo" — as duas camadas, não uma OU
 *  outra). */
export function validateImagePlacement(rawPlacement: unknown, rawAlternativeLetter: unknown): FieldValidationResult<ImagePlacementInput> {
  if (typeof rawPlacement !== "string" || !(QUESTION_IMAGE_PLACEMENTS as readonly string[]).includes(rawPlacement)) {
    return fail("Posicionamento da imagem inválido — use 'enunciado' ou 'alternativa'.");
  }
  const placement = rawPlacement as QuestionImagePlacement;
  if (placement === "alternativa") {
    if (typeof rawAlternativeLetter !== "string" || !(QUESTION_ALTERNATIVE_LETTERS as readonly string[]).includes(rawAlternativeLetter)) {
      return fail("Informe a letra da alternativa (A-E) para uma imagem de alternativa.");
    }
    return ok({ placement, alternativeLetter: rawAlternativeLetter as QuestionAlternativeLetter });
  }
  if (rawAlternativeLetter !== undefined && rawAlternativeLetter !== null) {
    return fail("Imagem de enunciado não pode informar letra de alternativa.");
  }
  return ok({ placement, alternativeLetter: null });
}

export function validateImageAltText(value: unknown): FieldValidationResult<string> {
  return validateNonEmptyText(value, "Texto alternativo da imagem", QUESTION_SHORT_FIELD_MAX_LENGTH);
}

export function validateImageCaption(value: unknown): FieldValidationResult<string | null> {
  return validateOptionalText(value, "Legenda da imagem", QUESTION_SHORT_FIELD_MAX_LENGTH);
}

/* ------------------------------- Tags -------------------------------------- */

export function validateTags(value: unknown): FieldValidationResult<string[]> {
  if (value === undefined || value === null) return ok([]);
  if (!Array.isArray(value)) return fail("Tags inválidas.");
  const seen = new Set<string>();
  const parsed: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string" || raw.trim().length === 0) return fail("Tag inválida.");
    if (raw.length > 60) return fail("Tag excede o tamanho máximo.");
    const normalized = raw.trim();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    parsed.push(normalized);
  }
  return ok(parsed);
}

/* --------------------------- Direitos/licença (3) --------------------------- */

/** Nenhuma questão pode chegar a `published` sem: origem, autoria, base de
 *  uso/licença, atribuição quando aplicável, confirmação editorial (aqui
 *  representada por revisor_id preenchido, já que só admin publica com
 *  aprovação prévia). */
export interface RightsCheckInput {
  origem: string;
  titularDireitos: string | null;
  baseLicenca: string | null;
  autorId: string | null;
  revisorId: string | null;
}

export function hasRequiredRightsForPublication(input: RightsCheckInput): boolean {
  return Boolean(
    input.origem &&
      input.titularDireitos &&
      input.titularDireitos.trim().length > 0 &&
      input.baseLicenca &&
      input.baseLicenca.trim().length > 0 &&
      input.autorId &&
      input.revisorId
  );
}

/* --------------------------- Listagem/paginação ----------------------------- */

export function validateListLimit(value: string | null): FieldValidationResult<number> {
  if (value === null || value === "") return ok(QUESTIONS_DEFAULT_LIMIT);
  if (!/^\d+$/.test(value)) return fail("Limite inválido.");
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > QUESTIONS_MAX_LIMIT) {
    return fail(`O limite precisa ser um inteiro entre 1 e ${QUESTIONS_MAX_LIMIT}.`);
  }
  return ok(parsed);
}

export function validateListPage(value: string | null): FieldValidationResult<number> {
  if (value === null || value === "") return ok(1);
  if (!/^\d+$/.test(value)) return fail("Página inválida.");
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fail("A página precisa ser um inteiro maior ou igual a 1.");
  return ok(parsed);
}

export function validateStatusFilter(value: string | null): FieldValidationResult<QuestionEditorialStatus | null> {
  if (value === null || value === "") return ok(null);
  if (!(QUESTION_EDITORIAL_STATUSES as readonly string[]).includes(value)) return fail("Status inválido.");
  return ok(value as QuestionEditorialStatus);
}

export function validateOriginFilter(value: string | null): FieldValidationResult<QuestionOrigin | null> {
  if (value === null || value === "") return ok(null);
  if (!(QUESTION_ORIGINS as readonly string[]).includes(value)) return fail("Origem inválida.");
  return ok(value as QuestionOrigin);
}

export function validateDifficultyFilter(value: string | null): FieldValidationResult<QuestionDifficulty | null> {
  if (value === null || value === "") return ok(null);
  if (!(QUESTION_DIFFICULTIES as readonly string[]).includes(value)) return fail("Dificuldade inválida.");
  return ok(value as QuestionDifficulty);
}

export function validateExpectedVersion(value: unknown): FieldValidationResult<number> {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return fail("Versão esperada inválida.");
  }
  return ok(value);
}

/* ---------------------- Fórmula CSV — REMOVIDO da IMPORTAÇÃO ------------------
   Sprint 7 v1.1, Correção B: a importação NUNCA rejeita uma linha só porque
   um campo pedagógico começa com "=", "+", "-" ou "@" — isso bloqueava
   conteúdo matemático legítimo ("-5", "+3", "= 2x + 4",
   "@ representa uma variável") numa plataforma de matemática. A validação
   de importação passou a ser 100% semântica por campo (código, ano,
   dificuldade, status, etc. mantêm sua própria validação estrita; texto
   livre como enunciado/alternativas nunca é rejeitado por causa do
   primeiro caractere). A neutralização de fórmula agora existe SÓ do lado
   de EXPORTAÇÃO/relatório CSV — ver worker/src/lib/csv.ts
   (hasDangerousLeadingCharacter/neutralizeForCsvExport/serializeCsvReport). */

/* ------------------------------ Mass assignment ----------------------------- */

/** Allow-list explícita de campos mutáveis por ação — nunca um spread do
 *  corpo inteiro da requisição (seção 7 da ordem). */
export const QUESTION_CREATE_ALLOWED_FIELDS = [
  "code",
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
  "alternativas",
  "dna",
  "padroes",
  "tags",
  "imagens",
] as const;

export const QUESTION_UPDATE_ALLOWED_FIELDS = QUESTION_CREATE_ALLOWED_FIELDS;

/** Sprint 7 v1.1, Correção A — campos escalares que ACEITAM `null` explícito
 *  (limpam o campo). Qualquer outro campo escalar do allow-list, se enviado
 *  como `null`, é 400 ("campo obrigatório") — nunca gravado, nunca
 *  interpretado como "manter o valor atual" (isso é reservado para o campo
 *  AUSENTE do corpo, nunca para um `null` explícito). */
export const NULLABLE_QUESTION_SCALAR_FIELDS = [
  "prova",
  "ano",
  "tempoEstimadoSegundos",
  "titularDireitos",
  "baseLicenca",
  "textoAtribuicao",
] as const;

/** Coleções do PATCH parcial — ausentes preservam o que já existe; presentes
 *  (mesmo `[]`) substituem a coleção inteira (seção 2 da ordem v1.1). */
export const QUESTION_UPDATE_COLLECTION_FIELDS = ["alternativas", "dna", "padroes", "tags", "imagens"] as const;

export function pickAllowedFields<T>(body: Record<string, unknown>, allowed: readonly string[]): Partial<T> {
  const result: Record<string, unknown> = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      result[key] = body[key];
    }
  }
  return result as Partial<T>;
}
