import { useRef, useState } from "react";
import { Button } from "../../components/Button";
import {
  deleteQuestionImage,
  localAssetUrl,
  questionMediaUrl,
  updateQuestionImageMetadata,
  uploadQuestionImage,
  type QuestionImageDto,
} from "../../api/editorialClient";
import { computePayloadSignature, isNetworkFailure, resolveMutationId, type MutationRetryState } from "./mutationId";

/* Sprint 18, seção 14 da ordem — zona de upload de imagem reutilizada tanto
   para o enunciado quanto para cada alternativa A-E. A Andreia NUNCA digita
   asset_ref/URL/object key: só seleciona arquivo, arrasta/solta, ou cola
   (Ctrl+V) uma imagem copiada.

   Sprint 18.1, seção B da correção — o alt text de uma imagem já enviada
   agora é editável in-line (endpoint PATCH dedicado de metadado); Andreia
   não precisa mais remover e reenviar a imagem só para corrigir a
   descrição — "Remover" continua uma ação separada.

   Sprint 18.1, seção C da correção — imagens locais legadas
   (`storageKind === 'local'`) e imagens novas via R2 (`storageKind ===
   'r2'`) usam URLs de exibição DIFERENTES (ver localAssetUrl/
   questionMediaUrl em editorialClient.ts); a rota /api/question-media
   nunca serve um asset local (404).

   Sprint 18.2, seção 2 da correção — o retry forte do backend (mutationId +
   hash de conteúdo, ver questionMediaService.ts) só tem efeito prático se o
   CLIENTE reaproveitar o mesmo mutationId ao reenviar a MESMA tentativa
   depois de uma falha de rede — gerar um UUID novo a cada clique (como
   antes) invalidava essa proteção na prática: um retry legítimo do usuário
   sempre parecia uma operação NOVA para o servidor. Mesma disciplina já
   usada pelo PATCH geral da questão (ver mutationId.ts/
   EditorialQuestionFormPage.tsx): guarda-se a ASSINATURA da última
   tentativa; reaproveita o mesmo mutationId só se a tentativa atual for
   idêntica; qualquer mudança de conteúdo gera um mutationId novo; uma
   resposta HTTP conhecida (sucesso OU erro 4xx/409 — o servidor decidiu
   algo sobre aquela tentativa específica) sempre limpa o estado de retry. */

function imageSrc(image: QuestionImageDto): string {
  return image.storageKind === "r2" ? questionMediaUrl(image.id) : localAssetUrl(image.assetRef);
}

interface Props {
  questionId: string;
  placement: "enunciado" | "alternativa";
  alternativeLetter?: string;
  images: QuestionImageDto[];
  onChanged: () => void;
}

const ACCEPTED_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"];

