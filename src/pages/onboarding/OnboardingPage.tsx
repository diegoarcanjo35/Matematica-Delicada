import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { Alert } from "../../components/Alert";
import { LoadingState } from "../../components/LoadingState";
import { ProgressBar } from "../../components/ProgressBar";
import { useAuth } from "../../auth/useAuth";
import { useOnboardingStatus } from "../../onboarding/useOnboardingStatus";
import {
  completeOnboarding,
  fetchOnboarding,
  saveOnboardingProgress,
  OnboardingApiError,
  type OnboardingPatch,
  type OnboardingProfile,
} from "../../api/onboardingClient";
import {
  DAILY_MINUTES_MAX,
  DAILY_MINUTES_MIN,
  DIFFICULTIES_MAX_ITEMS,
  DIFFICULTY_TEXT_MAX_LENGTH,
  ENEM_MATH_QUESTION_COUNT,
  GOAL_SCORE_MAX,
  GOAL_SCORE_MIN,
  GOAL_TYPE_OPTIONS,
  GRADE_OPTIONS,
  STEP_COUNT,
  STEP_TITLES,
  TIME_PREFERENCE_OPTIONS,
  WEEKDAY_OPTIONS,
} from "./onboardingOptions";
import "./OnboardingPage.css";

interface Answers {
  currentGrade: string;
  enemYear: string;
  goalType: string;
  goalValue: string;
  currentCorrectEstimate: string;
  availableDays: string[];
  dailyMinutes: string;
  difficulties: string[];
  timePreference: string;
  accessibilityNeeds: string;
  diagnosticChoice: string;
}

const EMPTY_ANSWERS: Answers = {
  currentGrade: "",
  enemYear: "",
  goalType: "",
  goalValue: "",
  currentCorrectEstimate: "",
  availableDays: [],
  dailyMinutes: "",
  difficulties: [],
  timePreference: "",
  accessibilityNeeds: "",
  diagnosticChoice: "",
};

type SaveState = "idle" | "saving" | "saved" | "error";

function profileToAnswers(profile: OnboardingProfile): Answers {
  return {
    currentGrade: profile.currentGrade ?? "",
    enemYear: profile.enemYear != null ? String(profile.enemYear) : "",
    goalType: profile.goalType ?? "",
    goalValue: profile.goalValue != null ? String(profile.goalValue) : "",
    currentCorrectEstimate:
      profile.currentCorrectEstimate != null ? String(profile.currentCorrectEstimate) : "",
    availableDays: profile.availableDays ?? [],
    dailyMinutes: profile.dailyMinutes != null ? String(profile.dailyMinutes) : "",
    difficulties: profile.difficulties ?? [],
    timePreference: profile.timePreference ?? "",
    accessibilityNeeds: profile.accessibilityNeeds ?? "",
    diagnosticChoice: profile.diagnosticChoice ?? "",
  };
}

/** Só os campos da etapa atual — a API valida e salva parcialmente, então
 *  nunca reenviamos etapas ainda não respondidas (evita erro de validação em
 *  campo que o aluno ainda não viu). */
function buildPatchForStep(step: number, answers: Answers): OnboardingPatch {
  const patch: OnboardingPatch = { currentStep: step };
  if (step === 1) {
    if (answers.currentGrade) patch.currentGrade = answers.currentGrade;
    if (answers.enemYear) patch.enemYear = Number(answers.enemYear);
  }
  if (step === 2) {
    if (answers.goalType) patch.goalType = answers.goalType as "acertos" | "nota";
    if (answers.goalValue) patch.goalValue = Number(answers.goalValue);
    patch.currentCorrectEstimate =
      answers.currentCorrectEstimate === "" ? null : Number(answers.currentCorrectEstimate);
  }
  if (step === 3) {
    if (answers.availableDays.length > 0) patch.availableDays = answers.availableDays;
    if (answers.dailyMinutes) patch.dailyMinutes = Number(answers.dailyMinutes);
  }
  if (step === 4) {
    patch.difficulties = answers.difficulties;
  }
  if (step === 5) {
    if (answers.timePreference) patch.timePreference = answers.timePreference;
    patch.accessibilityNeeds = answers.accessibilityNeeds.trim() === "" ? null : answers.accessibilityNeeds.trim();
  }
  if (step === 6) {
    if (answers.diagnosticChoice) patch.diagnosticChoice = answers.diagnosticChoice as "agora" | "depois";
  }
  return patch;
}

