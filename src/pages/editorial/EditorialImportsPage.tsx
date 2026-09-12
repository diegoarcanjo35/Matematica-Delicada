import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { ErrorState } from "../../components/ErrorState";
import {
  applyImportBatch,
  applyPackageBatch,
  applyPdfEnem,
  EditorialApiError,
  fetchEditorialPatterns,
  previewImportFile,
  previewPackageFile,
  previewPdfEnem,
  templateV2DownloadUrl,
  undoImportBatch,
  type EditorialPatternSummary,
  type ImportRowError,
  type PackageError,
  type PdfApplySelectionEntry,
  type PdfExamIdentityInput,
  type PdfPreviewQuestion,
  type PdfVisualConfirmation,
  type PreviewImportResponse,
  type PreviewPackageResponse,
  type PreviewPdfResponse,
} from "../../api/editorialClient";
import { useEditorialRole } from "../../auth/editorialRoleContext";
import { buildPackageThumbnails } from "./packageZip";
import "./editorial.css";

/* Importação de questões — /editorial/importacoes, Sprint 19 da ordem,
   seção 2: "Importar questões", duas opções claras — [ CSV ] para texto
   puro, [ Pacote ZIP com imagens ] quando há imagens. Andreia nunca vê
   asset_ref/object key/storage_kind/manifest técnico — o manifest é
   produzido pelo processo técnico que prepara o pacote, nunca editado
   manualmente por ela.

   Sprint 7 v1.0 — o modo CSV (preview/erros por linha/aplicar/desfazer)
   continua o mesmo fluxo já em produção, só reorganizado sob o seletor. */

type ImportMode = "csv" | "zip" | "pdf_enem";

export function EditorialImportsPage() {
  const role = useEditorialRole();
  const [mode, setMode] = useState<ImportMode>("zip");

  return (
    <div className="editorial">
      <h1>Importar questões</h1>

      <Card className="editorial__nav-card">
        <div className="editorial__mode-toggle" role="radiogroup" aria-label="Tipo de importação">
          <label>
            <input type="radio" name="import-mode" value="csv" checked={mode === "csv"} onChange={() => setMode("csv")} />
            CSV
          </label>
          <label>
            <input type="radio" name="import-mode" value="zip" checked={mode === "zip"} onChange={() => setMode("zip")} />
            Pacote ZIP com imagens
          </label>
          <label>
            <input type="radio" name="import-mode" value="pdf_enem" checked={mode === "pdf_enem"} onChange={() => setMode("pdf_enem")} />
            PDF oficial ENEM
          </label>
        </div>
        <p className="editorial__mode-description">
          {mode === "csv"
            ? "Para questões sem imagens ou importações estruturadas."
            : mode === "zip"
              ? "Para importar questões e imagens juntas. Você não precisa renomear as imagens."
              : "Para extrair questões diretamente do PDF oficial da prova + PDF do gabarito do ENEM/INEP."}
        </p>
      </Card>

      {mode === "csv" ? <CsvImportPanel /> : mode === "zip" ? <PackageImportPanel isAdmin={role === "admin"} /> : <PdfImportPanel isAdmin={role === "admin"} />}
    </div>
  );
}

/* --------------------------------- Modo CSV --------------------------------- */

