/* Serviço do Bootstrap Administrativo Seguro — Sprint 15 v1.1 (adendo,
   seções D-L). Mecanismo one-shot, protegido por segredo independente do
   RBAC (nenhum admin existe ainda, por definição — adendo seção H), que
   promove EXATAMENTE duas contas JÁ EXISTENTES (identificadas por e-mail)
   ao papel `admin` já existente no schema (migration 0008), de forma
   atômica, idempotente e auditável, e se desativa permanentemente após o
   primeiro sucesso.

   DESENHO DO ONE-SHOT (adendo seções I/J — ver também o cabeçalho de
   migrations/0020_admin_user_management.sql): a tabela
   `admin_bootstrap_state` nasce SEMPRE VAZIA. A conclusão é um INSERT
   ÚNICO da linha `id = 'singleton'` (PRIMARY KEY) — nunca um UPDATE de
   status. Isso significa que a garantia de "nunca duas conclusões" NÃO
   depende de comparar `meta.changes` em JavaScript depois que um
   `db.batch()` já commitou (esse é exatamente o erro corrigido na Sprint
   11, documentado nas lições deste projeto) — depende de uma violação REAL
   de PRIMARY KEY, lançada pelo próprio SQLite/D1 DURANTE a execução do
   lote, que aborta a transação INTEIRA antes de qualquer commit parcial
   (rollback verdadeiro, garantido tanto pelo FakeD1Database de teste
   quanto pelo D1 real — https://developers.cloudflare.com/d1/worker-api/d1-database/#batch).
   Uma segunda execução concorrente perde a corrida de forma determinística
   e nunca promove ninguém, nunca duplica papel, nunca duplica auditoria —
   provado sob concorrência real em worker/testing/adminBootstrap.test.ts
   (mesmo padrão pauseReadsMatching/writeLock de
   worker/testing/weeklyReviewAtomicity.test.ts). As duas concessões de
   papel (INSERT OR IGNORE, id determinístico) e os três eventos de
   auditoria (PRIMARY KEY de audit_log, id determinístico a partir do
   mutationId) fazem parte do MESMO lote — ou tudo é persistido, ou nada é
   (adendo seção J). */

import { findUserByNormalizedEmail } from "../repositories/userRepository";
import { ensureRoleExists, findRoleByName } from "../repositories/roleRepository";
import { buildAuditEventStatement } from "../repositories/auditRepository";
import { validateBootstrapIdentifier } from "../lib/adminValidation";
import { isValidMutationId } from "../lib/questionsValidation";

const COMPLETED_BY = "admin_bootstrap_endpoint_v1";

export interface BootstrapAdminsInput {
  identifierA: unknown;
  identifierB: unknown;
  mutationId: unknown;
}

export type BootstrapAdminsResult =
  | { ok: true; alreadyCompleted: false; promotedUserIds: [string, string] }
  | { ok: true; alreadyCompleted: true }
  | { ok: false; reason: "invalid_input"; fieldErrors: Record<string, string> }
  | { ok: false; reason: "same_account" }
  | { ok: false; reason: "account_not_found"; fieldErrors: Record<string, string> }
  | { ok: false; reason: "conflict" };

interface BootstrapStateRow {
  id: string;
  promoted_user_id_1: string;
  promoted_user_id_2: string;
  mutation_id: string;
}

async function readBootstrapState(db: D1Database): Promise<BootstrapStateRow | null> {
  const row = await db.prepare(`SELECT * FROM admin_bootstrap_state WHERE id = 'singleton'`).first<BootstrapStateRow>();
  return row ?? null;
}

function isBootstrapStateUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message) && error.message.includes("admin_bootstrap_state");
}

function isAuditUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message) && error.message.includes("audit_log");
}

/** Executado SÓ depois que a rota já validou o segredo de bootstrap (ordem
 *  seção H — esta função nunca vê nem valida o segredo; isso é
 *  responsabilidade exclusiva de worker/src/routes/adminBootstrap.ts, para
 *  que o segredo nunca precise trafegar além da borda da requisição). */
