/* Cliente da API editorial do Banco de Questões — Sprint 7 v1.0. Mesmo
   padrão de src/api/patternsClient.ts/scheduleClient.ts (fetch tipado,
   credentials incluídas, erro traduzido para uma classe com code/status/
   fields). */

export interface ApiFieldError {
  code: string;
  message: string;
  fields?: Record<string, string>;
  /** Sprint 19 — erros do Pacote ZIP não cabem num `Record<string,string>`
   *  simples (podem ter code/file/row/field simultaneamente); a rota de
   *  package/preview devolve esta lista estruturada em vez de `fields`. */
  errors?: PackageError[];
  /** Sprint 24, seções 2/4 da ordem — só presente quando `code` é
   *  `pdf_needs_ocr_exam`/`pdf_needs_ocr_answer_key`: páginas (1-based) que
   *  precisam de OCR antes de tentar a prévia de novo. */
  pagesNeedingOcr?: number[];
  /** Hotfix pós-Sprint 24.1, seção 4 da ordem — presente quando o Worker
   *  capturou um erro genuinamente interno (nunca vazado como stack —
   *  ver `worker/src/lib/response.ts:Errors.internal`). Mostrado à
   *  editora para ela poder reportar e correlacionarmos com os logs do
   *  Worker (`wrangler tail`). */
  requestId?: string;
}

export class EditorialApiError extends Error {
  readonly fields: Record<string, string>;
  readonly status: number;
  readonly code: string;
  readonly packageErrors: PackageError[];
  readonly pagesNeedingOcr: number[];
  readonly requestId?: string;

  constructor(apiError: ApiFieldError, status: number) {
    super(apiError.message);
    this.fields = apiError.fields ?? {};
    this.status = status;
    this.code = apiError.code;
    this.packageErrors = apiError.errors ?? [];
    this.pagesNeedingOcr = apiError.pagesNeedingOcr ?? [];
    this.requestId = apiError.requestId;
  }
}

/** Hotfix pós-Sprint 24.1, seção 4 da ordem — "erro genérico é bug também":
 *  quando o corpo da resposta não é JSON válido (`response.json()` falhou),
 *  o Worker do próprio app NUNCA respondeu — nem com um erro de aplicação
 *  (JSON, `pdf_invalid`/etc.) nem com `Errors.internal()` (também JSON,
 *  sempre com `requestId`). Isso só acontece quando a PLATAFORMA Cloudflare
 *  intercepta a requisição ANTES do Worker rodar (ex.: tempo/CPU/memória
 *  excedidos, conexão encerrada) — devolvendo uma página HTML própria, não
 *  o JSON do app. Nunca mais "Erro inesperado." sem contexto: explica o
 *  cenário provável e dá um horário para a pessoa reportar (não existe
 *  `requestId` real aqui — o Worker nunca chegou a gerar um). */
