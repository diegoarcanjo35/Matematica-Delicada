import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorialImportsPage } from "./EditorialImportsPage";
import { EditorialRoleContext } from "../../auth/editorialRoleContext";

/* Sprint 19, seção 19 da ordem (itens 59-65 — frontend) — alternância
   CSV/ZIP, prévia visual por questão, thumbnails, revogação de Object
   URLs, reaproveitamento do File já selecionado no apply, orientação após
   reload sem File. Mesma convenção de mock de fetch global usada nos
   testes de EditorialQuestionFormPage/ImageUploadZone. */

const PREVIEW_RESPONSE = {
  ok: true,
  batchId: "batch-1",
  rowCount: 1,
  validRowCount: 1,
  imageCount: 2,
  errorCount: 0,
  questions: [
    {
      code: "ZIP-001",
      enunciadoPreview: "Enunciado de teste do pacote.",
      patternName: "Escala",
      status: "ready",
      images: [
        { imageId: "img-1", path: "imagens/enunciado.png", placement: "enunciado", alternativeLetter: null, altText: "Gráfico do enunciado" },
        { imageId: "img-2", path: "imagens/alt-c.png", placement: "alternativa", alternativeLetter: "C", altText: "Imagem da alternativa C" },
      ],
    },
  ],
  expiresAt: new Date(Date.now() + 1_800_000).toISOString(),
  canApply: true,
};

function buildZipFile(): File {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
  const zip = zipSync({
    "questoes.csv": new TextEncoder().encode("codigo,enunciado\nZIP-001,X\n"),
    "manifest.json": new TextEncoder().encode('{"version":1,"questions":[]}'),
    "imagens/enunciado.png": png,
    "imagens/alt-c.png": png,
  });
  return new File([zip], "pacote.zip", { type: "application/zip" });
}

function mockApi(previewBody: unknown = PREVIEW_RESPONSE) {
  const calls: Array<{ url: string; method: string }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (url.includes("/package/preview")) return new Response(JSON.stringify(previewBody), { status: 200 });
      if (url.includes("/package/apply")) return new Response(JSON.stringify({ ok: true, appliedCount: 1, imageCount: 2, alreadyApplied: false, questionIds: ["q-1"] }), { status: 200 });
      if (url.match(/\/undo$/)) return new Response(JSON.stringify({ ok: true, undoneCount: 1, alreadyUndone: false }), { status: 200 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    })
  );
  return calls;
}

function renderPage(role: "editor" | "admin" = "editor") {
  return render(
    <EditorialRoleContext.Provider value={role}>
      <EditorialImportsPage />
    </EditorialRoleContext.Provider>
  );
}

describe("EditorialImportsPage — Sprint 19 (itens 59-65)", () => {
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => `blob:mock-${Math.random()}`);
    URL.revokeObjectURL = vi.fn();
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("item 59 — alternância entre CSV e ZIP troca o painel exibido", async () => {
    mockApi();
    renderPage();
    expect(screen.getByLabelText("Pacote ZIP")).toBeInTheDocument();
    expect(screen.queryByLabelText("Arquivo CSV")).not.toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole("radio", { name: "CSV" }));
    expect(screen.getByLabelText("Arquivo CSV")).toBeInTheDocument();
    expect(screen.queryByLabelText("Pacote ZIP")).not.toBeInTheDocument();
  });

  it("item 60 — ZIP mostra prévia por questão (código, padrão, enunciado, contagem)", async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    const input = screen.getByLabelText("Pacote ZIP");
    await user.upload(input, buildZipFile());

    await waitFor(() => expect(screen.getByTestId("package-preview")).toBeInTheDocument());
    expect(screen.getByText("ZIP-001")).toBeInTheDocument();
    expect(screen.getByText(/Padrão: Escala/)).toBeInTheDocument();
    expect(screen.getByText("Enunciado de teste do pacote.")).toBeInTheDocument();
    expect(screen.getByText(/2 imagem/)).toBeInTheDocument();
  });

  it("item 61/62 — thumbnail do enunciado e da alternativa aparecem separadamente", async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    await user.upload(screen.getByLabelText("Pacote ZIP"), buildZipFile());

    await waitFor(() => expect(screen.getByTestId("package-question-list")).toBeInTheDocument());
    const thumbs = screen.getAllByRole("img");
    expect(thumbs).toHaveLength(2);
    expect(screen.getByText("Enunciado")).toBeInTheDocument();
    expect(screen.getByText("Alternativa C")).toBeInTheDocument();
  });

  it("item 63 — trocar de arquivo revoga os Object URLs antigos", async () => {
    mockApi();
    const user = userEvent.setup();
    renderPage();
    const input = screen.getByLabelText("Pacote ZIP");
    await user.upload(input, buildZipFile());
    await waitFor(() => expect(screen.getByTestId("package-preview")).toBeInTheDocument());
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();

    await user.upload(input, buildZipFile());
    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalled());
  });

  it("item 64 — aplicar reutiliza o File já selecionado, sem pedir nova seleção", async () => {
    const calls = mockApi();
    const user = userEvent.setup();
    renderPage();
    await user.upload(screen.getByLabelText("Pacote ZIP"), buildZipFile());
    await waitFor(() => expect(screen.getByTestId("package-preview")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Aplicar pacote" }));
    await waitFor(() => expect(screen.getByTestId("package-applied-result")).toBeInTheDocument());

    const applyCall = calls.find((c) => c.url.includes("/package/apply"));
    expect(applyCall).toBeDefined();
    expect(screen.getByText(/1 questão\(ões\) e 2 imagem\(ns\)/)).toBeInTheDocument();
  });

  it("estado inicial (nunca houve preview): nem prévia nem aviso de reload aparecem", async () => {
    mockApi();
    renderPage();
    expect(screen.queryByText(/selecione o pacote novamente/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId("package-preview")).not.toBeInTheDocument();
  });

  it("item 65 — reload com preview persistido mas sem File orienta gerar nova prévia, nunca tenta aplicar", async () => {
    // Simula exatamente o cenário do reload: um preview bem-sucedido de uma
    // montagem ANTERIOR deixou seu resumo em sessionStorage (nunca o File,
    // que não é serializável) — esta é uma montagem NOVA, sem nenhuma
    // seleção de arquivo.
    sessionStorage.setItem("editorial-package-preview-v1", JSON.stringify(PREVIEW_RESPONSE));
    mockApi();
    renderPage();

    expect(await screen.findByText(/selecione o pacote novamente/i)).toBeInTheDocument();
    // A prévia detalhada (com botão de aplicar) NUNCA aparece sem o File —
    // aplicar exigiria reenviar um arquivo que não existe mais em memória.
    expect(screen.queryByTestId("package-preview")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Aplicar pacote" })).not.toBeInTheDocument();
  });
});