export function ImageUploadZone({ questionId, placement, alternativeLetter, images, onChanged }: Props) {
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [altTextDraft, setAltTextDraft] = useState("");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [editingAltId, setEditingAltId] = useState<string | null>(null);
  const [editingAltDraft, setEditingAltDraft] = useState("");
  const [savingAltId, setSavingAltId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadRetryState = useRef<MutationRetryState | null>(null);
  const altRetryState = useRef<MutationRetryState | null>(null);

  function startEditingAlt(image: QuestionImageDto) {
    setEditingAltId(image.id);
    setEditingAltDraft(image.altText);
  }

  async function handleSaveAlt(imageId: string) {
    const altText = editingAltDraft.trim();
    if (altText.length === 0) return;
    setSavingAltId(imageId);

    const payloadSignature = computePayloadSignature({ imageId, altText, caption: null });
    const mutationId = resolveMutationId(altRetryState.current, payloadSignature);

    try {
      await updateQuestionImageMetadata(questionId, imageId, { mutationId, altText });
      altRetryState.current = null;
      setEditingAltId(null);
      onChanged();
    } catch (err) {
      setError("Não foi possível salvar o texto alternativo. Tente novamente.");
      altRetryState.current = isNetworkFailure(err) ? { mutationId, payloadSignature } : null;
    } finally {
      setSavingAltId(null);
    }
  }

  function acceptFile(file: File) {
    setError(null);
    if (!ACCEPTED_MIME_TYPES.includes(file.type)) {
      setError("Formato não aceito. Envie PNG, JPEG ou WebP.");
      return;
    }
    setPendingFile(file);
  }

  function handleFileInput(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) acceptFile(file);
    event.target.value = "";
  }

  function handleDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragOver(false);
    const file = event.dataTransfer.files?.[0];
    if (file) acceptFile(file);
  }

  function handlePaste(event: React.ClipboardEvent<HTMLDivElement>) {
    const item = Array.from(event.clipboardData.items).find((entry) => entry.type.startsWith("image/"));
    const file = item?.getAsFile();
    if (file) acceptFile(file);
  }

  async function handleConfirmUpload() {
    if (!pendingFile || altTextDraft.trim().length === 0) {
      setError("Descreva o texto alternativo antes de enviar.");
      return;
    }
    setUploading(true);
    setError(null);

    const altText = altTextDraft.trim();
    // Assinatura da tentativa: identidade prática do arquivo (nome/tamanho/
    // data de modificação/tipo — o hash de conteúdo forte de verdade é
    // responsabilidade do backend, ver questionMediaService.ts) + os demais
    // campos do formulário. Reenviar exatamente isto depois de uma falha de
    // rede reaproveita o MESMO mutationId; qualquer mudança gera um novo.
    const payloadSignature = computePayloadSignature({
      fileName: pendingFile.name,
      fileSize: pendingFile.size,
      fileLastModified: pendingFile.lastModified,
      fileType: pendingFile.type,
      altText,
      placement,
      alternativeLetter: alternativeLetter ?? null,
    });
    const mutationId = resolveMutationId(uploadRetryState.current, payloadSignature);

    try {
      await uploadQuestionImage(questionId, {
        file: pendingFile,
        mutationId,
        placement,
        alternativeLetter: alternativeLetter ?? null,
        altText,
      });
      uploadRetryState.current = null;
      setPendingFile(null);
      setAltTextDraft("");
      onChanged();
    } catch (err) {
      setError("Não foi possível enviar a imagem. Tente novamente.");
      uploadRetryState.current = isNetworkFailure(err) ? { mutationId, payloadSignature } : null;
    } finally {
      setUploading(false);
    }
  }

  async function handleRemove(imageId: string) {
    setDeletingId(imageId);
    try {
      await deleteQuestionImage(questionId, imageId);
      onChanged();
    } finally {
      setDeletingId(null);
    }
  }

  const label = placement === "enunciado" ? "Adicionar imagem ao enunciado" : `Adicionar imagem à alternativa ${alternativeLetter}`;

  return (
    <div className="editorial__image-zone">
      {images.length > 0 && (
        <ul className="editorial__image-list">
          {images.map((image) => (
            <li key={image.id} className="editorial__image-item">
              <img src={imageSrc(image)} alt={image.altText} className="editorial__image-thumb" />
              {editingAltId === image.id ? (
                <div className="editorial__field">
                  <label htmlFor={`alt-edit-${image.id}`}>Texto alternativo</label>
                  <input id={`alt-edit-${image.id}`} value={editingAltDraft} onChange={(e) => setEditingAltDraft(e.target.value)} />
                  <div className="editorial__actions">
                    <Button type="button" onClick={() => void handleSaveAlt(image.id)} isLoading={savingAltId === image.id}>
                      Salvar
                    </Button>
                    <Button type="button" variant="secondary" onClick={() => setEditingAltId(null)} disabled={savingAltId === image.id}>
                      Cancelar
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <span className="editorial__image-alt">{image.altText}</span>
                  <Button type="button" variant="secondary" onClick={() => startEditingAlt(image)}>
                    Editar descrição
                  </Button>
                </>
              )}
              <Button type="button" variant="secondary" onClick={() => void handleRemove(image.id)} isLoading={deletingId === image.id}>
                Remover
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div
        className={`editorial__dropzone${dragOver ? " editorial__dropzone--active" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onPaste={handlePaste}
        tabIndex={0}
        role="button"
        aria-label={label}
      >
        <p>{label}</p>
        <p className="editorial__dropzone-hint">Arraste e solte, cole (Ctrl+V) ou</p>
        <Button type="button" variant="secondary" onClick={() => fileInputRef.current?.click()}>
          Selecionar arquivo
        </Button>
        <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={handleFileInput} />
      </div>

      {pendingFile && (
        <div className="editorial__image-pending">
          <p>Arquivo selecionado: {pendingFile.name}</p>
          <div className="editorial__field">
            <label htmlFor={`alt-draft-${placement}-${alternativeLetter ?? "enunciado"}`}>Texto alternativo (obrigatório)</label>
            <input
              id={`alt-draft-${placement}-${alternativeLetter ?? "enunciado"}`}
              value={altTextDraft}
              onChange={(e) => setAltTextDraft(e.target.value)}
              placeholder="Descreva o que a imagem mostra"
            />
          </div>
          <div className="editorial__actions">
            <Button type="button" onClick={() => void handleConfirmUpload()} isLoading={uploading}>
              Enviar imagem
            </Button>
            <Button type="button" variant="secondary" onClick={() => setPendingFile(null)} disabled={uploading}>
              Cancelar
            </Button>
          </div>
        </div>
      )}

      {error && <p className="editorial__field-error">{error}</p>}
    </div>
  );
}