export async function bootstrapAdmins(db: D1Database, input: BootstrapAdminsInput): Promise<BootstrapAdminsResult> {
  if (typeof input.mutationId !== "string" || !isValidMutationId(input.mutationId)) {
    return { ok: false, reason: "invalid_input", fieldErrors: { mutationId: "Identificador de mutação inválido." } };
  }
  const mutationId = input.mutationId;

  // Pré-checagem (otimização, NUNCA a garantia real — ver cabeçalho do
  // arquivo): evita todo o trabalho de validar e-mails/consultar contas
  // quando o bootstrap já está concluído, e responde de forma idêntica
  // tanto para um retry legítimo quanto para uma tentativa nova bloqueada
  // (adendo seção I: "qualquer nova tentativa deve resultar em recusa
  // determinística" — nunca revela se É especificamente um retry ou uma
  // tentativa de adicionar um terceiro admin).
  if (await readBootstrapState(db)) return { ok: true, alreadyCompleted: true };

  const idA = validateBootstrapIdentifier(input.identifierA);
  const idB = validateBootstrapIdentifier(input.identifierB);
  const fieldErrors: Record<string, string> = {};
  if (!idA.ok) fieldErrors.identifierA = idA.error;
  if (!idB.ok) fieldErrors.identifierB = idB.error;
  if (!idA.ok || !idB.ok) return { ok: false, reason: "invalid_input", fieldErrors };

  if (idA.emailNormalized === idB.emailNormalized) return { ok: false, reason: "same_account" };

  const [userA, userB] = await Promise.all([
    findUserByNormalizedEmail(db, idA.emailNormalized),
    findUserByNormalizedEmail(db, idB.emailNormalized),
  ]);
  const notFoundErrors: Record<string, string> = {};
  if (!userA) notFoundErrors.identifierA = "Conta não encontrada — o bootstrap só promove contas já cadastradas.";
  if (!userB) notFoundErrors.identifierB = "Conta não encontrada — o bootstrap só promove contas já cadastradas.";
  if (!userA || !userB) return { ok: false, reason: "account_not_found", fieldErrors: notFoundErrors };

  if (userA.id === userB.id) return { ok: false, reason: "same_account" };

  // Infraestrutura de RBAC (a linha `roles` para 'admin' pode ainda não
  // existir — mesmo raciocínio de worker/src/routes/dev.ts) — INSERT OR
  // IGNORE com id determinístico, nunca parte da invariante de
  // atomicidade das DUAS promoções (é só um pré-requisito estrutural,
  // seguro para rodar fora do lote).
  await ensureRoleExists(db, "role-admin", "admin");
  const roleRow = await findRoleByName(db, "admin");
  if (!roleRow) throw new Error("Falha estrutural: papel admin não pôde ser garantido.");

  const statements = [
    // Estatuto do one-shot (ver cabeçalho do arquivo) — INSERT simples
    // (NUNCA OR IGNORE): uma segunda tentativa concorrente colide com a
    // PRIMARY KEY 'singleton' e lança, abortando o lote inteiro.
    db
      .prepare(
        `INSERT INTO admin_bootstrap_state (id, completed_by, promoted_user_id_1, promoted_user_id_2, mutation_id)
         VALUES ('singleton', ?, ?, ?, ?)`
      )
      .bind(COMPLETED_BY, userA.id, userB.id, mutationId),
    db
      .prepare(`INSERT OR IGNORE INTO user_roles (id, user_id, role_id, granted_by) VALUES (?, ?, ?, NULL)`)
      .bind(`user-role-${userA.id}-${roleRow.id}`, userA.id, roleRow.id),
    db
      .prepare(`INSERT OR IGNORE INTO user_roles (id, user_id, role_id, granted_by) VALUES (?, ?, ?, NULL)`)
      .bind(`user-role-${userB.id}-${roleRow.id}`, userB.id, roleRow.id),
    buildAuditEventStatement(db, {
      id: `${mutationId}:role-a`,
      eventType: "admin_role_assigned",
      userId: null, // nenhum ator humano autenticado — concessão do próprio mecanismo de bootstrap
      metadata: { targetUserId: userA.id, role: "admin", mutationId },
    }),
    buildAuditEventStatement(db, {
      id: `${mutationId}:role-b`,
      eventType: "admin_role_assigned",
      userId: null,
      metadata: { targetUserId: userB.id, role: "admin", mutationId },
    }),
    buildAuditEventStatement(db, {
      id: mutationId,
      eventType: "admin_bootstrap_completed",
      userId: null,
      // Nunca inclui o segredo de bootstrap nem qualquer dado pessoal além
      // dos IDs internos já necessários para auditar QUAL conta foi
      // promovida (adendo seção L).
      metadata: { promotedUserId1: userA.id, promotedUserId2: userB.id, mutationId },
    }),
  ];

  try {
    await db.batch(statements);
  } catch (error) {
    if (isBootstrapStateUniqueViolation(error)) {
      // Corrida real perdida: outra execução concorrente concluiu o
      // bootstrap primeiro, entre a pré-checagem acima e este batch — a
      // ÚNICA garantia que realmente importa (adendo seção I/J), provada
      // em worker/testing/adminBootstrap.test.ts com pauseReadsMatching.
      // Nenhuma promoção, nenhum papel, nenhuma auditoria desta chamada
      // foi persistida (rollback completo do lote).
      return { ok: true, alreadyCompleted: true };
    }
    if (isAuditUniqueViolation(error)) {
      // mutationId reaproveitado de OUTRA operação (nunca deste próprio
      // bootstrap, que já teria sido pego pela pré-checagem) — conflito,
      // nenhuma promoção parcial persistida.
      return { ok: false, reason: "conflict" };
    }
    throw error;
  }

  return { ok: true, alreadyCompleted: false, promotedUserIds: [userA.id, userB.id] };
}
