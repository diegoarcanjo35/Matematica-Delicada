// Sprint 2 v1.1/v1.2 — bloqueia deploy enquanto o database_id real não tiver
// sido fornecido, E enquanto qualquer flag de desenvolvimento local (outbox
// dev, cookie inseguro, etc.) estiver presente na config implantável. Roda
// automaticamente como "predeploy" (mecanismo nativo do npm) antes de
// qualquer `npm run deploy`.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_CONFIG_PATH = path.join(rootDir, "wrangler.jsonc");

// Sprint 2 v1.2, correção 3.3 — nenhuma dessas variáveis pode existir em
// "vars" da config implantável. São exclusivas de wrangler.local.jsonc.
const FORBIDDEN_DEV_VAR_NAMES = ["DEV_OUTBOX_ENABLED", "ALLOW_INSECURE_LOCAL_COOKIE"];

export function stripJsonComments(text) {
  // wrangler.jsonc permite comentários // e /* */ — remoção simples o
  // suficiente para este arquivo controlado (sem strings contendo "//").
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

export function isPlaceholderOrInvalid(databaseId) {
  if (typeof databaseId !== "string") return true;
  const trimmed = databaseId.trim();
  if (trimmed.length === 0) return true;
  if (/^0+$/.test(trimmed.replace(/-/g, ""))) return true; // todos zeros, com ou sem hífens
  if (/todo|placeholder|changeme|fixme|xxxx/i.test(trimmed)) return true;
  return false;
}

/** @returns {{ ok: boolean, errors: string[] }} */
export function checkDeployableConfig(configPath = DEFAULT_CONFIG_PATH) {
  const raw = readFileSync(configPath, "utf8");
  const config = JSON.parse(stripJsonComments(raw));
  const fileName = path.basename(configPath);
  const errors = [];

  const d1Databases = config.d1_databases ?? [];
  if (d1Databases.length === 0) {
    errors.push(`${fileName} não tem nenhum binding d1_databases configurado.`);
  } else {
    for (const db of d1Databases) {
      if (isPlaceholderOrInvalid(db.database_id)) {
        errors.push(
          `${fileName}: database_id do binding "${db.binding}" está vazio ou é um ` +
            `valor inválido/placeholder ("${db.database_id}"). Não é permitido implantar ` +
            `sem o database_id REAL do D1 remoto, criado manualmente por Diego e autorizado pelo PO.`
        );
      }
    }
  }

  const vars = config.vars ?? {};
  for (const forbiddenName of FORBIDDEN_DEV_VAR_NAMES) {
    if (Object.prototype.hasOwnProperty.call(vars, forbiddenName)) {
      errors.push(
        `${fileName}: contém a variável "${forbiddenName}", exclusiva de desenvolvimento local. ` +
          `Isso nunca pode ir para uma configuração implantável — remova de ${fileName} ` +
          `(ela deve existir só em wrangler.local.jsonc).`
      );
    }
  }

  return { ok: errors.length === 0, errors };
}

function main() {
  const { ok, errors } = checkDeployableConfig();
  const fileName = path.basename(DEFAULT_CONFIG_PATH);

  if (!ok) {
    for (const error of errors) console.error(`✖ ${error}`);
    console.error("\nDeploy bloqueado. Ver docs/AUTENTICACAO.md e README.md.");
    process.exit(1);
  }

  console.log(`✓ ${fileName}: database_id válido e nenhuma flag de desenvolvimento presente.`);
}

// Só roda main() quando executado diretamente (não quando importado por
// testes) — comparação por caminho resolvido, não por string de URL crua,
// para não quebrar no Windows (drive letter, barras, espaços no caminho).
const isDirectExecution =
  process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (isDirectExecution) {
  main();
}
