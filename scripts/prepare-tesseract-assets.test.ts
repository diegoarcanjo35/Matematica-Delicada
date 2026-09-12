// @vitest-environment node
/* Sprint 24.1 — testa o script de self-hosting dos assets de OCR. Roda o
   script REAL (child process) contra o repositório real (nunca um fixture
   isolado — o objetivo é confirmar que os arquivos das dependências
   pinadas em package.json realmente existem e são copiados corretamente
   para public/tesseract/, servido pelo MESMO origin do app — nunca um
   host externo). */
import { execFileSync } from "node:child_process";
import { existsSync, statSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const targetDir = path.join(rootDir, "public", "tesseract");
const scriptPath = path.join(rootDir, "scripts", "prepare-tesseract-assets.mjs");

function sha256(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

describe("prepare-tesseract-assets.mjs — self-host dos assets de OCR (Sprint 24.1)", () => {
  it("roda com sucesso e produz exatamente os 4 arquivos esperados, todos não vazios", () => {
    execFileSync(process.execPath, [scriptPath], { cwd: rootDir, stdio: "pipe" });

    const expectedFiles = ["worker.min.js", "tesseract-core-lstm.wasm.js", "tesseract-core-lstm.wasm", "por.traineddata.gz"];
    for (const file of expectedFiles) {
      const filePath = path.join(targetDir, file);
      expect(existsSync(filePath), `esperava ${file} em public/tesseract/`).toBe(true);
      expect(statSync(filePath).size).toBeGreaterThan(0);
    }
  });

  it("o traineddata copiado é BYTE-A-BYTE idêntico ao da dependência pinada @tesseract.js-data/por (nunca uma cópia alterada)", () => {
    execFileSync(process.execPath, [scriptPath], { cwd: rootDir, stdio: "pipe" });

    const source = path.join(rootDir, "node_modules", "@tesseract.js-data", "por", "4.0.0_best_int", "por.traineddata.gz");
    const copied = path.join(targetDir, "por.traineddata.gz");
    expect(sha256(copied)).toBe(sha256(source));
  });

  it("o núcleo WASM copiado é BYTE-A-BYTE idêntico ao de tesseract.js-core (dependência pinada)", () => {
    execFileSync(process.execPath, [scriptPath], { cwd: rootDir, stdio: "pipe" });

    const sourceJs = path.join(rootDir, "node_modules", "tesseract.js-core", "tesseract-core-lstm.wasm.js");
    const sourceWasm = path.join(rootDir, "node_modules", "tesseract.js-core", "tesseract-core-lstm.wasm");
    expect(sha256(path.join(targetDir, "tesseract-core-lstm.wasm.js"))).toBe(sha256(sourceJs));
    expect(sha256(path.join(targetDir, "tesseract-core-lstm.wasm"))).toBe(sha256(sourceWasm));
  });
});
