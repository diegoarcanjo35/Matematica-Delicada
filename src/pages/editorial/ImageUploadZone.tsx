import { useRef, useState } from "react";
import { Button } from "../../components/Button";
import {
  deleteQuestionImage,
  questionMediaUrl,
  uploadQuestionImage,
  type QuestionImageDto,
} from "../../api/editorialClient";

/* Sprint 18, seção 14 da ordem — zona de upload de imagem reutilizada tanto
   para o enunciado quanto para cada alternativa A-E. A Andreia NUNCA digita
   asset_ref/URL/object key: só seleciona arquivo, arrasta/solta, ou cola
   (Ctrl+V) uma imagem copiada. Alt text é OBRIGATÓRIO no momento do envio
   (o contrato desta sprint só tem upload/delete dedicados — sem endpoint de
   edição de metadado; para corrigir o alt text depois, remove e reenvia). */

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
  const fileInputRef = useRef<HTMLInputElement>(null);

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
    try {
      await uploadQuestionImage(questionId, {
        file: pendingFile,
        mutationId: crypto.randomUUID(),
        placement,
        alternativeLetter: alternativeLetter ?? null,
        altText: altTextDraft.trim(),
      });
      setPendingFile(null);
      setAltTextDraft("");
      onChanged();
    } catch {
      setError("Não foi possível enviar a imagem. Tente novamente.");
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
              <img src={questionMediaUrl(image.id)} alt={image.altText} className="editorial__image-thumb" />
              <span className="editorial__image-alt">{image.altText}</span>
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