function CsvImportPanel() {
  const role = useEditorialRole();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [preview, setPreview] = useState<PreviewImportResponse | null>(null);
  const [applyResult, setApplyResult] = useState<{ appliedCount: number; alreadyApplied: boolean } | null>(null);
  const [undoResult, setUndoResult] = useState<{ undoneCount: number; alreadyUndone: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setError(null);
    setPreview(null);
    setApplyResult(null);
    setUndoResult(null);
    setBusy(true);
    try {
      const result = await previewImportFile(file);
      setPreview(result);
    } catch (err) {
      setError(err instanceof EditorialApiError ? err.message : "Não foi possível pré-visualizar o arquivo.");
    } finally {
      setBusy(false);
    }
  }

  async function handleApply() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const result = await applyImportBatch(preview.batchId);
      setApplyResult(result);
    } catch (err) {
      setError(err instanceof EditorialApiError ? err.message : "Não foi possível aplicar o lote.");
    } finally {
      setBusy(false);
    }
  }

  async function handleUndo() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const result = await undoImportBatch(preview.batchId);
      setUndoResult(result);
    } catch (err) {
      setError(err instanceof EditorialApiError ? err.message : "Não foi possível desfazer o lote.");
    } finally {
      setBusy(false);
    }
  }

  /** Baixa o relatório de erros já neutralizado (Correção B) — nunca insere
   *  o conteúdo em HTML/DOM; só cria um Blob de texto e aciona o download
   *  nativo do navegador. */
  function handleDownloadErrorReport() {
    if (!preview?.errorsReportCsv) return;
    const blob = new Blob([preview.errorsReportCsv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `relatorio-erros-importacao-${preview.batchId}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function groupErrorsByRow(errors: ImportRowError[]): Map<number, ImportRowError[]> {
    const map = new Map<number, ImportRowError[]>();
    for (const e of errors) {
      const list = map.get(e.row) ?? [];
      list.push(e);
      map.set(e.row, list);
    }
    return map;
  }

  return (
    <>
      <Card className="editorial__nav-card">
        <p>1. Baixe o template com os cabeçalhos esperados (o V2 é o recomendado; o V1 histórico continua aceito).</p>
        <div className="editorial__actions">
          <a href={templateV2DownloadUrl()} download="questoes-importacao-v2.csv">
            <Button type="button" variant="secondary">
              Baixar template CSV
            </Button>
          </a>
        </div>
      </Card>

      <Card className="editorial__nav-card">
        <p>2. Selecione um arquivo CSV local preenchido a partir do template.</p>
        <label htmlFor="import-file" className="editorial__field-label">
          Arquivo CSV
        </label>
        <input id="import-file" ref={fileInputRef} type="file" accept=".csv,text/csv" onChange={(e) => void handleFileChange(e)} disabled={busy} />
      </Card>

      {error && <ErrorState description={error} />}

      {preview && (
        <Card className="editorial__nav-card" data-testid="import-preview">
          <h2>Prévia</h2>
          <p>
            {preview.rowCount} linha(s) no arquivo — {preview.validRowCount} válida(s), {preview.errorCount} com erro.
          </p>
          {preview.errorCount === 0 ? (
            <p role="status">Prévia válida. Pronta para aplicar.</p>
          ) : (
            <>
              <p role="alert">Corrija os erros abaixo e envie um novo arquivo — um lote com erros não pode ser aplicado.</p>
              <div className="editorial__table-wrap">
                <table className="editorial__table" data-testid="import-error-table">
                  <thead>
                    <tr>
                      <th scope="col">Linha</th>
                      <th scope="col">Campo</th>
                      <th scope="col">Valor</th>
                      <th scope="col">Erro</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...groupErrorsByRow(preview.errors)].flatMap(([row, errs]) =>
                      errs.map((e, i) => (
                        <tr key={`${row}-${e.field}-${i}`}>
                          <td>{row}</td>
                          <td>{e.field}</td>
                          <td>{e.value ?? ""}</td>
                          <td>{e.message}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
              {preview.errorsReportCsv && (
                <Button type="button" variant="secondary" onClick={handleDownloadErrorReport}>
                  Baixar relatório de erros (CSV)
                </Button>
              )}
            </>
          )}

          {preview.canApply && !applyResult && (
            <Button type="button" onClick={() => void handleApply()} isLoading={busy}>
              Aplicar lote
            </Button>
          )}

          {applyResult && (
            <div data-testid="import-applied-result">
              <p role="status">
                {applyResult.alreadyApplied ? "Lote já havia sido aplicado anteriormente." : `${applyResult.appliedCount} questão(ões) criada(s) como rascunho.`}
              </p>
              {role === "admin" && !undoResult && (
                <Button type="button" variant="secondary" onClick={() => void handleUndo()} isLoading={busy}>
                  Desfazer lote
                </Button>
              )}
              {undoResult && (
                <p role="status">{undoResult.alreadyUndone ? "Lote já havia sido desfeito." : `${undoResult.undoneCount} questão(ões) removida(s).`}</p>
              )}
            </div>
          )}
        </Card>
      )}
    </>
  );
}

/* Sprint 19, seção 10 da ordem — "se a página for recarregada e o File for
   perdido: informar que precisa selecionar o pacote novamente". Um `File`
   nunca sobrevive a um reload (não é serializável), mas o RESUMO do
   preview persiste em sessionStorage só para tornar esse aviso possível —
   nunca o arquivo em si, nunca bytes de imagem (seção 9 da ordem: nada de
   base64 de imagem em estado persistente). */
const PACKAGE_PREVIEW_STORAGE_KEY = "editorial-package-preview-v1";

function loadPersistedPreview(): PreviewPackageResponse | null {
  try {
    const raw = sessionStorage.getItem(PACKAGE_PREVIEW_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as PreviewPackageResponse) : null;
  } catch {
    return null;
  }
}

function persistPreview(preview: PreviewPackageResponse | null): void {
  try {
    if (preview) sessionStorage.setItem(PACKAGE_PREVIEW_STORAGE_KEY, JSON.stringify(preview));
    else sessionStorage.removeItem(PACKAGE_PREVIEW_STORAGE_KEY);
  } catch {
    // sessionStorage indisponível (modo privado restrito, etc.) — o aviso
    // de "selecione novamente" simplesmente não aparece após reload; nunca
    // quebra o fluxo normal dentro da mesma sessão de página.
  }
}

/* --------------------------------- Modo ZIP --------------------------------- */

function PackageImportPanel({ isAdmin }: { isAdmin: boolean }) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Sprint 19, seção 10 da ordem — o MESMO `File` selecionado no preview é
  // reenviado automaticamente no apply; nunca pedimos para Andreia
  // selecionar de novo. `File` não sobrevive a um reload de página — nesse
  // caso `selectedFile` volta a `null` e orientamos gerar nova prévia.
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PreviewPackageResponse | null>(() => loadPersistedPreview());
  const [errors, setErrors] = useState<PackageError[]>([]);
  const [thumbnails, setThumbnails] = useState<Map<string, string>>(new Map());
  const [applyResult, setApplyResult] = useState<{ appliedCount: number; imageCount: number; alreadyApplied: boolean } | null>(null);
  const [undoResult, setUndoResult] = useState<{ undoneCount: number; alreadyUndone: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const revokeRef = useRef<(() => void) | null>(null);

  // Seção 11 da ordem — revoga TODOS os Object URLs ao trocar de pacote ou
  // desmontar o componente, nunca deixa vazar.
  useEffect(() => {
    return () => revokeRef.current?.();
  }, []);

  function resetForNewFile() {
    revokeRef.current?.();
    revokeRef.current = null;
    setThumbnails(new Map());
    setPreview(null);
    persistPreview(null);
    setErrors([]);
    setApplyResult(null);
    setUndoResult(null);
    setError(null);
  }

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    resetForNewFile();
    setSelectedFile(file);
    setBusy(true);
    try {
      const result = await previewPackageFile(file);
      setPreview(result);
      persistPreview(result);
      const paths = result.questions.flatMap((q) => q.images.map((img) => img.path));
      const built = await buildPackageThumbnails(file, paths);
      revokeRef.current = built.revokeAll;
      setThumbnails(built.urls);
    } catch (err) {
      if (err instanceof EditorialApiError) {
        setError(err.message);
        setErrors(err.packageErrors);
      } else {
        setError("Não foi possível pré-visualizar o pacote.");
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleApply() {
    if (!preview || !selectedFile) return;
    setBusy(true);
    setError(null);
    try {
      const result = await applyPackageBatch(preview.batchId, selectedFile);
      setApplyResult(result);
    } catch (err) {
      setError(err instanceof EditorialApiError ? err.message : "Não foi possível aplicar o pacote.");
    } finally {
      setBusy(false);
    }
  }

  async function handleUndo() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const result = await undoImportBatch(preview.batchId);
      setUndoResult(result);
    } catch (err) {
      setError(err instanceof EditorialApiError ? err.message : "Não foi possível desfazer o pacote.");
    } finally {
      setBusy(false);
    }
  }

  const reloadedWithoutFile = preview !== null && selectedFile === null;

  return (
    <>
      <Card className="editorial__nav-card">
        <p>1. Selecione o pacote ZIP (questoes.csv + manifest.json + imagens/).</p>
        <label htmlFor="import-package-file" className="editorial__field-label">
          Pacote ZIP
        </label>
        <input id="import-package-file" ref={fileInputRef} type="file" accept=".zip,application/zip" onChange={(e) => void handleFileChange(e)} disabled={busy} />
      </Card>

      {error && <ErrorState description={error} />}

      {errors.length > 0 && (
        <Card className="editorial__nav-card" data-testid="package-error-list">
          <h2>Erros do pacote</h2>
          <ul>
            {errors.map((e, i) => (
              <li key={i}>
                {e.code ? `[${e.code}] ` : ""}
                {e.file ? `${e.file}: ` : ""}
                {e.message}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {reloadedWithoutFile && (
        <ErrorState description="A página foi recarregada e o arquivo selecionado se perdeu. Selecione o pacote novamente para gerar uma nova prévia." />
      )}

      {preview && !reloadedWithoutFile && (
        <Card className="editorial__nav-card" data-testid="package-preview">
          <h2>Prévia do pacote</h2>
          <p>
            {preview.validRowCount} questão(ões), {preview.imageCount} imagem(ns), {preview.errorCount} erro(s).
          </p>

          <ul className="editorial__package-questions" data-testid="package-question-list">
            {preview.questions.map((q) => (
              <li key={q.code} className="editorial__package-question">
                <p className="editorial__package-question-header">
                  <strong>{q.code}</strong> {q.status === "ready" ? <span aria-label="pronta">✓ pronta</span> : <span aria-label="erro">⚠ erro</span>}
                </p>
                {q.patternName && <p>Padrão: {q.patternName}</p>}
                <p>{q.enunciadoPreview}</p>
                {q.images.length > 0 && (
                  <ul className="editorial__package-image-list">
                    {q.images.map((img) => (
                      <li key={img.imageId} className="editorial__package-image-item">
                        {thumbnails.get(img.path) ? (
                          <img src={thumbnails.get(img.path)} alt={img.altText} className="editorial__image-thumb" />
                        ) : (
                          <span className="editorial__image-alt">(sem pré-visualização)</span>
                        )}
                        <span>{img.placement === "enunciado" ? "Enunciado" : `Alternativa ${img.alternativeLetter}`}</span>
                        <span className="editorial__image-alt">{img.altText}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>

          {preview.canApply && !applyResult && (
            <Button type="button" onClick={() => void handleApply()} isLoading={busy} disabled={!selectedFile}>
              Aplicar pacote
            </Button>
          )}

          {applyResult && (
            <div data-testid="package-applied-result">
              <p role="status">
                {applyResult.alreadyApplied
                  ? "Pacote já havia sido aplicado anteriormente."
                  : `${applyResult.appliedCount} questão(ões) e ${applyResult.imageCount} imagem(ns) criadas como rascunho.`}
              </p>
              {isAdmin && !undoResult && (
                <Button type="button" variant="secondary" onClick={() => void handleUndo()} isLoading={busy}>
                  Desfazer lote
                </Button>
              )}
              {undoResult && (
                <p role="status">{undoResult.alreadyUndone ? "Lote já havia sido desfeito." : `${undoResult.undoneCount} questão(ões) removida(s).`}</p>
              )}
            </div>
          )}
        </Card>
      )}
    </>
  );
}

/* --------------------------------- Modo PDF ENEM (Sprint 22) --------------------------------- */

/** Seção 31 da ordem — badge de status SEMPRE como texto (nunca só cor).
 *  Prioridade: duplicidade > gabarito ausente > estrutura ambígua > imagem
 *  não extraída > pronta. `duplicateStatus` desta sprint só distingue
 *  "exact"/"none" (nunca uma camada "possível" separada — decisão
 *  documentada no relatório final: nenhuma heurística de duplicidade
 *  aproximada foi implementada, só correspondência exata de código ou
 *  fingerprint). */
function pdfQuestionBadge(q: PdfPreviewQuestion): string {
  if (q.duplicateStatus === "exact") return "Já existe no banco";
  if (q.correctAlternative === null) return "Gabarito ausente";
  if (q.warnings.some((w) => /alternativa|ordem/i.test(w))) return "Estrutura ambígua";
  if (q.visualReviewRequired) return "Imagem precisa revisão";
  // Sprint 23 — imagem extraída com sucesso, mas SEMPRE exige confirmação
  // do editor (posicionamento + texto alternativo) antes de poder aplicar
  // (seção 8/10/11 da ordem) — nunca "pronta" sozinha.
  if (q.hasPendingVisualConfirmation) return "Imagem extraída — confirme antes de aplicar";
  if (q.status === "needs_review") return "Precisa revisão";
  return "Pronta";
}

const PLACEMENT_LABELS: Record<string, string> = {
  statement: "Imagem do enunciado",
  option_A: "Imagem da alternativa A",
  option_B: "Imagem da alternativa B",
  option_C: "Imagem da alternativa C",
  option_D: "Imagem da alternativa D",
  option_E: "Imagem da alternativa E",
};

interface PdfSelectionState {
  included: boolean;
  patternPrincipalId: string;
  /** Seção 5/7 da ordem — correção editorial opcional (nunca de gabarito).
   *  `editedAlternatives` sempre tem as 5 chaves A-E, mesmo vazias, para o
   *  formulário controlado nunca perder um campo. */
  editing: boolean;
  editedStatement: string;
  editedAlternatives: Record<"A" | "B" | "C" | "D" | "E", string>;
  /** Sprint 23, seção 8/10 da ordem — confirmação por elemento visual
   *  (chave = `PdfVisualElement.hash`). Nunca preenchido automaticamente
   *  pelo sistema (nem placement nem alt text) — sempre uma ação
   *  explícita da Andreia. */
  visualConfirmations: Record<string, { placement: string; altText: string }>;
}

/** Seção 5 da ordem — edição só faz sentido quando o PROBLEMA é
 *  estrutural: nunca quando falta gabarito (editar texto não resolve),
 *  nunca quando é conteúdo visual (seção 6), nunca quando já é uma
 *  duplicidade exata. */
function isStructurallyEditable(q: PdfPreviewQuestion): boolean {
  return !q.canApply && !q.visualReviewRequired && q.duplicateStatus !== "exact" && q.correctAlternative !== null;
}

/** Sprint 23 — só as imagens raster REALMENTE extraídas (nunca vetor
 *  detectado, nunca ambíguo/decorativo) exigem confirmação individual. */
function pendingImagesFor(q: PdfPreviewQuestion) {
  return q.visualElements.filter((el) => el.kind === "raster" && el.extractionStatus === "extracted");
}

function hasAllVisualConfirmations(q: PdfPreviewQuestion, sel: PdfSelectionState): boolean {
  const pending = pendingImagesFor(q);
  if (pending.length === 0) return true;
  return pending.every((el) => {
    const c = sel.visualConfirmations[el.hash];
    return !!c && c.placement.length > 0 && c.altText.trim().length > 0;
  });
}

function PdfImportPanel({ isAdmin }: { isAdmin: boolean }) {
  const [examFile, setExamFile] = useState<File | null>(null);
  const [answerKeyFile, setAnswerKeyFile] = useState<File | null>(null);
  const [year, setYear] = useState("");
  const [application, setApplication] = useState("");
  const [booklet, setBooklet] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [confirmed, setConfirmed] = useState(false);

  const [patterns, setPatterns] = useState<EditorialPatternSummary[]>([]);
  const [preview, setPreview] = useState<PreviewPdfResponse | null>(null);
  const [selection, setSelection] = useState<Map<number, PdfSelectionState>>(new Map());
  const [finalConfirmChecked, setFinalConfirmChecked] = useState(false);
  const [applyResult, setApplyResult] = useState<{ appliedCount: number; alreadyApplied: boolean; imageUploadFailures: string[] } | null>(null);
  const [undoResult, setUndoResult] = useState<{ undoneCount: number; alreadyUndone: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Seção 8 da ordem — nunca hardcoded para todo PDF: o padrão só vem
  // marcado quando a identidade DETECTADA no cabeçalho real da prova diz
  // "2º dia" (formato tradicional do ENEM: 91-135 Natureza, 136-180
  // Matemática). Sempre um checkbox comum, sempre desmarcável.
  const [mathOnlyFilter, setMathOnlyFilter] = useState(false);

  useEffect(() => {
    fetchEditorialPatterns()
      .then((r) => setPatterns(r.patterns.filter((p) => p.editorialStatus === "published")))
      .catch(() => setPatterns([]));
  }, []);

  function currentIdentity(): PdfExamIdentityInput {
    return { year: Number(year), application, booklet, sourceUrl: sourceUrl || undefined };
  }

  async function handleGeneratePreview() {
    if (!examFile || !answerKeyFile) return;
    setBusy(true);
    setError(null);
    setPreview(null);
    setApplyResult(null);
    setUndoResult(null);
    setFinalConfirmChecked(false);
    try {
      const result = await previewPdfEnem(examFile, answerKeyFile, currentIdentity(), confirmed);
      setPreview(result);
      setMathOnlyFilter(result.documentIdentityCheck?.examDetected.day === 2);
      const initialSelection = new Map<number, PdfSelectionState>();
      for (const q of result.questions) {
        const editedAlternatives: PdfSelectionState["editedAlternatives"] = { A: "", B: "", C: "", D: "", E: "" };
        for (const a of q.alternatives) editedAlternatives[a.letter] = a.text;
        initialSelection.set(q.originalNumber, {
          included: q.canApply && !q.hasPendingVisualConfirmation,
          patternPrincipalId: "",
          editing: false,
          editedStatement: q.statement,
          editedAlternatives,
          visualConfirmations: {},
        });
      }
      setSelection(initialSelection);
    } catch (err) {
      setError(err instanceof EditorialApiError ? err.message : "Não foi possível gerar a prévia deste PDF.");
    } finally {
      setBusy(false);
    }
  }

  function emptySelectionState(): PdfSelectionState {
    return { included: false, patternPrincipalId: "", editing: false, editedStatement: "", editedAlternatives: { A: "", B: "", C: "", D: "", E: "" }, visualConfirmations: {} };
  }

  function updateVisualConfirmation(originalNumber: number, elementHash: string, patch: Partial<{ placement: string; altText: string }>) {
    setSelection((prev) => {
      const next = new Map(prev);
      const current = next.get(originalNumber) ?? emptySelectionState();
      const existing = current.visualConfirmations[elementHash] ?? { placement: "", altText: "" };
      next.set(originalNumber, { ...current, visualConfirmations: { ...current.visualConfirmations, [elementHash]: { ...existing, ...patch } } });
      return next;
    });
  }

  function updateSelection(originalNumber: number, patch: Partial<PdfSelectionState>) {
    setSelection((prev) => {
      const next = new Map(prev);
      const current = next.get(originalNumber) ?? emptySelectionState();
      next.set(originalNumber, { ...current, ...patch });
      return next;
    });
  }

  function updateEditedAlternative(originalNumber: number, letter: "A" | "B" | "C" | "D" | "E", text: string) {
    setSelection((prev) => {
      const next = new Map(prev);
      const current = next.get(originalNumber) ?? emptySelectionState();
      next.set(originalNumber, { ...current, editedAlternatives: { ...current.editedAlternatives, [letter]: text } });
      return next;
    });
  }

  // Seção 8 da ordem — quando o filtro "só Matemática" está ligado, uma
  // questão de Natureza marcada `included` antes de o filtro ser ativado
  // NUNCA entra no apply, mesmo escondida da lista — o filtro esconde E
  // exclui, nunca só um dos dois.
  const visibleQuestions = (preview?.questions ?? []).filter((q) => !mathOnlyFilter || (q.originalNumber >= 136 && q.originalNumber <= 180));
  const visibleNumbers = new Set(visibleQuestions.map((q) => q.originalNumber));
  const questionByNumber = new Map((preview?.questions ?? []).map((q) => [q.originalNumber, q] as const));
  const includedEntries = Array.from(selection.entries()).filter(([originalNumber, s]) => {
    if (!s.included || !visibleNumbers.has(originalNumber)) return false;
    const q = questionByNumber.get(originalNumber);
    // Sprint 23 — mesmo já marcada, uma questão com imagem pendente NUNCA
    // entra no apply se a confirmação (placement + alt text) ficou
    // incompleta depois de marcada (ex.: editor apagou o alt text) — nunca
    // silenciosamente ignorada, simplesmente não conta como incluída.
    return !q || hasAllVisualConfirmations(q, s);
  });
  const includedCount = includedEntries.length;
  const allIncludedHavePattern = includedEntries.every(([, s]) => s.patternPrincipalId.length > 0);
  const canSubmitApply = includedCount > 0 && allIncludedHavePattern && finalConfirmChecked;

  async function handleApply() {
    if (!preview || !examFile || !answerKeyFile || !canSubmitApply) return;
    setBusy(true);
    setError(null);
    try {
      const selectionPayload: PdfApplySelectionEntry[] = includedEntries.map(([originalNumber, s]) => ({
        originalNumber,
        patternPrincipalId: s.patternPrincipalId,
        // Seção 5/7 da ordem — só manda a correção quando o editor de fato
        // abriu o formulário de edição para esta questão; nunca reenvia
        // texto "editado" para uma questão que nunca foi tocada.
        ...(s.editing
          ? {
              reviewedStatement: s.editedStatement,
              reviewedAlternatives: (["A", "B", "C", "D", "E"] as const).map((letter) => ({ letter, text: s.editedAlternatives[letter] })),
            }
          : {}),
        // Sprint 23, seção 8/10 — só manda confirmação para as imagens
        // REALMENTE pendentes desta questão (nunca um objeto vazio quando
        // não há imagem nenhuma).
        ...(pendingImagesFor(questionByNumber.get(originalNumber)!).length > 0
          ? {
              visualConfirmations: pendingImagesFor(questionByNumber.get(originalNumber)!).map((el) => ({
                elementHash: el.hash,
                placement: s.visualConfirmations[el.hash]!.placement as PdfVisualConfirmation["placement"],
                altText: s.visualConfirmations[el.hash]!.altText,
              })),
            }
          : {}),
      }));
      const result = await applyPdfEnem(preview.batchId, examFile, answerKeyFile, currentIdentity(), selectionPayload);
      setApplyResult(result);
    } catch (err) {
      setError(err instanceof EditorialApiError ? err.message : "Não foi possível aplicar esta importação.");
    } finally {
      setBusy(false);
    }
  }

  async function handleUndo() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const result = await undoImportBatch(preview.batchId);
      setUndoResult(result);
    } catch (err) {
      setError(err instanceof EditorialApiError ? err.message : "Não foi possível desfazer esta importação.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Card className="editorial__nav-card">
        <p>1. Arquivos</p>
        <label htmlFor="pdf-exam-file" className="editorial__field-label">
          PDF da prova
        </label>
        <input
          id="pdf-exam-file"
          type="file"
          accept="application/pdf,.pdf"
          onChange={(e) => setExamFile(e.target.files?.[0] ?? null)}
          disabled={busy}
        />
        <label htmlFor="pdf-answerkey-file" className="editorial__field-label">
          PDF do gabarito oficial
        </label>
        <input
          id="pdf-answerkey-file"
          type="file"
          accept="application/pdf,.pdf"
          onChange={(e) => setAnswerKeyFile(e.target.files?.[0] ?? null)}
          disabled={busy}
        />
      </Card>

      <Card className="editorial__nav-card">
        <p>2. Identificação</p>
        <label htmlFor="pdf-year" className="editorial__field-label">
          Ano
        </label>
        <input id="pdf-year" type="number" value={year} onChange={(e) => setYear(e.target.value)} disabled={busy} />
        <label htmlFor="pdf-application" className="editorial__field-label">
          Aplicação
        </label>
        <input
          id="pdf-application"
          type="text"
          placeholder="Ex.: Aplicação regular, Reaplicação, PPL"
          value={application}
          onChange={(e) => setApplication(e.target.value)}
          disabled={busy}
        />
        <label htmlFor="pdf-booklet" className="editorial__field-label">
          Caderno/cor
        </label>
        <input id="pdf-booklet" type="text" placeholder="Ex.: Caderno Azul" value={booklet} onChange={(e) => setBooklet(e.target.value)} disabled={busy} />
        <label htmlFor="pdf-source-url" className="editorial__field-label">
          Fonte/URL (opcional)
        </label>
        <input id="pdf-source-url" type="text" value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} disabled={busy} />
        <label>
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} disabled={busy} />
          Confirmo que estes arquivos correspondem à prova e ao gabarito oficial da mesma aplicação/caderno.
        </label>
      </Card>

      <Card className="editorial__nav-card">
        <p>3. Analisar</p>
        <div className="editorial__actions">
          <Button
            type="button"
            onClick={() => void handleGeneratePreview()}
            isLoading={busy}
            disabled={!examFile || !answerKeyFile || !confirmed || !year || !application || !booklet}
          >
            Gerar prévia
          </Button>
        </div>
      </Card>

      {error && <ErrorState description={error} />}

      {preview && !applyResult && (
        <Card className="editorial__nav-card" data-testid="pdf-preview">
          <h2>4. Revisão</h2>
          <p>
            {preview.detectedQuestionCount} questões detectadas — {preview.questions.filter((q) => q.canApply).length} prontas,{" "}
            {preview.questions.filter((q) => !q.canApply).length} precisam revisão,{" "}
            {preview.questions.filter((q) => q.visualReviewRequired).length} com imagens,{" "}
            {preview.questions.filter((q) => q.duplicateStatus === "exact").length} possíveis duplicidades.
          </p>
          <label>
            <input type="checkbox" checked={mathOnlyFilter} onChange={(e) => setMathOnlyFilter(e.target.checked)} disabled={busy} />
            Importar somente Matemática (136–180)
          </label>

          {preview.globalWarnings.length > 0 && (
            <ul role="alert">
              {preview.globalWarnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}

          <ul className="editorial__package-questions" data-testid="pdf-question-list">
            {visibleQuestions.map((q) => {
              const sel = selection.get(q.originalNumber) ?? emptySelectionState();
              const badge = pdfQuestionBadge(q);
              const editable = isStructurallyEditable(q);
              const pendingImages = pendingImagesFor(q);
              const canBeIncluded = (q.canApply || (editable && sel.editing)) && hasAllVisualConfirmations(q, sel);
              return (
                <li key={q.tempId} className="editorial__package-question">
                  <p className="editorial__package-question-header">
                    <strong>Questão {q.originalNumber}</strong> — Página {q.pageStart === q.pageEnd ? q.pageStart : `${q.pageStart}-${q.pageEnd}`}{" "}
                    <span>{badge}</span>
                  </p>

                  {sel.editing ? (
                    <>
                      <label htmlFor={`pdf-statement-${q.originalNumber}`} className="editorial__field-label">
                        Enunciado (correção editorial)
                      </label>
                      <textarea
                        id={`pdf-statement-${q.originalNumber}`}
                        value={sel.editedStatement}
                        onChange={(e) => updateSelection(q.originalNumber, { editedStatement: e.target.value })}
                        disabled={busy}
                      />
                      <ul>
                        {(["A", "B", "C", "D", "E"] as const).map((letter) => (
                          <li key={letter}>
                            <label htmlFor={`pdf-alt-${q.originalNumber}-${letter}`} className="editorial__field-label">
                              Alternativa {letter}
                              {q.correctAlternative === letter ? " (gabarito oficial — nunca editável)" : ""}
                            </label>
                            <input
                              id={`pdf-alt-${q.originalNumber}-${letter}`}
                              type="text"
                              value={sel.editedAlternatives[letter]}
                              onChange={(e) => updateEditedAlternative(q.originalNumber, letter, e.target.value)}
                              disabled={busy}
                            />
                          </li>
                        ))}
                      </ul>
                      <Button type="button" variant="secondary" onClick={() => updateSelection(q.originalNumber, { editing: false })} disabled={busy}>
                        Cancelar correção
                      </Button>
                    </>
                  ) : (
                    <>
                      <p>{q.statement}</p>
                      <ul>
                        {q.alternatives.map((a) => (
                          <li key={a.letter}>
                            {a.letter}. {a.text}
                            {q.correctAlternative === a.letter ? " (gabarito oficial)" : ""}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}

                  {q.warnings.length > 0 && (
                    <ul role="alert">
                      {q.warnings.map((w, i) => (
                        <li key={i}>{w}</li>
                      ))}
                    </ul>
                  )}

                  {editable && !sel.editing && (
                    <Button type="button" variant="secondary" onClick={() => updateSelection(q.originalNumber, { editing: true })} disabled={busy}>
                      Editar enunciado/alternativas
                    </Button>
                  )}

                  {q.visualReviewRequired && (
                    <p>
                      Esta questão tem conteúdo visual (gráfico/imagem/tabela) que não foi extraído automaticamente. Para incluí-la, crie a questão
                      manualmente no editor de questões e anexe a imagem — os dados extraídos acima (enunciado, alternativas, gabarito) podem ser
                      copiados de referência.{" "}
                      <a href="/editorial/questoes/nova" target="_blank" rel="noreferrer">
                        Abrir editor de questões
                      </a>
                    </p>
                  )}

                  {pendingImages.length > 0 && (
                    <div className="editorial__pdf-pending-images">
                      <p>
                        {pendingImages.length} imagem(ns) extraída(s) automaticamente. Confirme onde cada uma pertence e descreva o que aparece —
                        obrigatório antes de aplicar.
                      </p>
                      <ul>
                        {pendingImages.map((el) => {
                          const confirmation = sel.visualConfirmations[el.hash] ?? { placement: "", altText: "" };
                          return (
                            <li key={el.hash}>
                              {el.thumbnailDataUri && <img src={el.thumbnailDataUri} alt="Miniatura da imagem extraída" className="editorial__pdf-thumbnail" />}
                              <label htmlFor={`pdf-visual-placement-${q.originalNumber}-${el.hash}`} className="editorial__field-label">
                                Onde esta imagem pertence
                              </label>
                              <select
                                id={`pdf-visual-placement-${q.originalNumber}-${el.hash}`}
                                value={confirmation.placement}
                                onChange={(e) => updateVisualConfirmation(q.originalNumber, el.hash, { placement: e.target.value })}
                                disabled={busy}
                              >
                                <option value="">Não sei identificar</option>
                                {Object.entries(PLACEMENT_LABELS).map(([value, label]) => (
                                  <option key={value} value={value}>
                                    {label}
                                  </option>
                                ))}
                              </select>
                              <label htmlFor={`pdf-visual-alttext-${q.originalNumber}-${el.hash}`} className="editorial__field-label">
                                Descreva o que aparece na imagem
                              </label>
                              <input
                                id={`pdf-visual-alttext-${q.originalNumber}-${el.hash}`}
                                type="text"
                                value={confirmation.altText}
                                onChange={(e) => updateVisualConfirmation(q.originalNumber, el.hash, { altText: e.target.value })}
                                disabled={busy}
                              />
                            </li>
                          );
                        })}
                      </ul>
                      {!hasAllVisualConfirmations(q, sel) && (
                        <p role="alert">Confirme posicionamento e descrição de todas as imagens acima para poder selecionar esta questão.</p>
                      )}
                    </div>
                  )}

                  <label htmlFor={`pdf-pattern-${q.originalNumber}`} className="editorial__field-label">
                    Padrão principal
                  </label>
                  <select
                    id={`pdf-pattern-${q.originalNumber}`}
                    value={sel.patternPrincipalId}
                    onChange={(e) => updateSelection(q.originalNumber, { patternPrincipalId: e.target.value })}
                    disabled={busy || !sel.included}
                  >
                    <option value="">Selecione um padrão</option>
                    {patterns.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <label>
                    <input
                      type="checkbox"
                      checked={sel.included}
                      disabled={busy || !canBeIncluded}
                      onChange={(e) => updateSelection(q.originalNumber, { included: e.target.checked })}
                    />
                    Selecionar para aplicar
                  </label>
                </li>
              );
            })}
          </ul>

          <p>Serão criadas {includedCount} questões em rascunho.</p>
          <label>
            <input type="checkbox" checked={finalConfirmChecked} onChange={(e) => setFinalConfirmChecked(e.target.checked)} disabled={busy} />
            Revisei os gabaritos e os dados desta importação.
          </label>
          <div className="editorial__actions">
            <Button type="button" onClick={() => void handleApply()} isLoading={busy} disabled={!canSubmitApply}>
              Criar {includedCount} rascunhos
            </Button>
          </div>
        </Card>
      )}

      {applyResult && (
        <Card className="editorial__nav-card" data-testid="pdf-applied-result">
          <p role="status">
            {applyResult.alreadyApplied ? "Este lote já havia sido aplicado anteriormente." : `${applyResult.appliedCount} questão(ões) criada(s) como rascunho.`}
          </p>
          {applyResult.imageUploadFailures.length > 0 && (
            <ul role="alert">
              {applyResult.imageUploadFailures.map((msg, i) => (
                <li key={i}>{msg} Anexe manualmente pelo editor de questão.</li>
              ))}
            </ul>
          )}
          {isAdmin && preview && !undoResult && (
            <Button type="button" variant="secondary" onClick={() => void handleUndo()} isLoading={busy}>
              Desfazer lote
            </Button>
          )}
          {undoResult && (
            <p role="status">{undoResult.alreadyUndone ? "Lote já havia sido desfeito." : `${undoResult.undoneCount} questão(ões) removida(s).`}</p>
          )}
        </Card>
      )}
    </>
  );
}
