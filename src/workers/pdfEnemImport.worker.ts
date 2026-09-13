/* Sprint 24.2 — Web Worker real do navegador (nunca confundir com o "fake
   worker" síncrono de pdfjs-dist usado por `worker/src/lib/pdfEnemExtractor.ts`
   dentro do Cloudflare Worker — aqui é um Worker de verdade do browser,
   mesma técnica do Eleve PDF: `new Worker(new URL(...), {type:"module"})`
   no cliente, ver `pdfEnemImportClient.ts`).

   Camada FINA de propositado — toda a lógica de verdade vive em
   `pdfEnemImportPipeline.ts` (puro, sem DOM, testável em Node). Este
   arquivo só faz a ponte postMessage <-> pipeline, para não deixar a UI
   travada durante o processamento (seção 14 da ordem). */

import { runClientPdfImportPipeline, type PdfImportProgress } from "./pdfEnemImportPipeline";

export interface PdfEnemImportWorkerRequest {
  id: string;
  type: "run" | "cancel";
  examBytes?: ArrayBuffer;
  answerKeyBytes?: ArrayBuffer;
}

export type PdfEnemImportWorkerResponse =
  | { id: string; type: "progress"; progress: PdfImportProgress }
  | { id: string; type: "success"; result: Awaited<ReturnType<typeof runClientPdfImportPipeline>> & { ok: true } }
  | { id: string; type: "error"; reason: string; message: string };

const controllersById = new Map<string, AbortController>();

self.onmessage = async (event: MessageEvent<PdfEnemImportWorkerRequest>) => {
  const request = event.data;

  if (request.type === "cancel") {
    controllersById.get(request.id)?.abort();
    return;
  }

  if (request.type === "run") {
    if (!request.examBytes || !request.answerKeyBytes) {
      const response: PdfEnemImportWorkerResponse = { id: request.id, type: "error", reason: "invalid_request", message: "Requisição inválida ao worker de importação." };
      self.postMessage(response);
      return;
    }
    const controller = new AbortController();
    controllersById.set(request.id, controller);
    try {
      const result = await runClientPdfImportPipeline(new Uint8Array(request.examBytes), new Uint8Array(request.answerKeyBytes), {
        signal: controller.signal,
        onProgress: (progress) => {
          const response: PdfEnemImportWorkerResponse = { id: request.id, type: "progress", progress };
          self.postMessage(response);
        },
      });
      if (result.ok) {
        const response: PdfEnemImportWorkerResponse = { id: request.id, type: "success", result };
        self.postMessage(response);
      } else {
        const response: PdfEnemImportWorkerResponse = { id: request.id, type: "error", reason: result.reason, message: result.message };
        self.postMessage(response);
      }
    } catch (error) {
      const response: PdfEnemImportWorkerResponse = {
        id: request.id,
        type: "error",
        reason: "unexpected",
        message: error instanceof Error ? error.message : "Erro inesperado ao processar o PDF no navegador.",
      };
      self.postMessage(response);
    } finally {
      controllersById.delete(request.id);
    }
  }
};
