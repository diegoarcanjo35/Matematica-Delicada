import { useCallback, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { ErrorState } from "../../components/ErrorState";
import { startAttempt, PlayerApiError, type AttemptMode } from "../../api/playerClient";
import "./PlayerPage.css";

/* Tela "antes/início" — /questoes/:questionId (Sprint 8 v1.1, seção 12 da
   ordem).

   Deliberadamente GENÉRICA (título/objetivo/estimativa fixos, sem enunciado
   real): a lista de 9 endpoints da ordem (seção 11) não inclui um GET de
   detalhe de questão fora de uma tentativa — o conteúdo real só é revelado
   depois do POST /api/player/attempts, ao navegar para /tentativas/:id.
   Documentado em docs/PLAYER_QUESTAO.md, "Nota de desenho". */

const MODE_OPTIONS: Array<{ value: AttemptMode; label: string; description: string }> = [
  {
    value: "learning",
    label: "Aprendizagem",
    description: "Sem pressa — ajuda progressiva disponível a qualquer momento, feedback completo ao confirmar.",
  },
  {
    value: "practice",
    label: "Prática",
    description: "Responda como faria numa prova — a ajuda continua disponível se precisar.",
  },
  {
    value: "recognition",
    label: "Reconhecimento",
    description: "Antes de ver as alternativas, identifique o padrão, a pista e a estratégia — o padrão fica oculto até você registrar sua resposta.",
  },
];

export function QuestionStartPage() {
  const { questionId } = useParams<{ questionId: string }>();
  const navigate = useNavigate();
  const [mode, setMode] = useState<AttemptMode>("learning");
  const [phase, setPhase] = useState<"ready" | "starting" | "unavailable" | "notFound" | "error">("ready");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const handleStart = useCallback(async () => {
    if (!questionId) return;
    setPhase("starting");
    setErrorMessage(null);
    try {
      const result = await startAttempt(questionId, mode);
      // O sucesso NUNCA inclui `available` (mesma convenção de
      // diagnosticService.ts:createAttempt) — só o gate fechado devolve
      // `available: false` explicitamente. Checar `=== false`, nunca `!`,
      // porque `undefined` (ausência do campo) É sucesso, não indisponível.
      if (result.available === false) {
        setPhase("unavailable");
        return;
      }
      if (!result.attemptId) {
        setPhase("error");
        return;
      }
      navigate(`/tentativas/${result.attemptId}`);
    } catch (error) {
      if (error instanceof PlayerApiError && error.status === 404) {
        setPhase("notFound");
        return;
      }
      setErrorMessage("Não foi possível iniciar a tentativa. Tente novamente.");
      setPhase("error");
    }
  }, [questionId, mode, navigate]);

  if (phase === "unavailable") {
    return (
      <div className="player player--centered">
        <Card className="player__card">
          <h1 ref={headingRef} tabIndex={-1}>
            Ainda não há questões disponíveis
          </h1>
          <p>O Player de Questão já está pronto tecnicamente, mas nenhuma questão está disponível para praticar neste ambiente agora.</p>
        </Card>
      </div>
    );
  }

  if (phase === "notFound") {
    return (
      <div className="player player--centered">
        <Card className="player__card">
          <h1 ref={headingRef} tabIndex={-1}>
            Questão não encontrada
          </h1>
          <p>Esta questão não existe ou ainda não está publicada.</p>
        </Card>
      </div>
    );
  }

  if (phase === "error") {
    return (
      <ErrorState description={errorMessage ?? "Não foi possível iniciar a tentativa."} action={<Button onClick={handleStart}>Tentar novamente</Button>} />
    );
  }

  return (
    <div className="player">
      <Card className="player__card">
        <h1 ref={headingRef} tabIndex={-1}>
          Resolver questão
        </h1>
        <p className="player__objective">
          Objetivo: praticar a identificação e a resolução de um padrão recorrente do ENEM, com
          ajuda progressiva disponível a qualquer momento.
        </p>
        <p className="player__estimate">Tempo estimado: alguns minutos, sem pressão de cronômetro.</p>

        <fieldset className="player__fieldset">
          <legend className="player__legend">Escolha o modo</legend>
          <div className="player__option-group">
            {MODE_OPTIONS.map((option) => (
              <label key={option.value} className="player__option">
                <input
                  type="radio"
                  name="mode"
                  value={option.value}
                  checked={mode === option.value}
                  onChange={() => setMode(option.value)}
                />
                <span>
                  <strong>{option.label}</strong>
                  <span className="player__option-description">{option.description}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <Button type="button" onClick={() => void handleStart()} isLoading={phase === "starting"}>
          Iniciar
        </Button>
      </Card>
    </div>
  );
}
