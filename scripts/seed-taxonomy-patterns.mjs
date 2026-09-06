// Sprint 17, seção E da ordem — artefato de conteúdo IDEMPOTENTE e
// AUDITÁVEL para a nova taxonomia de 20 padrões aprovada pelo PO/Andreia.
//
// NÃO É UMA MIGRATION: não toca schema, não roda `wrangler d1 execute`,
// não grava nada por SQL direto — chama exclusivamente a API REAL do
// Admin (POST /api/admin/patterns), a mesma superfície que uma pessoa
// usaria manualmente em /admin/padroes, autenticada por sessão real
// (cookie `md_session`). Isso preserva RBAC, auditoria (audit_log) e o
// contrato de idempotência do serviço (worker/src/services/
// patternsAdminService.ts) — nenhum atalho por fora da camada de negócio.
//
// IDEMPOTÊNCIA: faz upsert-por-NOME (chave natural aqui, já que `code`/
// `slug` agora são gerados pelo servidor e nunca previsíveis pelo
// cliente) — lista os padrões reais existentes primeiro, pula qualquer
// nome já cadastrado, cria só os que faltam. Rodar este script duas vezes
// seguidas produz 0 duplicatas na segunda vez (mesmo padrão de upsert já
// usado na Sprint 16 para os 12 padrões e as 12 atividades de cronograma).
//
// CONTEÚDO: os 20 NOMES abaixo são a taxonomia aprovada (ordem, seção E).
// Nenhum "Macete / Como resolver" é inventado aqui — cada padrão nasce
// como RASCUNHO só com o nome (createAdminPattern aceita isso desde a
// Sprint 17, seção A: "um rascunho pode existir apenas com o nome"); o
// preenchimento do macete e a publicação ficam pendentes de revisão da
// Andreia, exatamente como a ordem exige.
//
// ⚠️ NÃO EXECUTAR CONTRA PRODUÇÃO SEM AUTORIZAÇÃO EXPLÍCITA DO PO. Esta
// sprint (17) NÃO autoriza rodar este script — ela pede só que o
// mecanismo exista, preparado e auditável, para quando a reconciliação
// for decidida (ver seção F da ordem: "NÃO execute reconciliação na
// produção nesta etapa"). Quando autorizado, rodar assim:
//
//   MD_BASE_URL="https://matematica-delicada.proffandreia5.workers.dev" \
//   MD_SESSION_COOKIE="md_session=<token de uma sessão admin real>" \
//   node scripts/seed-taxonomy-patterns.mjs
//
// (Contra localhost/wrangler dev, use MD_BASE_URL="http://localhost:8787"
// ou a porta local real.) O script nunca lê/gera credenciais sozinho —
// espera um cookie de sessão JÁ autenticado, fornecido por quem executa.

const TAXONOMY_PATTERNS = [
  // Prioridade 1
  { priority: 1, name: "Conversão e padronização de unidades" },
  { priority: 1, name: "Razão, proporção e regra de três" },
  { priority: 1, name: "Escala" },
  { priority: 1, name: "Porcentagem direta" },
  { priority: 1, name: "Aumento e desconto percentual" },
  { priority: 1, name: "Interpretação de gráficos e tabelas" },
  { priority: 1, name: "Média aritmética e média ponderada" },
  { priority: 1, name: "Mediana, moda e frequência" },
  { priority: 1, name: "Probabilidade por interpretação" },
  { priority: 1, name: "Funções e modelagem" },
  { priority: 1, name: "Geometria espacial e cálculo de volume" },
  { priority: 1, name: "Notação científica" },
  // Prioridade 2
  { priority: 2, name: "Função afim" },
  { priority: 2, name: "Máximos e mínimos" },
  { priority: 2, name: "Sequências" },
  { priority: 2, name: "Frações e proporcionalidade" },
  { priority: 2, name: "Juros" },
  { priority: 2, name: "Análise combinatória" },
  { priority: 2, name: "Planificação de sólidos" },
  { priority: 2, name: "Projeção ortogonal" },
];

async function main() {
  const baseUrl = process.env.MD_BASE_URL;
  const cookie = process.env.MD_SESSION_COOKIE;
  if (!baseUrl || !cookie) {
    console.error("Defina MD_BASE_URL e MD_SESSION_COOKIE antes de rodar este script. Veja o comentário no topo do arquivo.");
    process.exitCode = 1;
    return;
  }

  const headers = { "Content-Type": "application/json", Cookie: cookie };

  const listResponse = await fetch(`${baseUrl}/api/admin/patterns`, { headers });
  if (!listResponse.ok) {
    throw new Error(`GET /api/admin/patterns falhou: ${listResponse.status} ${await listResponse.text()}`);
  }
  const { patterns: existing } = await listResponse.json();
  const existingNames = new Set(existing.map((p) => p.name));

  const created = [];
  const skipped = [];

  for (const { name } of TAXONOMY_PATTERNS) {
    if (existingNames.has(name)) {
      skipped.push(name);
      continue;
    }
    const mutationId = crypto.randomUUID();
    const response = await fetch(`${baseUrl}/api/admin/patterns`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name, mutationId }),
    });
    if (!response.ok) {
      throw new Error(`POST /api/admin/patterns (${name}) falhou: ${response.status} ${await response.text()}`);
    }
    const body = await response.json();
    created.push({ name, patternId: body.patternId, changed: body.changed });
  }

  console.log(`Criados: ${created.length}`);
  created.forEach((c) => console.log(`  + ${c.name} (${c.patternId})`));
  console.log(`Já existiam (pulados): ${skipped.length}`);
  skipped.forEach((name) => console.log(`  = ${name}`));
  console.log(`Total no catálogo alvo: ${TAXONOMY_PATTERNS.length}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
