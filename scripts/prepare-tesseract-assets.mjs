/* Sprint 24.1 — copia os assets do OCR (worker script, núcleo WASM,
   traineddata) de `node_modules` (dependências pinadas no package.json,
   nunca um download ad hoc) para `public/tesseract/`, servidos pelo MESMO
   origin do Matemática Delicada. Roda como `prebuild` (mecanismo nativo do
   npm) antes de todo `npm run build` — nunca um passo manual esquecível.

   Nunca usa jsdelivr/unpkg/GitHub raw em runtime: os arquivos abaixo já
   existem localmente porque `tesseract.js-core`/`@tesseract.js-data/por`
   são dependências normais do projeto (resolvidas pelo npm/package-lock,
   o mesmo processo controlado usado para qualquer outra dependência).

   Núcleo escolhido: `tesseract-core-lstm` (variante LSTM simples, SEM
   SIMD) — deliberadamente NUNCA a variante com detecção automática de
   SIMD/relaxed-SIMD que o padrão do tesseract.js usaria (ver
   `node_modules/tesseract.js/src/worker-script/browser/getCore.js`):
   um `corePath` apontando para um arquivo `.js` específico (não um
   diretório) é usado DIRETAMENTE, sem nenhuma detecção de feature nem
   fetch condicional — same-origin garantido e determinístico em qualquer
   navegador, ao custo de abrir mão do ganho de performance do SIMD
   (aceitável — o OCR já roda em segundo plano, nunca bloqueando a UI). */

import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const targetDir = path.join(rootDir, "public", "tesseract");

const FILES = [
  { from: path.join(rootDir, "node_modules", "tesseract.js", "dist", "worker.min.js"), to: "worker.min.js" },
  { from: path.join(rootDir, "node_modules", "tesseract.js-core", "tesseract-core-lstm.wasm.js"), to: "tesseract-core-lstm.wasm.js" },
  { from: path.join(rootDir, "node_modules", "tesseract.js-core", "tesseract-core-lstm.wasm"), to: "tesseract-core-lstm.wasm" },
  { from: path.join(rootDir, "node_modules", "@tesseract.js-data", "por", "4.0.0_best_int", "por.traineddata.gz"), to: "por.traineddata.gz" },
];

mkdirSync(targetDir, { recursive: true });

for (const file of FILES) {
  if (!existsSync(file.from)) {
    console.error(`prepare-tesseract-assets: arquivo esperado não encontrado: ${file.from}`);
    console.error("Confira se 'npm install' rodou (tesseract.js-core e @tesseract.js-data/por são dependências normais do projeto).");
    process.exit(1);
  }
  copyFileSync(file.from, path.join(targetDir, file.to));
  console.log(`prepare-tesseract-assets: copiado ${file.to}`);
}

console.log(`prepare-tesseract-assets: ${FILES.length} arquivo(s) prontos em public/tesseract/ (servidos pelo mesmo origin, nunca um CDN externo).`);
