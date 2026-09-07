import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { ErrorState } from "../../components/ErrorState";
import {
  applyImportBatch,
  applyPackageBatch,
  EditorialApiError,
  previewImportFile,
  previewPackageFile,
  templateV2DownloadUrl,
  undoImportBatch,
  type ImportRowError,
  type PackageError,
  type PreviewImportResponse,
  type PreviewPackageResponse,
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

type ImportMode = "csv" | "zip";

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
        </div>
        <p className="editorial__mode-description">
          {mode === "csv"
            ? "Para questões sem imagens ou importações estruturadas."
            : "Para importar questões e imagens juntas. Você não precisa renomear as imagens."}
        </p>
      </Card>

      {mode === "csv" ? <CsvImportPanel /> : <PackageImportPanel isAdmin={role === "admin"} />}
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