function buildGatewayErrorMessage(status: number): ApiFieldError {
  const timestamp = new Date().toLocaleString("pt-BR");
  return {
    code: "gateway_error",
    message: `O servidor não conseguiu concluir esta operação (código ${status}) — provavelmente o arquivo é grande ou complexo demais para o tempo de processamento disponível. Tente novamente; se for um PDF muito grande, tente um arquivo menor ou divida a prova em partes. Se persistir, avise o suporte informando este horário: ${timestamp}.`,
  };
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  // Sprint 18 — upload de imagem manda FormData (multipart/form-data); o
  // navegador PRECISA definir o Content-Type sozinho (inclui o boundary
  // real) — forçar "application/json" aqui quebraria o parse no servidor.
  const isFormData = typeof FormData !== "undefined" && init.body instanceof FormData;
  const response = await fetch(path, {
    credentials: "include",
    headers: isFormData ? init.headers : { "Content-Type": "application/json", ...(init.headers ?? {}) },
    ...init,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const apiError: ApiFieldError = data?.error ?? buildGatewayErrorMessage(response.status);
    throw new EditorialApiError(apiError, response.status);
  }
  return data as T;
}

export type EditorialRole = "editor" | "admin" | null;

export function fetchEditorialRole(): Promise<{ ok: true; role: EditorialRole }> {
  return request("/api/editorial/me");
}

/* Sprint 17, seção B da ordem — leitura mínima de padrões para montar os
   chips do Banco de Questões por padrão principal. Endpoint próprio
   (/api/editorial/patterns), acessível a editor/admin — nunca depende de
   /api/admin/patterns. Catálogo dinâmico: nenhum nome de padrão é
   hardcoded aqui nem no componente que consome isto. */
export interface EditorialPatternSummary {
  id: string;
  name: string;
  editorialStatus: string;
}

export function fetchEditorialPatterns(): Promise<{ ok: true; patterns: EditorialPatternSummary[] }> {
  return request("/api/editorial/patterns");
}

export interface AlternativeDto {
  letter: string;
  text: string;
  isCorrect: boolean;
  distractorExplanation: string | null;
}

export interface QuestionDnaDto {
  pista: string;
  estrategia: string;
  pegadinha: string;
  conteudoApoio: string;
  resolucao: string;
  atalho: string | null;
  aprendizadoErro: string;
}

export interface QuestionSummary {
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

/* Sprint 18, seção 8 da ordem — imagem do enunciado ou de uma alternativa
   específica (A-E). `assetRef` é só um identificador técnico interno —
   nunca digitado/editado pela Andreia; a UI usa `id` (para excluir) e monta
   a URL de exibição a partir dele (/api/question-media/:id), nunca de
   `assetRef` diretamente. */
export interface QuestionImageDto {
  id: string;
  assetRef: string;
  altText: string;
  caption: string | null;
  position: number;
  placement: "enunciado" | "alternativa";
  alternativeLetter: string | null;
  /** Sprint 18.1, seção C da correção — 'r2' exibe via questionMediaUrl(id);
   *  'local' exibe via localAssetUrl(assetRef) (compatibilidade com imagens
   *  pré-Sprint-18, nunca servidas por /api/question-media). */
  storageKind: "local" | "r2";
}

export interface QuestionDetail extends QuestionSummary {
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
  alternativas: AlternativeDto[];
  imagens: QuestionImageDto[];
  padroes: Array<{ patternId: string; role: string }>;
  tags: string[];
  dna: QuestionDnaDto | null;
}

export interface QuestionListParams {
  busca?: string | null;
  status?: string | null;
  origem?: string | null;
  dificuldade?: string | null;
  /** Sprint 17, seção C/D da ordem — filtro por padrão principal; ausente/null = "Todas". */
  padraoPrincipalId?: string | null;
  pagina?: number;
  limite?: number;
}

export interface QuestionListResponse {
  ok: true;
  questions: QuestionSummary[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

function toQuery(params: QuestionListParams): string {
  const search = new URLSearchParams();
  if (params.busca) search.set("busca", params.busca);
  if (params.status) search.set("status", params.status);
  if (params.origem) search.set("origem", params.origem);
  if (params.dificuldade) search.set("dificuldade", params.dificuldade);
  if (params.padraoPrincipalId) search.set("padraoPrincipalId", params.padraoPrincipalId);
  if (params.pagina && params.pagina > 1) search.set("pagina", String(params.pagina));
  if (params.limite) search.set("limite", String(params.limite));
  return search.toString();
}

export function fetchQuestions(params: QuestionListParams = {}): Promise<QuestionListResponse> {
  const query = toQuery(params);
  return request(query ? `/api/editorial/questions?${query}` : "/api/editorial/questions");
}

export function fetchQuestionDetail(id: string): Promise<{ ok: true; question: QuestionDetail }> {
  return request(`/api/editorial/questions/${encodeURIComponent(id)}`);
}

export interface QuestionFormInput {
  code: string;
  enunciado: string;
  resolucaoComentada: string;
  conteudo: string;
  subconteudo: string;
  habilidade: string;
  competencia: string;
  dificuldade: string;
  origem: string;
  prova: string | null;
  ano: number | null;
  tempoEstimadoSegundos: number | null;
  tipoCalculo: string;
  necessitaCalculadora: boolean;
  titularDireitos: string | null;
  baseLicenca: string | null;
  textoAtribuicao: string | null;
  alternativas: AlternativeDto[];
  dna: QuestionDnaDto;
  padroes: Array<{ patternId: string; role: string }>;
  tags: string[];
  imagens: Array<{ assetRef: string; altText: string; caption: string | null; position: number }>;
}

/* Sprint 18, seção 3/16 da ordem — `code` deixou de ser obrigatório no
 *  cliente (o servidor gera um técnico quando ausente); os demais campos
 *  legados não expostos na UI simplificada (subconteudo/habilidade/
 *  competencia/tempoEstimadoSegundos/tipoCalculo/necessitaCalculadora/
 *  textoAtribuicao/tags/imagens) também podem ser omitidos — o servidor já
 *  aplica defaults sãos para uma questão nova (nunca inventa conteúdo
 *  pedagógico). `Partial<...>` reflete isso no tipo. */
export function createQuestion(input: Partial<QuestionFormInput>): Promise<{ ok: true; id: string }> {
  return request("/api/editorial/questions", { method: "POST", body: JSON.stringify(input) });
}

/** Sprint 7 v1.2, Correção A — `mutationId` é obrigatório: o servidor usa
 *  esse UUID (gerado pelo cliente) como única prova de retry idempotente.
 *  Nunca inferido por conteúdo — quem chama decide se reaproveita o mesmo
 *  ID (retry da mesma requisição) ou gera um novo (edição nova). */
export function updateQuestion(
  id: string,
  expectedVersion: number,
  mutationId: string,
  input: Partial<QuestionFormInput>
): Promise<{ ok: true; id: string; changed: boolean }> {
  return request(`/api/editorial/questions/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ ...input, expectedVersion, mutationId }),
  });
}

/* --------------------------------- Imagens ---------------------------------
   Sprint 18, seções 11/12/14 da ordem — endpoints dedicados, FORA do PATCH
   geral da questão (nunca mais parte do payload de `updateQuestion`). A
   Andreia nunca digita asset_ref/URL/object key — só escolhe/solta/cola um
   arquivo; o servidor decide tudo o mais. */

export interface UploadQuestionImageParams {
  file: File;
  mutationId: string;
  placement: "enunciado" | "alternativa";
  alternativeLetter?: string | null;
  altText: string;
  caption?: string | null;
}

export function uploadQuestionImage(questionId: string, params: UploadQuestionImageParams): Promise<{ ok: true; changed: boolean; image: QuestionImageDto }> {
  const form = new FormData();
  form.set("arquivo", params.file);
  form.set("mutationId", params.mutationId);
  form.set("placement", params.placement);
  if (params.alternativeLetter) form.set("alternativeLetter", params.alternativeLetter);
  form.set("altText", params.altText);
  if (params.caption) form.set("caption", params.caption);
  return request(`/api/editorial/questions/${encodeURIComponent(questionId)}/images`, { method: "POST", body: form });
}

export function deleteQuestionImage(questionId: string, imageId: string): Promise<{ ok: true; changed: boolean }> {
  return request(`/api/editorial/questions/${encodeURIComponent(questionId)}/images/${encodeURIComponent(imageId)}`, { method: "DELETE" });
}

/** Sprint 18.1, seção B da correção — edição dedicada de alt text/legenda,
 *  SEM tocar bytes/R2 (Andreia não precisa mais remover e reenviar a imagem
 *  só para corrigir a descrição). */
export function updateQuestionImageMetadata(
  questionId: string,
  imageId: string,
  params: { mutationId: string; altText: string; caption?: string | null }
): Promise<{ ok: true; changed: boolean; image: QuestionImageDto }> {
  return request(`/api/editorial/questions/${encodeURIComponent(questionId)}/images/${encodeURIComponent(imageId)}`, {
    method: "PATCH",
    body: JSON.stringify({ mutationId: params.mutationId, altText: params.altText, caption: params.caption ?? null }),
  });
}

/** URL da mídia para <img src>, sempre pelo ID técnico (nunca pela chave de
 *  storage) — worker/src/routes/questionMedia.ts aplica a autorização
 *  correta ao servir. Só usar quando `storageKind === 'r2'`. */
export function questionMediaUrl(imageId: string): string {
  return `/api/question-media/${encodeURIComponent(imageId)}`;
}

/** Sprint 18.2, seção 3 da correção — WHITELIST POSITIVA, não mais uma lista
 *  de padrões proibidos. A versão anterior (Sprint 18.1) só bloqueava
 *  "://" e ".." — deixava passar qualquer outra coisa, inclusive um
 *  protocol-relative ("//evil.com/x.png", que o navegador resolve para o
 *  esquema da PÁGINA ATUAL, então vira uma URL externa de verdade) ou um
 *  esquema sem "//" (`javascript:alert(1)`). `assetRef` já é validado no
 *  servidor contra o namespace histórico `assets/questoes/`
 *  (ASSET_REF_RE, worker/src/lib/questionsValidation.ts), mas o cliente
 *  NUNCA confia só nisso — reaplica exatamente o mesmo formato aqui como
 *  defesa em profundidade: só monta a URL se `assetRef` casar
 *  integralmente com `assets/questoes/<subcaminho>.<extensão-permitida>`;
 *  qualquer outra coisa retorna string vazia (falha seguramente inerte,
 *  nunca uma URL externa). */
const LOCAL_ASSET_REF_RE = /^assets\/questoes\/[A-Za-z0-9_/-]+\.(png|jpg|jpeg|svg|webp)$/;

export function localAssetUrl(assetRef: string): string {
  if (!LOCAL_ASSET_REF_RE.test(assetRef)) return "";
  return `/${assetRef}`;
}

export type WorkflowAction = "submit-review" | "request-changes" | "approve" | "publish" | "archive";

export function runWorkflowAction(
  id: string,
  action: WorkflowAction,
  expectedVersion: number,
  reason?: string
): Promise<{ ok: true; changed: boolean }> {
  return request(`/api/editorial/questions/${encodeURIComponent(id)}/${action}`, {
    method: "POST",
    body: JSON.stringify({ expectedVersion, ...(reason ? { reason } : {}) }),
  });
}

/* --------------------------------- Importação -------------------------------- */

export interface ImportRowError {
  row: number;
  field: string;
  message: string;
  value?: string;
}

export interface PreviewImportResponse {
  ok: true;
  batchId: string;
  rowCount: number;
  validRowCount: number;
  errorCount: number;
  errors: ImportRowError[];
  /** CSV do relatório de erros, já com neutralização de fórmula aplicada
   *  (Correção B) — `null` quando não há erro. Mostrado só como DADO
   *  (texto puro) na UI; nunca inserido como HTML. */
  errorsReportCsv: string | null;
  expiresAt: string;
  canApply: boolean;
}

export async function previewImportFile(file: File): Promise<PreviewImportResponse> {
  const buffer = await file.arrayBuffer();
  return request("/api/editorial/question-imports/preview", {
    method: "POST",
    headers: { "Content-Type": "text/csv" },
    body: buffer,
  });
}

export function applyImportBatch(batchId: string): Promise<{ ok: true; appliedCount: number; alreadyApplied: boolean; questionIds: string[] }> {
  return request("/api/editorial/question-imports/apply", { method: "POST", body: JSON.stringify({ batchId }) });
}

export function undoImportBatch(batchId: string): Promise<{ ok: true; undoneCount: number; alreadyUndone: boolean }> {
  return request(`/api/editorial/question-imports/${encodeURIComponent(batchId)}/undo`, { method: "POST" });
}

export function fetchImportBatch(batchId: string): Promise<{ ok: true; batch: Record<string, unknown> }> {
  return request(`/api/editorial/question-imports/${encodeURIComponent(batchId)}`);
}

export function templateDownloadUrl(): string {
  return "/api/editorial/question-imports/template";
}

/* ----------------------------- Pacote ZIP (Sprint 19) -----------------------
   Seções 2/17 da ordem — endpoints SEPARADOS dos de CSV puro acima. Andreia
   nunca vê asset_ref/object key/storage_kind/manifest técnico — só
   código/enunciado/padrão/imagens por questão. */

export function templateV2DownloadUrl(): string {
  return "/api/editorial/question-imports/template-v2";
}

export interface PackageError {
  code?: string;
  file?: string;
  row?: number;
  field?: string;
  message: string;
}

export interface PackagePreviewImage {
  imageId: string;
  path: string;
  placement: "enunciado" | "alternativa";
  alternativeLetter: string | null;
  altText: string;
}

export interface PackagePreviewQuestion {
  code: string;
  enunciadoPreview: string;
  patternName: string | null;
  images: PackagePreviewImage[];
  status: "ready" | "error";
}

export interface PreviewPackageResponse {
  ok: true;
  batchId: string;
  rowCount: number;
  validRowCount: number;
  imageCount: number;
  errorCount: number;
  questions: PackagePreviewQuestion[];
  expiresAt: string;
  canApply: boolean;
}

/** Preview do pacote — corpo é o ZIP BRUTO (mesma convenção do preview de
 *  CSV acima), nunca JSON. */
export async function previewPackageFile(file: File): Promise<PreviewPackageResponse> {
  const buffer = await file.arrayBuffer();
  return request("/api/editorial/question-imports/package/preview", {
    method: "POST",
    headers: { "Content-Type": "application/zip" },
    body: buffer,
  });
}

/** Apply do pacote — seção 10 da ordem: Andreia NUNCA seleciona o arquivo
 *  de novo; o MESMO `File` já escolhido no preview é reenviado
 *  automaticamente pelo componente, junto do `batchId`. */
export function applyPackageBatch(
  batchId: string,
  file: File
): Promise<{ ok: true; appliedCount: number; imageCount: number; alreadyApplied: boolean; questionIds: string[] }> {
  const form = new FormData();
  form.set("batchId", batchId);
  form.set("arquivo", file);
  return request("/api/editorial/question-imports/package/apply", { method: "POST", body: form });
}

/* ----------------------------- PDF oficial ENEM (Sprint 22) -----------------------
   Seção 18 da ordem — namespace SEPARADO, sempre multipart/form-data (dois
   PDFs + campos de identidade). Andreia nunca vê JSON bruto — a prévia
   estruturada abaixo é o que a UI renderiza. */

export interface PdfExamIdentity {
  exam: "ENEM";
  year: number;
  application: string;
  booklet: string;
  languageVariant: string | null;
  sourceLabel: string | null;
}

export interface PdfExamIdentityInput {
  year: number;
  application: string;
  booklet: string;
  languageVariant?: string;
  sourceUrl?: string;
}

export interface PdfPreviewAlternative {
  letter: "A" | "B" | "C" | "D" | "E";
  text: string;
}

/** Sprint 24, seções 4/9/19 da ordem — UMA linha reconhecida por OCR no
 *  navegador (`src/pages/editorial/pdfOcr.ts:ClientOcrLine`), já em
 *  coordenadas de página PDF nativas — mesmo formato aceito pelo worker
 *  em `worker/src/lib/pdfEnemOcrModel.ts:OcrLineInput`. */
export interface PdfOcrLine {
  x: number;
  y: number;
  text: string;
  confidencePercent: number;
}

export interface PdfOcrPageInput {
  pageNumber: number;
  lines: PdfOcrLine[];
}

/** Sprint 23 — metadado leve de UM elemento visual associado à questão
 *  (imagem raster extraída OU diagrama vetorial detectado, nunca ambos
 *  confundidos — `kind` distingue). `thumbnailDataUri` só existe na
 *  RESPOSTA do preview (nunca persistido) — usado para a miniatura na UI.
 *  Andreia NUNCA vê `sourceObjectId`/coordenadas técnicas (seção 8 da
 *  ordem) — este tipo já omite tudo isso por não os incluir. */
export interface PdfVisualElement {
  hash: string;
  kind: "raster" | "vector_diagram";
  extractionStatus: "extracted" | "detected_not_extractable" | "ambiguous" | "ignored_decorative";
  placementCandidate: "statement" | "option_A" | "option_B" | "option_C" | "option_D" | "option_E" | "unknown";
  thumbnailDataUri?: string;
}

export interface PdfPreviewQuestion {
  tempId: string;
  originalNumber: number;
  pageStart: number;
  pageEnd: number;
  statement: string;
  alternatives: PdfPreviewAlternative[];
  correctAlternative: "A" | "B" | "C" | "D" | "E" | null;
  warnings: string[];
  status: "ready" | "needs_review";
  duplicateStatus: "none" | "exact";
  visualReviewRequired: boolean;
  /** Sprint 23 — `true` quando há imagem(ns) raster extraída(s) com
   *  sucesso aguardando confirmação de posicionamento + texto alternativo
   *  antes do apply (ver `PdfVisualConfirmation`). Nunca junto com
   *  `visualReviewRequired=true` — são mutuamente exclusivos. */
  hasPendingVisualConfirmation: boolean;
  visualElements: PdfVisualElement[];
  patternPrincipalId: string | null;
  canApply: boolean;
  code: string;
  fingerprint: string;
  /** Sprint 24, seção 15 da ordem — `true` quando qualquer parte desta
   *  questão veio de OCR (cabeçalho, enunciado ou alternativa) — mostrada
   *  como "Texto reconhecido por OCR" na UI, sem detalhes técnicos. */
  hasOcrText: boolean;
}

/** Seção 2/3 da ordem — identidade DETECTADA no texto dos dois PDFs
 *  (nunca inventada; campos ausentes ficam `undefined`). */
export interface PdfDetectedDocumentIdentity {
  year?: number;
  day?: number;
  bookletNumber?: number;
  color?: string;
  application?: string;
}

export interface PdfDocumentIdentityCheck {
  ok: boolean;
  confirmedAutomatically: boolean;
  messages: string[];
  examDetected: PdfDetectedDocumentIdentity;
  answerKeyDetected: PdfDetectedDocumentIdentity;
}

export interface PreviewPdfResponse {
  ok: true;
  batchId: string;
  examIdentity: PdfExamIdentity;
  documentIdentityCheck: PdfDocumentIdentityCheck;
  pageCount: number;
  detectedQuestionCount: number;
  matchedAnswerCount: number;
  questions: PdfPreviewQuestion[];
  globalWarnings: string[];
  canApply: boolean;
  expiresAt: string;
}

function buildPdfIdentityFormEntries(identity: PdfExamIdentityInput): Array<[string, string]> {
  const entries: Array<[string, string]> = [
    ["year", String(identity.year)],
    ["application", identity.application],
    ["booklet", identity.booklet],
  ];
  if (identity.languageVariant) entries.push(["languageVariant", identity.languageVariant]);
  if (identity.sourceUrl) entries.push(["sourceUrl", identity.sourceUrl]);
  return entries;
}

export async function previewPdfEnem(
  examPdf: File,
  answerKeyPdf: File,
  identity: PdfExamIdentityInput,
  confirmation: boolean,
  /** Sprint 24, seções 2/4/9 da ordem — OCR já reconhecido no navegador
   *  para as páginas que uma chamada anterior sinalizou como
   *  `needs_ocr_exam`/`needs_ocr_answer_key` (via `EditorialApiError.
   *  pagesNeedingOcr`). Ausente/vazio preserva 100% o comportamento
   *  anterior — nenhum PDF com camada de texto boa jamais aciona OCR. */
  examOcrPages: PdfOcrPageInput[] = [],
  answerKeyOcrPages: PdfOcrPageInput[] = []
): Promise<PreviewPdfResponse> {
  const form = new FormData();
  form.set("examPdf", examPdf);
  form.set("answerKeyPdf", answerKeyPdf);
  for (const [key, value] of buildPdfIdentityFormEntries(identity)) form.set(key, value);
  form.set("confirmation", confirmation ? "true" : "false");
  if (examOcrPages.length > 0) form.set("examOcrPages", JSON.stringify(examOcrPages));
  if (answerKeyOcrPages.length > 0) form.set("answerKeyOcrPages", JSON.stringify(answerKeyOcrPages));
  return request("/api/editorial/question-imports/pdf/preview", { method: "POST", body: form });
}

/** Sprint 23, seção 8/10 da ordem — confirmação editorial de UMA imagem
 *  raster extraída. `elementHash` identifica o elemento (ver
 *  `PdfVisualElement.hash`); `placement` NUNCA "unknown" aqui (o editor
 *  escolhe uma posição real, ou a questão simplesmente não é
 *  selecionada); `altText` sempre obrigatório e revalidado no backend. */
export interface PdfVisualConfirmation {
  elementHash: string;
  placement: "statement" | "option_A" | "option_B" | "option_C" | "option_D" | "option_E";
  altText: string;
}

export interface PdfApplySelectionEntry {
  originalNumber: number;
  patternPrincipalId: string;
  /** Seção 5/7 da ordem — correção editorial OPCIONAL de enunciado/
   *  alternativas (nunca de gabarito — não há campo de resposta correta
   *  aqui, propositalmente). */
  reviewedStatement?: string;
  reviewedAlternatives?: PdfPreviewAlternative[];
  visualConfirmations?: PdfVisualConfirmation[];
}

/** Apply do PDF — mesma convenção do Pacote ZIP: os MESMOS dois `File`s já
 *  escolhidos no preview são reenviados automaticamente pelo componente,
 *  nunca pedidos de novo a Andreia. */
export function applyPdfEnem(
  batchId: string,
  examPdf: File,
  answerKeyPdf: File,
  identity: PdfExamIdentityInput,
  selection: PdfApplySelectionEntry[],
  /** Sprint 24 — o MESMO OCR usado no preview, reenviado para o apply
   *  poder re-derivar exatamente a mesma fusão nativo+OCR (mesmo princípio
   *  de "nunca confia no preview persistido" já usado para o texto). */
  examOcrPages: PdfOcrPageInput[] = [],
  answerKeyOcrPages: PdfOcrPageInput[] = []
): Promise<{ ok: true; appliedCount: number; alreadyApplied: boolean; questionIds: string[] }> {
  const form = new FormData();
  form.set("batchId", batchId);
  form.set("examPdf", examPdf);
  form.set("answerKeyPdf", answerKeyPdf);
  for (const [key, value] of buildPdfIdentityFormEntries(identity)) form.set(key, value);
  form.set("selection", JSON.stringify(selection));
  if (examOcrPages.length > 0) form.set("examOcrPages", JSON.stringify(examOcrPages));
  if (answerKeyOcrPages.length > 0) form.set("answerKeyOcrPages", JSON.stringify(answerKeyOcrPages));
  return request("/api/editorial/question-imports/pdf/apply", { method: "POST", body: form });
}

/* -----------------------------------------------------------------------
   Sprint 24.2 — importador ENEM CLIENT-SIDE (Cloudflare Workers Free). O
   PDF nunca é enviado ao Worker neste fluxo — todo o processamento
   (extração/segmentação/casamento) já rodou no navegador
   (`src/workers/pdfEnemImportPipeline.ts` via `src/pages/editorial/
   pdfEnemImportClient.ts`). Aqui só existe o transporte HTTP do resultado
   JÁ ESTRUTURADO — mesmo prefixo de campo de arquivo (`visual:<hash>`)
   esperado por `collectVisualFilesByHash` em
   worker/src/routes/editorialImports.ts.
   ----------------------------------------------------------------------- */

const VISUAL_FILE_FIELD_PREFIX = "visual:";

/** Preenche os campos multipart de imagem confirmada — reaproveitado tanto
 *  pelo client-preview quanto pelo client-apply (mesma convenção de nome
 *  de campo dos dois lados). */
function appendVisualImageFiles(form: FormData, imagePngByHash: Map<string, Uint8Array>, hashes: Iterable<string>): void {
  for (const hash of hashes) {
    const bytes = imagePngByHash.get(hash);
    if (!bytes) continue;
    form.set(`${VISUAL_FILE_FIELD_PREFIX}${hash}`, new Blob([new Uint8Array(bytes)], { type: "image/png" }), `${hash}.png`);
  }
}

export interface PdfClientPreviewPayload {
  identity: PdfExamIdentityInput;
  confirmation: boolean;
  examSha256: string;
  answerKeySha256: string;
  pageCount: number;
  parserVersion: string;
  examQuestions: unknown[];
  answerKey: Array<[number, string]>;
  visualElements: unknown[];
  examDetectedIdentity: unknown;
  answerKeyDetectedIdentity: unknown;
}

/** Todos os hashes de imagem REALMENTE extraída (`extractionStatus ===
 *  "extracted"`) presentes em `visualElements` — usado para saber quais
 *  arquivos PNG precisam ser anexados ao multipart (nunca envia bytes de
 *  elementos vetoriais/ambíguos, que nunca têm PNG). */
function extractedImageHashes(visualElements: Array<{ hash: string; kind: string; extractionStatus: string }>): string[] {
  return visualElements.filter((el) => el.kind === "raster" && el.extractionStatus === "extracted").map((el) => el.hash);
}

export async function previewPdfEnemClient(payload: PdfClientPreviewPayload, imagePngByHash: Map<string, Uint8Array>): Promise<PreviewPdfResponse> {
  const jsonPayload = {
    year: payload.identity.year,
    application: payload.identity.application,
    booklet: payload.identity.booklet,
    languageVariant: payload.identity.languageVariant,
    sourceUrl: payload.identity.sourceUrl,
    confirmation: payload.confirmation,
    examSha256: payload.examSha256,
    answerKeySha256: payload.answerKeySha256,
    pageCount: payload.pageCount,
    parserVersion: payload.parserVersion,
    examQuestions: payload.examQuestions,
    answerKey: payload.answerKey,
    visualElements: payload.visualElements,
    examDetectedIdentity: payload.examDetectedIdentity,
    answerKeyDetectedIdentity: payload.answerKeyDetectedIdentity,
  };
  const form = new FormData();
  form.set("payload", JSON.stringify(jsonPayload));
  appendVisualImageFiles(form, imagePngByHash, extractedImageHashes(payload.visualElements as never));
  return request("/api/editorial/question-imports/pdf/client-preview", { method: "POST", body: form });
}

export function applyPdfEnemClient(
  batchId: string,
  selection: PdfApplySelectionEntry[],
  imagePngByHash: Map<string, Uint8Array>
): Promise<{ ok: true; appliedCount: number; alreadyApplied: boolean; questionIds: string[] }> {
  const form = new FormData();
  form.set("batchId", batchId);
  form.set("selection", JSON.stringify(selection));
  // Só os hashes REALMENTE confirmados nesta seleção — nunca reenvia
  // imagens que a Andreia não confirmou (mesma disciplina de "nunca sobe
  // o que não foi revisado" do fluxo clássico).
  const confirmedHashes = selection.flatMap((entry) => entry.visualConfirmations?.map((c) => c.elementHash) ?? []);
  appendVisualImageFiles(form, imagePngByHash, confirmedHashes);
  return request("/api/editorial/question-imports/pdf/client-apply", { method: "POST", body: form });
}
