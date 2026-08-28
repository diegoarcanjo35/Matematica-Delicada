// Benchmark local reprodutível do PBKDF2-HMAC-SHA256 — Sprint 2 v1.1, correção B.
// Roda em Node (Web Crypto nativo), mesma primitiva usada no Worker (SubtleCrypto).
// Uso: node worker/scripts/benchmark-pbkdf2.mjs [iteracoes] [amostras]

const iterations = Number(process.argv[2] ?? 600_000);
const samples = Number(process.argv[3] ?? 15);

async function hashOnce() {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("senha-de-teste-para-benchmark-123"),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const start = performance.now();
  await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return performance.now() - start;
}

const times = [];
for (let i = 0; i < samples; i++) {
  times.push(await hashOnce());
}
times.sort((a, b) => a - b);
const median = times[Math.floor(times.length / 2)];
const min = times[0];
const max = times[times.length - 1];
const mean = times.reduce((a, b) => a + b, 0) / times.length;

console.log(`PBKDF2-HMAC-SHA256, ${iterations} iterações, ${samples} amostras`);
console.log(`Amostras (ms): ${times.map((t) => t.toFixed(1)).join(", ")}`);
console.log(`Mediana: ${median.toFixed(1)}ms | Média: ${mean.toFixed(1)}ms | Min: ${min.toFixed(1)}ms | Max: ${max.toFixed(1)}ms`);
