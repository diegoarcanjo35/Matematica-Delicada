import { useRef, useState } from "react";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { ErrorState } from "../../components/ErrorState";
import {
  applyImportBatch,
  EditorialApiError,
  previewImportFile,
  templateDownloadUrl,
  undoImportBatch,
  type ImportRowError,
  type PreviewImportResponse,
} from "../../api/editorialClient";
import { useEditorialRole } from "../../auth/editorialRoleContext";
import "./editorial.css";

/* Importação CSV — /editorial/importacoes, Sprint 7 v1.0, seção 9 da
   ordem: baixar template, selecionar CSV local, pré-visualizar, ver
   tabela de erros por linha, aplicar, ver resultado, desfazer quando
   permitido (admin, lote aplicado, todas as questões ainda em rascunho). */

export function EditorialImportsPage() {
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
    <div className="editorial">
      <h1>Importação de questões (CSV)</h1>

      <Card className="editorial__nav-card">
        <p>1. Baixe o template com os cabeçalhos esperados.</p>
        <a href={templateDownloadUrl()} download="questoes-importacao-v1.csv">
          <Button type="button" variant="secondary">
            Baixar template CSV
          </Button>
        </a>
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
                    {/* Todo texto vem do JSON da API e é renderizado como
                        DADO puro pelo React (nunca dangerouslySetInnerHTML) —
                        mesmo um valor começando por "=", "+", "-" ou "@" é
                        só texto na tela, nunca executado. */}
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
                <p role="status">
                  {undoResult.alreadyUndone ? "Lote já havia sido desfeito." : `${undoResult.undoneCount} questão(ões) removida(s).`}
                </p>
              )}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
