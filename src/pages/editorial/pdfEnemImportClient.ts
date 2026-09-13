/* Sprint 24.2 — cliente (thread principal) do importador ENEM client-side.
   Mesma técnica do Eleve PDF (`src/lib/pdfWorkerClient.ts`): cria o Worker
   sob demanda, correlaciona requisição/resposta por `id`, expõe progresso
   via callback e permite cancelar. Nunca reprocessa nada no Worker
   Cloudflare — todo o trabalho pesado acontece aqui, no navegador (ver
   `src/workers/pdfEnemImportPipeline.ts`). */

import type { PdfEnemImportWorkerRequest, PdfEnemImportWorkerResponse } from "../../workers/pdfEnemImport.worker";
import type { PdfImportProgress, PdfImportPipelineOk } from "../../workers/pdfEnemImportPipeline";

let worker: Worker | null = null;
let requestCounter = 0;

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("../../workers/pdfEnemImport.worker.ts", import.meta.url), { type: "module" });
  }
  return worker;
}

function nextId(): string {
  requestCounter += 1;
  return `pdf-import-${requestCounter}-${Date.now()}`;
}

export class PdfClientImportError extends Error {
  reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.reason = reason;
  }
}

export interface RunPdfClientImportHandle {
  promise: Promise<PdfImportPipelineOk>;
  cancel: () => void;
}

/** Roda o pipeline inteiro no Worker do navegador. `examBytes`/
 *  `answerKeyBytes` são transferidos (Transferable) — nunca copiados —
 *  mesma técnica do Eleve PDF; por isso o CHAMADOR não pode mais usar os
 *  `ArrayBuffer` originais depois desta chamada (ficam "detached"). */
export function runPdfClientImport(examBytes: ArrayBuffer, answerKeyBytes: ArrayBuffer, onProgress?: (progress: PdfImportProgress) => void): RunPdfClientImportHandle {
  const id = nextId();
  const w = getWorker();
  let settled = false;

  const promise = new Promise<PdfImportPipelineOk>((resolve, reject) => {
    const handleMessage = (event: MessageEvent<PdfEnemImportWorkerResponse>) => {
      const data = event.data;
      if (data.id !== id) return;
      if (data.type === "progress") {
        onProgress?.(data.progress);
        return;
      }
      if (data.type === "error") {
        settled = true;
        w.removeEventListener("message", handleMessage);
        reject(new PdfClientImportError(data.reason, data.message));
        return;
      }
      if (data.type === "success") {
        settled = true;
        w.removeEventListener("message", handleMessage);
        resolve(data.result);
      }
    };
    w.addEventListener("message", handleMessage);
    const request: PdfEnemImportWorkerRequest = { id, type: "run", examBytes, answerKeyBytes };
    w.postMessage(request, [examBytes, answerKeyBytes]);
  });

  const cancel = () => {
    if (settled) return;
    const request: PdfEnemImportWorkerRequest = { id, type: "cancel" };
    w.postMessage(request);
  };

  return { promise, cancel };
}

/** Encerra o Worker (libera memória) — chamar quando a página de
 *  importação é desmontada, nunca no meio de uma importação em
 *  andamento. */
export function terminatePdfClientImportWorker(): void {
  worker?.terminate();
  worker = null;
}
