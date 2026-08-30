// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error — script .mjs sem declaração de tipos, aceitável para um utilitário de build.
import { checkDeployableConfig } from "./check-deployable-d1-config.mjs";

/* Sprint 2 v1.2, correção 3.3 — os IDs/valores usados aqui existem só em
   arquivos temporários criados e destruídos pelo próprio teste (nunca
   gravados como configuração real do projeto). */

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), "md-deploy-config-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function writeFixture(content: object): string {
  const filePath = path.join(tempDir, "wrangler.test.jsonc");
  writeFileSync(filePath, JSON.stringify(content, null, 2), "utf8");
  return filePath;
}

const BASE_CONFIG = {
  name: "matematica-delicada-fixture",
  compatibility_date: "2025-01-01",
  main: "worker/src/index.ts",
};

describe("checkDeployableConfig", () => {
  it("database_id vazio -> bloqueia", () => {
    const filePath = writeFixture({
      ...BASE_CONFIG,
      d1_databases: [{ binding: "DB", database_name: "x", database_id: "" }],
    });
    const result = checkDeployableConfig(filePath);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e: string) => e.includes("database_id"))).toBe(true);
  });

  it("ID remoto formalmente válido e nenhuma flag dev -> permite", () => {
    const filePath = writeFixture({
      ...BASE_CONFIG,
      d1_databases: [
        { binding: "DB", database_name: "x", database_id: "a1b2c3d4-e5f6-4a5b-9c8d-1234567890ab" },
      ],
    });
    const result = checkDeployableConfig(filePath);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("ID válido com flag de outbox dev na config implantável -> bloqueia", () => {
    const filePath = writeFixture({
      ...BASE_CONFIG,
      vars: { DEV_OUTBOX_ENABLED: "true" },
      d1_databases: [
        { binding: "DB", database_name: "x", database_id: "a1b2c3d4-e5f6-4a5b-9c8d-1234567890ab" },
      ],
    });
    const result = checkDeployableConfig(filePath);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e: string) => e.includes("DEV_OUTBOX_ENABLED"))).toBe(true);
  });

  it("ID válido com flag de cookie inseguro na config implantável -> bloqueia", () => {
    const filePath = writeFixture({
      ...BASE_CONFIG,
      vars: { ALLOW_INSECURE_LOCAL_COOKIE: "true" },
      d1_databases: [
        { binding: "DB", database_name: "x", database_id: "a1b2c3d4-e5f6-4a5b-9c8d-1234567890ab" },
      ],
    });
    const result = checkDeployableConfig(filePath);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e: string) => e.includes("ALLOW_INSECURE_LOCAL_COOKIE"))).toBe(true);
  });

  it("ID válido com flag de isolamento de rate limit de teste na config implantável -> bloqueia", () => {
    const filePath = writeFixture({
      ...BASE_CONFIG,
      vars: { ALLOW_TEST_RATE_LIMIT_ISOLATION: "true" },
      d1_databases: [
        { binding: "DB", database_name: "x", database_id: "a1b2c3d4-e5f6-4a5b-9c8d-1234567890ab" },
      ],
    });
    const result = checkDeployableConfig(filePath);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e: string) => e.includes("ALLOW_TEST_RATE_LIMIT_ISOLATION"))).toBe(true);
  });

  it("ID válido com flag de fixtures de diagnóstico na config implantável -> bloqueia", () => {
    const filePath = writeFixture({
      ...BASE_CONFIG,
      vars: { ENABLE_LOCAL_DIAGNOSTIC_FIXTURES: "true" },
      d1_databases: [
        { binding: "DB", database_name: "x", database_id: "a1b2c3d4-e5f6-4a5b-9c8d-1234567890ab" },
      ],
    });
    const result = checkDeployableConfig(filePath);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e: string) => e.includes("ENABLE_LOCAL_DIAGNOSTIC_FIXTURES"))).toBe(true);
  });

  it("ID válido com flag de fixtures de cronograma na config implantável -> bloqueia", () => {
    const filePath = writeFixture({
      ...BASE_CONFIG,
      vars: { ENABLE_LOCAL_SCHEDULE_FIXTURES: "true" },
      d1_databases: [
        { binding: "DB", database_name: "x", database_id: "a1b2c3d4-e5f6-4a5b-9c8d-1234567890ab" },
      ],
    });
    const result = checkDeployableConfig(filePath);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e: string) => e.includes("ENABLE_LOCAL_SCHEDULE_FIXTURES"))).toBe(true);
  });

  it("database_id só com zeros -> bloqueia", () => {
    const filePath = writeFixture({
      ...BASE_CONFIG,
      d1_databases: [
        { binding: "DB", database_name: "x", database_id: "00000000-0000-0000-0000-000000000000" },
      ],
    });
    const result = checkDeployableConfig(filePath);
    expect(result.ok).toBe(false);
  });

  it("database_id com texto placeholder -> bloqueia", () => {
    const filePath = writeFixture({
      ...BASE_CONFIG,
      d1_databases: [{ binding: "DB", database_name: "x", database_id: "TODO-fill-me-in" }],
    });
    const result = checkDeployableConfig(filePath);
    expect(result.ok).toBe(false);
  });
});
