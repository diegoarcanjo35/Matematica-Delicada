/* Parser CSV mínimo (RFC 4180) — sem dependência nova. Suporta aspas,
   vírgulas e quebras de linha dentro de campos entre aspas, e BOM UTF-8.
   Nunca lança para CSV malformado — retorna `{ ok: false }` com um motivo
   controlado (seção 8.3 da ordem: "CSV malformado deve retornar erro
   controlado, nunca travar Worker"). */

export interface CsvParseResult {
  ok: boolean;
  rows?: string[][];
  error?: string;
}

const BOM = "﻿";

export function stripBom(text: string): string {
  return text.startsWith(BOM) ? text.slice(1) : text;
}

export function parseCsv(rawText: string, maxRows: number): CsvParseResult {
  const text = stripBom(rawText);
  if (text.length === 0) return { ok: false, error: "Arquivo vazio." };

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const len = text.length;

  while (i < len) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += char;
      i++;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (char === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (char === "\r") {
      i++;
      continue;
    }
    if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      if (rows.length > maxRows) return { ok: false, error: `O arquivo excede o limite de ${maxRows} linhas.` };
      continue;
    }
    field += char;
    i++;
  }

  if (inQuotes) return { ok: false, error: "CSV malformado: aspas não fechadas." };

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  // Remove linhas totalmente vazias no final do arquivo (comum em exports de planilha).
  while (rows.length > 0 && rows[rows.length - 1].every((cell) => cell === "")) {
    rows.pop();
  }

  if (rows.length === 0) return { ok: false, error: "Arquivo vazio." };
  if (rows.length > maxRows) return { ok: false, error: `O arquivo excede o limite de ${maxRows} linhas.` };

  return { ok: true, rows };
}

/* ---------------------------------------------------------------------------
   Sprint 7 v1.1, Correção B — serialização SEGURA para EXPORTAÇÃO/relatório
   CSV. Isto é estritamente um problema de EXPORTAÇÃO: a importação (acima)
   trata toda célula como texto puro e nunca rejeita conteúdo matemático
   legítimo (`-5`, `+3`, `= 2x + 4`, `@ representa uma variável`) — só na
   hora de produzir um arquivo CSV que alguém pode reabrir numa planilha é
   que um valor começando por `=`, `+`, `-` ou `@` precisa ser neutralizado,
   para que o programa de planilha nunca o interprete como fórmula
   executável. Isso é só da REPRESENTAÇÃO exportada — o conteúdo armazenado
   nunca é alterado por estas funções (docs/BANCO_QUESTOES.md, seção CSV).
   --------------------------------------------------------------------------- */

const DANGEROUS_LEADING_CHARS = new Set(["=", "+", "-", "@"]);

/** Verifica o primeiro caractere NÃO-BRANCO do valor — espaços antes do
 *  prefixo não escapam da checagem (seção 3 da ordem v1.1: "espaços antes
 *  do prefixo não burlam a neutralização"). Só espaço e tab contam como
 *  "branco" aqui; uma quebra de linha logo no início já não é um prefixo de
 *  fórmula reconhecido por nenhuma planilha, então não precisa ser tratada
 *  como tal. */
export function hasDangerousLeadingCharacter(value: string): boolean {
  const firstNonBlank = value.match(/^[ \t]*(.)/);
  if (!firstNonBlank) return false;
  return DANGEROUS_LEADING_CHARS.has(firstNonBlank[1]);
}

/** Neutraliza para exportação: prefixa uma aspa simples no INÍCIO absoluto
 *  do valor (posição 0 — antes de qualquer espaço em branco também), a
 *  estratégia documentada e testada (Excel/Sheets/LibreOffice tratam a
 *  célula inteira como texto literal a partir da aspa, então o espaço em
 *  branco remanescente não reabre a interpretação de fórmula). Conteúdo
 *  comum (sem prefixo perigoso) volta inalterado — nunca ganha apóstrofo
 *  desnecessário. */
export function neutralizeForCsvExport(value: string): string {
  return hasDangerousLeadingCharacter(value) ? `'${value}` : value;
}

/** Escaping RFC 4180 puro (aspas/vírgulas/quebras de linha) — sempre
 *  aplicado, independentemente de neutralização de fórmula. */
export function escapeCsvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Uma linha CSV pronta para exportação: cada célula passa por
 *  neutralização de fórmula E DEPOIS por escaping RFC 4180 (nesta ordem —
 *  a aspa de neutralização faz parte do CONTEÚDO da célula, então precisa
 *  ser considerada pelo escaping, não o contrário). */
export function serializeCsvExportRow(cells: string[]): string {
  return cells.map((cell) => escapeCsvField(neutralizeForCsvExport(cell))).join(",");
}

/** Um arquivo CSV completo pronto para exportação (cabeçalho + linhas),
 *  com terminador CRLF (convenção do template de importação já existente).
 *  TODAS as células — cabeçalho incluso — passam pela mesma neutralização,
 *  porque um nome de campo ou um valor refletido também pode começar por um
 *  caractere perigoso (seção 3 da ordem v1.1: "aplicar neutralização em
 *  todas as células exportadas, incluindo valor original, mensagem, nome do
 *  campo e dados refletidos"). */
export function serializeCsvReport(headers: string[], rows: string[][]): string {
  const lines = [headers, ...rows].map((row) => serializeCsvExportRow(row));
  return lines.join("\r\n") + "\r\n";
}
