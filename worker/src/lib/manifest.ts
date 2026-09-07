/* Manifest v1 do Pacote ZIP — Sprint 19, seções 6/7 da ordem. Faz SÓ a
   associação técnica questão↔imagem (placement/alternativeLetter/altText/
   caption/ordem) — Andreia nunca edita este arquivo, ele é produzido pelo
   processo técnico que prepara o pacote. Validação 100% pura (sem D1) —
   cruzamento com códigos de questão reais e com as entradas do ZIP é feito
   pelo chamador (questionPackageImportService.ts), que tem acesso ao CSV
   V2 já parseado e à lista de entradas do ZIP. */

import { QUESTION_ALTERNATIVE_LETTERS, type QuestionAlternativeLetter } from "./questionsValidation";
import { isSafeZipEntryPath, normalizeZipPathForComparison } from "./zip";

export const MANIFEST_SUPPORTED_VERSION = 1;

export interface ManifestImageEntry {
  file: string;
  placement: "enunciado" | "alternativa";
  alternativeLetter: QuestionAlternativeLetter | null;
  altText: string;
  caption: string | null;
}

export interface ManifestQuestionEntry {
  code: string;
  images: ManifestImageEntry[];
}

export interface ParsedManifest {
  version: number;
  questions: ManifestQuestionEntry[];
}

export interface ManifestError {
  code?: string;
  file?: string;
  message: string;
}

export interface ManifestParseResult {
  ok: boolean;
  manifest?: ParsedManifest;
  errors?: ManifestError[];
}

/** Sprint 19, seção 6 da ordem — `position` NUNCA é digitado no manifest:
 *  deriva-se da ordem do array dentro de CADA placement (enunciado tem sua
 *  própria sequência 0,1,2...; CADA alternativa A-E tem a sua própria,
 *  independente das outras) — mantém ordem determinística sem exigir um
 *  campo extra que Andreia (ou o processo técnico) poderia errar. */
export function derivePositionKey(placement: "enunciado" | "alternativa", alternativeLetter: string | null): string {
  return placement === "enunciado" ? "enunciado" : `alternativa:${alternativeLetter}`;
}

/** Parseia e valida a ESTRUTURA do manifest.json (seção 7 da ordem) — JSON
 *  inválido, version desconhecida, code duplicado NO PRÓPRIO manifest,
 *  placement/alternativeLetter incoerentes, altText vazio, mais de 15
 *  imagens por questão, e todo problema de PATH (traversal/absoluto/drive
 *  letter/fora do namespace `imagens/`/duplicidade após normalização) já
 *  aqui — nunca delegado silenciosamente para depois. Cruzamento com
 *  código de questão real e existência do arquivo no ZIP fica para o
 *  chamador (esta função não tem acesso a nenhum dos dois). */