function validateStepClientSide(step: number, answers: Answers): string | null {
  if (step === 1) {
    if (!answers.currentGrade) return "Selecione sua série atual.";
    if (!answers.enemYear) return "Informe o ano em que fará o ENEM.";
  }
  if (step === 2) {
    if (!answers.goalType) return "Escolha o tipo de meta.";
    if (!answers.goalValue) return "Informe o valor da meta.";
  }
  if (step === 3) {
    if (answers.availableDays.length === 0) return "Selecione ao menos um dia disponível.";
    if (!answers.dailyMinutes) return "Informe os minutos disponíveis por dia.";
  }
  if (step === 5) {
    if (!answers.timePreference) return "Selecione sua preferência de horário.";
  }
  if (step === 6) {
    if (!answers.diagnosticChoice) return 'Escolha "agora" ou "depois" para o diagnóstico.';
  }
  return null;
}

export function OnboardingPage() {
  const navigate = useNavigate();
  const { logout } = useAuth();
  const { refresh: refreshOnboardingStatus } = useOnboardingStatus();

  const [loading, setLoading] = useState(true);
  const [step, setStep] = useState(1);
  const [answers, setAnswers] = useState<Answers>(EMPTY_ANSWERS);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [stepError, setStepError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [isCompleting, setIsCompleting] = useState(false);
  const isNavigatingRef = useRef(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await fetchOnboarding();
        if (cancelled) return;
        if (result.profile.status === "completed") {
          // Acesso direto ao onboarding já concluído — decisão documentada
          // (Sprint 3, seção 10): redireciona ao dashboard em vez de reabrir
          // o formulário. Edição de preferências fica em Configurações.
          navigate("/", { replace: true });
          return;
        }
        setAnswers(profileToAnswers(result.profile));
        setStep(Math.min(Math.max(result.profile.currentStep, 1), STEP_COUNT));
      } catch {
        // Sem perfil ainda — começa do zero, silenciosamente.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  useEffect(() => {
    if (!loading) headingRef.current?.focus();
  }, [step, loading]);

  const progressPercent = useMemo(() => Math.round(((step - 1) / STEP_COUNT) * 100), [step]);

  const persistStep = useCallback(
    async (targetStep: number): Promise<boolean> => {
      setSaveState("saving");
      setFieldErrors({});
      try {
        const patch = buildPatchForStep(step, answers);
        patch.currentStep = targetStep;
        const result = await saveOnboardingProgress(patch);
        setAnswers(profileToAnswers(result.profile));
        setSaveState("saved");
        return true;
      } catch (error) {
        setSaveState("error");
        if (error instanceof OnboardingApiError) {
          setFieldErrors(error.fields);
        }
        return false;
      }
    },
    [step, answers]
  );

  async function handleNext() {
    if (isNavigatingRef.current) return;
    const clientError = validateStepClientSide(step, answers);
    setStepError(clientError);
    if (clientError) return;

    isNavigatingRef.current = true;
    const nextStep = Math.min(step + 1, STEP_COUNT);
    const saved = await persistStep(nextStep);
    isNavigatingRef.current = false;
    if (saved) {
      setStepError(null);
      setStep(nextStep);
    }
  }

  async function handleBack() {
    if (isNavigatingRef.current || step === 1) return;
    setStepError(null);
    setFieldErrors({});
    // Volta sem exigir validação — o aluno não pode perder o que já digitou,
    // mas também não é obrigado a corrigir a etapa atual só para recuar.
    const previousStep = step - 1;
    await persistStep(previousStep).catch(() => undefined);
    setStep(previousStep);
  }

  function goToStep(target: number) {
    setStepError(null);
    setFieldErrors({});
    setStep(target);
  }

  async function handleComplete() {
    if (isCompleting) return;
    setIsCompleting(true);
    setStepError(null);
    try {
      const saved = await persistStep(STEP_COUNT);
      if (!saved) return;
      const result = await completeOnboarding();
      // O OnboardingStatusProvider (compartilhado com RequireOnboardingComplete)
      // buscou o status uma única vez, na montagem — sem atualizar aqui, o
      // guard ainda veria "incompleto" e devolveria o aluno para /onboarding
      // assim que a navegação abaixo tentasse entrar na área gated.
      await refreshOnboardingStatus();
      if (result.profile.diagnosticChoice === "agora") {
        navigate("/diagnostico", { replace: true });
      } else {
        navigate("/", { replace: true });
      }
    } catch (error) {
      if (error instanceof OnboardingApiError) {
        setFieldErrors(error.fields);
        setStepError("Existem respostas obrigatórias pendentes. Revise as etapas indicadas.");
      } else {
        setStepError("Não foi possível concluir o onboarding. Tente novamente.");
      }
    } finally {
      setIsCompleting(false);
    }
  }

  async function handleLogout() {
    await logout();
    navigate("/entrar", { replace: true });
  }

  function toggleWeekday(value: string) {
    setAnswers((prev) => ({
      ...prev,
      availableDays: prev.availableDays.includes(value)
        ? prev.availableDays.filter((day) => day !== value)
        : [...prev.availableDays, value],
    }));
  }

  const [difficultyDraft, setDifficultyDraft] = useState("");
  function addDifficulty() {
    const value = difficultyDraft.trim();
    if (!value) return;
    if (value.length > DIFFICULTY_TEXT_MAX_LENGTH) return;
    if (answers.difficulties.length >= DIFFICULTIES_MAX_ITEMS) return;
    if (answers.difficulties.includes(value)) return;
    setAnswers((prev) => ({ ...prev, difficulties: [...prev.difficulties, value] }));
    setDifficultyDraft("");
  }
  function removeDifficulty(value: string) {
    setAnswers((prev) => ({ ...prev, difficulties: prev.difficulties.filter((item) => item !== value) }));
  }

  if (loading) {
    return <LoadingState label="Carregando seu onboarding…" />;
  }

  return (
    <div className="onboarding">
      <header className="onboarding__header">
        <span className="onboarding__brand">Matemática Delicada</span>
        <button type="button" className="onboarding__logout" onClick={handleLogout}>
          Sair
        </button>
      </header>

      <div className="onboarding__body">
        <Card className="onboarding__card">
          <div className="onboarding__progress">
            <ProgressBar label={`Etapa ${step} de ${STEP_COUNT}`} value={progressPercent} />
            <p className="onboarding__progress-text" aria-hidden="true">
              Etapa {step} de {STEP_COUNT} — {STEP_TITLES[step - 1]}
            </p>
          </div>

          <h1 className="onboarding__step-title" ref={headingRef} tabIndex={-1}>
            {STEP_TITLES[step - 1]}
          </h1>

          <div
            className={`onboarding__save-indicator onboarding__save-indicator--${saveState}`}
            role="status"
            aria-live="polite"
          >
            {saveState === "saving" && "Salvando…"}
            {saveState === "saved" && "Salvo"}
            {saveState === "error" && "Não foi possível salvar. Tente novamente."}
          </div>

          {stepError && (
            <div className="onboarding__alert">
              <Alert variant="error">{stepError}</Alert>
            </div>
          )}

          {step === 1 && (
            <fieldset className="onboarding__fieldset">
              <legend className="onboarding__legend">Sua série e o ano do ENEM</legend>
              <div className="onboarding__field">
                <label htmlFor="onboarding-grade">Série atual</label>
                <select
                  id="onboarding-grade"
                  value={answers.currentGrade}
                  onChange={(event) => setAnswers((prev) => ({ ...prev, currentGrade: event.target.value }))}
                >
                  <option value="">Selecione…</option>
                  {GRADE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                {fieldErrors.currentGrade && (
                  <p className="onboarding__field-error" role="alert">
                    {fieldErrors.currentGrade}
                  </p>
                )}
              </div>
              <div className="onboarding__field">
                <label htmlFor="onboarding-enem-year">Ano em que fará o ENEM</label>
                <input
                  id="onboarding-enem-year"
                  type="number"
                  inputMode="numeric"
                  value={answers.enemYear}
                  onChange={(event) => setAnswers((prev) => ({ ...prev, enemYear: event.target.value }))}
                />
                {fieldErrors.enemYear && (
                  <p className="onboarding__field-error" role="alert">
                    {fieldErrors.enemYear}
                  </p>
                )}
              </div>
            </fieldset>
          )}

          {step === 2 && (
            <fieldset className="onboarding__fieldset">
              <legend className="onboarding__legend">Sua meta</legend>
              <div className="onboarding__field">
                <span className="onboarding__field-label">Tipo de meta</span>
                <div className="onboarding__radio-group">
                  {GOAL_TYPE_OPTIONS.map((option) => (
                    <label key={option.value} className="onboarding__radio">
                      <input
                        type="radio"
                        name="goalType"
                        value={option.value}
                        checked={answers.goalType === option.value}
                        onChange={() => setAnswers((prev) => ({ ...prev, goalType: option.value, goalValue: "" }))}
                      />
                      {option.label}
                    </label>
                  ))}
                </div>
                {fieldErrors.goalType && (
                  <p className="onboarding__field-error" role="alert">
                    {fieldErrors.goalType}
                  </p>
                )}
              </div>
              {answers.goalType && (
                <div className="onboarding__field">
                  <label htmlFor="onboarding-goal-value">
                    {answers.goalType === "acertos"
                      ? `Meta de acertos (0 a ${ENEM_MATH_QUESTION_COUNT})`
                      : `Meta de nota (${GOAL_SCORE_MIN} a ${GOAL_SCORE_MAX})`}
                  </label>
                  <input
                    id="onboarding-goal-value"
                    type="number"
                    inputMode="numeric"
                    value={answers.goalValue}
                    onChange={(event) => setAnswers((prev) => ({ ...prev, goalValue: event.target.value }))}
                  />
                  <p className="onboarding__help">
                    Isso é uma meta para orientar seu percurso, não uma projeção garantida.
                  </p>
                  {fieldErrors.goalValue && (
                    <p className="onboarding__field-error" role="alert">
                      {fieldErrors.goalValue}
                    </p>
                  )}
                </div>
              )}
              <div className="onboarding__field">
                <label htmlFor="onboarding-current-correct">
                  Quantidade atual aproximada de acertos (opcional)
                </label>
                <input
                  id="onboarding-current-correct"
                  type="number"
                  inputMode="numeric"
                  value={answers.currentCorrectEstimate}
                  onChange={(event) =>
                    setAnswers((prev) => ({ ...prev, currentCorrectEstimate: event.target.value }))
                  }
                />
                {fieldErrors.currentCorrectEstimate && (
                  <p className="onboarding__field-error" role="alert">
                    {fieldErrors.currentCorrectEstimate}
                  </p>
                )}
              </div>
            </fieldset>
          )}

          {step === 3 && (
            <fieldset className="onboarding__fieldset">
              <legend className="onboarding__legend">Sua disponibilidade</legend>
              <div className="onboarding__field">
                <span className="onboarding__field-label">Dias disponíveis</span>
                <div className="onboarding__checkbox-group">
                  {WEEKDAY_OPTIONS.map((option) => (
                    <label key={option.value} className="onboarding__checkbox">
                      <input
                        type="checkbox"
                        checked={answers.availableDays.includes(option.value)}
                        onChange={() => toggleWeekday(option.value)}
                      />
                      {option.label}
                    </label>
                  ))}
                </div>
                {fieldErrors.availableDays && (
                  <p className="onboarding__field-error" role="alert">
                    {fieldErrors.availableDays}
                  </p>
                )}
              </div>
              <div className="onboarding__field">
                <label htmlFor="onboarding-daily-minutes">
                  Minutos disponíveis por dia ({DAILY_MINUTES_MIN} a {DAILY_MINUTES_MAX})
                </label>
                <input
                  id="onboarding-daily-minutes"
                  type="number"
                  inputMode="numeric"
                  value={answers.dailyMinutes}
                  onChange={(event) => setAnswers((prev) => ({ ...prev, dailyMinutes: event.target.value }))}
                />
                {fieldErrors.dailyMinutes && (
                  <p className="onboarding__field-error" role="alert">
                    {fieldErrors.dailyMinutes}
                  </p>
                )}
              </div>
            </fieldset>
          )}

          {step === 4 && (
            <fieldset className="onboarding__fieldset">
              <legend className="onboarding__legend">
                Principais dificuldades percebidas (opcional, até {DIFFICULTIES_MAX_ITEMS})
              </legend>
              <p className="onboarding__help">
                Isso nos ajuda a personalizar seu caminho — não é uma lista fechada de assuntos.
              </p>
              <div className="onboarding__difficulty-input">
                <label htmlFor="onboarding-difficulty-draft" className="visually-hidden">
                  Descrever uma dificuldade
                </label>
                <input
                  id="onboarding-difficulty-draft"
                  type="text"
                  maxLength={DIFFICULTY_TEXT_MAX_LENGTH}
                  value={difficultyDraft}
                  onChange={(event) => setDifficultyDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addDifficulty();
                    }
                  }}
                  disabled={answers.difficulties.length >= DIFFICULTIES_MAX_ITEMS}
                />
                <Button
                  type="button"
                  variant="secondary"
                  onClick={addDifficulty}
                  disabled={answers.difficulties.length >= DIFFICULTIES_MAX_ITEMS || !difficultyDraft.trim()}
                >
                  Adicionar
                </Button>
              </div>
              {answers.difficulties.length > 0 && (
                <ul className="onboarding__tag-list">
                  {answers.difficulties.map((difficulty) => (
                    <li key={difficulty} className="onboarding__tag">
                      {difficulty}
                      <button
                        type="button"
                        aria-label={`Remover "${difficulty}"`}
                        onClick={() => removeDifficulty(difficulty)}
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {fieldErrors.difficulties && (
                <p className="onboarding__field-error" role="alert">
                  {fieldErrors.difficulties}
                </p>
              )}
            </fieldset>
          )}

          {step === 5 && (
            <fieldset className="onboarding__fieldset">
              <legend className="onboarding__legend">Preferências e acessibilidade</legend>
              <div className="onboarding__field">
                <span className="onboarding__field-label">Preferência de horário</span>
                <div className="onboarding__radio-group">
                  {TIME_PREFERENCE_OPTIONS.map((option) => (
                    <label key={option.value} className="onboarding__radio">
                      <input
                        type="radio"
                        name="timePreference"
                        value={option.value}
                        checked={answers.timePreference === option.value}
                        onChange={() => setAnswers((prev) => ({ ...prev, timePreference: option.value }))}
                      />
                      {option.label}
                    </label>
                  ))}
                </div>
                {fieldErrors.timePreference && (
                  <p className="onboarding__field-error" role="alert">
                    {fieldErrors.timePreference}
                  </p>
                )}
              </div>
              <div className="onboarding__field">
                <label htmlFor="onboarding-accessibility">
                  Necessidade ou preferência de acessibilidade (opcional)
                </label>
                <p id="onboarding-accessibility-privacy-notice" className="onboarding__help">
                  Opcional. Informe somente o que for necessário para adaptarmos sua experiência.
                  Esse conteúdo nunca aparece em URL, logs, auditoria ou mensagens de erro.
                </p>
                <textarea
                  id="onboarding-accessibility"
                  maxLength={200}
                  value={answers.accessibilityNeeds}
                  aria-describedby="onboarding-accessibility-privacy-notice"
                  onChange={(event) =>
                    setAnswers((prev) => ({ ...prev, accessibilityNeeds: event.target.value }))
                  }
                />
                {fieldErrors.accessibilityNeeds && (
                  <p className="onboarding__field-error" role="alert">
                    {fieldErrors.accessibilityNeeds}
                  </p>
                )}
              </div>
            </fieldset>
          )}

          {step === 6 && (
            <fieldset className="onboarding__fieldset">
              <legend className="onboarding__legend">Diagnóstico inicial</legend>
              <p className="onboarding__help">
                O diagnóstico ajuda a mapear seu ponto de partida. Você pode fazê-lo agora ou depois.
              </p>
              <div className="onboarding__radio-group onboarding__radio-group--stacked">
                <label className="onboarding__radio">
                  <input
                    type="radio"
                    name="diagnosticChoice"
                    value="agora"
                    checked={answers.diagnosticChoice === "agora"}
                    onChange={() => setAnswers((prev) => ({ ...prev, diagnosticChoice: "agora" }))}
                  />
                  Quero fazer o diagnóstico agora
                </label>
                <label className="onboarding__radio">
                  <input
                    type="radio"
                    name="diagnosticChoice"
                    value="depois"
                    checked={answers.diagnosticChoice === "depois"}
                    onChange={() => setAnswers((prev) => ({ ...prev, diagnosticChoice: "depois" }))}
                  />
                  Prefiro fazer depois
                </label>
              </div>
              {fieldErrors.diagnosticChoice && (
                <p className="onboarding__field-error" role="alert">
                  {fieldErrors.diagnosticChoice}
                </p>
              )}
            </fieldset>
          )}

          {step === 7 && (
            <div className="onboarding__review">
              <ReviewRow label="Série atual" value={labelFor(GRADE_OPTIONS, answers.currentGrade)} onEdit={() => goToStep(1)} />
              <ReviewRow label="Ano do ENEM" value={answers.enemYear} onEdit={() => goToStep(1)} />
              <ReviewRow
                label="Meta"
                value={
                  answers.goalType
                    ? `${labelFor(GOAL_TYPE_OPTIONS, answers.goalType)}: ${answers.goalValue}`
                    : "—"
                }
                onEdit={() => goToStep(2)}
              />
              <ReviewRow
                label="Dias disponíveis"
                value={answers.availableDays.map((day) => labelFor(WEEKDAY_OPTIONS, day)).join(", ") || "—"}
                onEdit={() => goToStep(3)}
              />
              <ReviewRow label="Minutos por dia" value={answers.dailyMinutes || "—"} onEdit={() => goToStep(3)} />
              <ReviewRow
                label="Dificuldades"
                value={answers.difficulties.join(", ") || "Nenhuma informada"}
                onEdit={() => goToStep(4)}
              />
              <ReviewRow
                label="Preferência de horário"
                value={labelFor(TIME_PREFERENCE_OPTIONS, answers.timePreference)}
                onEdit={() => goToStep(5)}
              />
              <ReviewRow
                label="Diagnóstico"
                value={answers.diagnosticChoice === "agora" ? "Agora" : answers.diagnosticChoice === "depois" ? "Depois" : "—"}
                onEdit={() => goToStep(6)}
              />
            </div>
          )}

          <div className="onboarding__actions">
            <Button type="button" variant="secondary" onClick={handleBack} disabled={step === 1}>
              Voltar
            </Button>
            {step < STEP_COUNT ? (
              <Button type="button" onClick={handleNext}>
                Avançar
              </Button>
            ) : (
              <Button type="button" onClick={handleComplete} isLoading={isCompleting}>
                Concluir onboarding
              </Button>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}

function labelFor(options: Array<{ value: string; label: string }>, value: string): string {
  return options.find((option) => option.value === value)?.label ?? "—";
}

function ReviewRow({ label, value, onEdit }: { label: string; value: string; onEdit: () => void }) {
  return (
    <div className="onboarding__review-row">
      <div>
        <p className="onboarding__review-label">{label}</p>
        <p className="onboarding__review-value">{value}</p>
      </div>
      <button type="button" className="onboarding__review-edit" onClick={onEdit}>
        Editar
      </button>
    </div>
  );
}