export function parseAndValidateManifest(rawBytes: Uint8Array, maxImagesPerQuestion: number): ManifestParseResult {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(rawBytes);
  } catch {
    return { ok: false, errors: [{ message: "manifest.json não está em UTF-8 válido." }] };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, errors: [{ message: "manifest.json não é um JSON válido." }] };
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: [{ message: "manifest.json deve ser um objeto." }] };
  }
  const obj = raw as Record<string, unknown>;

  if (obj.version !== MANIFEST_SUPPORTED_VERSION) {
    return { ok: false, errors: [{ message: `Versão de manifest não suportada (esperado ${MANIFEST_SUPPORTED_VERSION}).` }] };
  }

  if (!Array.isArray(obj.questions)) {
    return { ok: false, errors: [{ message: "manifest.json: \"questions\" deve ser uma lista." }] };
  }

  const errors: ManifestError[] = [];
  const questions: ManifestQuestionEntry[] = [];
  const seenCodes = new Set<string>();
  const seenNormalizedPathsGlobal = new Set<string>();

  for (const rawQuestion of obj.questions) {
    if (typeof rawQuestion !== "object" || rawQuestion === null) {
      errors.push({ message: "Entrada de questão inválida no manifest (deve ser um objeto)." });
      continue;
    }
    const q = rawQuestion as Record<string, unknown>;
    const code = typeof q.code === "string" ? q.code.trim() : "";
    if (!code) {
      errors.push({ message: "Entrada de questão no manifest sem \"code\"." });
      continue;
    }
    if (seenCodes.has(code)) {
      errors.push({ code, message: `Código "${code}" duplicado no manifest.` });
      continue;
    }
    seenCodes.add(code);

    if (!Array.isArray(q.images)) {
      errors.push({ code, message: `Questão "${code}": "images" deve ser uma lista.` });
      continue;
    }
    if (q.images.length > maxImagesPerQuestion) {
      errors.push({ code, message: `Questão "${code}" excede o limite de ${maxImagesPerQuestion} imagens.` });
      continue;
    }

    const images: ManifestImageEntry[] = [];
    let questionHasError = false;

    for (const rawImage of q.images) {
      if (typeof rawImage !== "object" || rawImage === null) {
        errors.push({ code, message: `Questão "${code}": entrada de imagem inválida (deve ser um objeto).` });
        questionHasError = true;
        continue;
      }
      const img = rawImage as Record<string, unknown>;
      const file = typeof img.file === "string" ? img.file : "";
      if (!file) {
        errors.push({ code, message: `Questão "${code}": imagem sem "file".` });
        questionHasError = true;
        continue;
      }

      // Sprint 19, seção 6 da ordem — as entradas do manifest referenciam o
      // arquivo pelo path COMPLETO dentro do ZIP (ex.: "imagens/foto.png"),
      // exatamente como aparece no exemplo da ordem. Reaproveita a MESMA
      // validação de segurança de path do leitor de ZIP (seção 7/8) — nunca
      // uma segunda implementação paralela que pudesse divergir.
      if (!isSafeZipEntryPath(file)) {
        errors.push({ code, file, message: `Questão "${code}": caminho de imagem inválido/inseguro ("${file}").` });
        questionHasError = true;
        continue;
      }
      if (!file.startsWith("imagens/")) {
        errors.push({ code, file, message: `Questão "${code}": imagem fora do namespace "imagens/" ("${file}").` });
        questionHasError = true;
        continue;
      }

      const placementRaw = typeof img.placement === "string" ? img.placement : "";
      if (placementRaw !== "enunciado" && placementRaw !== "alternativa") {
        errors.push({ code, file, message: `Questão "${code}", imagem "${file}": placement inválido.` });
        questionHasError = true;
        continue;
      }
      const placement = placementRaw as "enunciado" | "alternativa";

      const alternativeLetterRaw = img.alternativeLetter;
      let alternativeLetter: QuestionAlternativeLetter | null = null;
      if (placement === "alternativa") {
        if (typeof alternativeLetterRaw !== "string" || !(QUESTION_ALTERNATIVE_LETTERS as readonly string[]).includes(alternativeLetterRaw)) {
          errors.push({ code, file, message: `Questão "${code}", imagem "${file}": placement="alternativa" exige alternativeLetter A-E.` });
          questionHasError = true;
          continue;
        }
        alternativeLetter = alternativeLetterRaw as QuestionAlternativeLetter;
      } else if (alternativeLetterRaw !== undefined && alternativeLetterRaw !== null) {
        errors.push({ code, file, message: `Questão "${code}", imagem "${file}": placement="enunciado" não pode informar alternativeLetter.` });
        questionHasError = true;
        continue;
      }

      const altText = typeof img.altText === "string" ? img.altText.trim() : "";
      if (!altText) {
        errors.push({ code, file, message: `Questão "${code}", imagem "${file}": altText não pode ser vazio.` });
        questionHasError = true;
        continue;
      }
      const caption = typeof img.caption === "string" && img.caption.trim().length > 0 ? img.caption.trim() : null;

      // Mesma imagem referenciada duas vezes NO MANIFEST INTEIRO (nunca só
      // dentro da mesma questão) — uma imagem pertence a exatamente um
      // lugar.
      const normalizedGlobal = normalizeZipPathForComparison(file);
      if (seenNormalizedPathsGlobal.has(normalizedGlobal)) {
        errors.push({ code, file, message: `Imagem "${file}" referenciada mais de uma vez no manifest.` });
        questionHasError = true;
        continue;
      }
      seenNormalizedPathsGlobal.add(normalizedGlobal);

      images.push({ file, placement, alternativeLetter, altText, caption });
    }

    if (!questionHasError) questions.push({ code, images });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, manifest: { version: MANIFEST_SUPPORTED_VERSION, questions } };
}
