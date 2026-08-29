import { useEffect, useState, type FormEvent } from "react";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { Alert } from "../components/Alert";
import { useOnboardingStatus } from "../onboarding/useOnboardingStatus";
import { saveOnboardingProgress, OnboardingApiError } from "../api/onboardingClient";
import {
  DAILY_MINUTES_MAX,
  DAILY_MINUTES_MIN,
  TIME_PREFERENCE_OPTIONS,
  WEEKDAY_OPTIONS,
} from "./onboarding/onboardingOptions";
import "./SettingsPage.css";

/* Só as preferências editáveis depois da conclusão do onboarding — o Worker
   (ONBOARDING_COLUMNS_EDITABLE_AFTER_COMPLETION) já rejeita qualquer outro
   campo com 400; esta tela nem oferece os demais campos como editáveis. */
export function SettingsPage() {
  const { profile, refresh } = useOnboardingStatus();

  const [availableDays, setAvailableDays] = useState<string[]>([]);
  const [dailyMinutes, setDailyMinutes] = useState("");
  const [timePreference, setTimePreference] = useState("");
  const [accessibilityNeeds, setAccessibilityNeeds] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!profile) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAvailableDays(profile.availableDays ?? []);
    setDailyMinutes(profile.dailyMinutes != null ? String(profile.dailyMinutes) : "");
    setTimePreference(profile.timePreference ?? "");
    setAccessibilityNeeds(profile.accessibilityNeeds ?? "");
  }, [profile]);

  function toggleDay(value: string) {
    setAvailableDays((prev) => (prev.includes(value) ? prev.filter((day) => day !== value) : [...prev, value]));
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    setSuccess(false);
    setFieldErrors({});
    setIsSaving(true);
    try {
      await saveOnboardingProgress({
        availableDays,
        dailyMinutes: dailyMinutes ? Number(dailyMinutes) : undefined,
        timePreference: timePreference || undefined,
        accessibilityNeeds: accessibilityNeeds.trim() === "" ? null : accessibilityNeeds.trim(),
      });
      await refresh();
      setSuccess(true);
    } catch (error) {
      if (error instanceof OnboardingApiError) {
        setFieldErrors(error.fields);
        setFormError("Não foi possível salvar. Revise os campos indicados.");
      } else {
        setFormError("Não foi possível salvar. Tente novamente.");
      }
    } finally {
      setIsSaving(false);
    }
  }

  if (!profile) return null;

  return (
    <div className="settings-page">
      <h1>Configurações</h1>
      <p className="settings-page__intro">
        Preferências da sua rotina de estudo. Para trocar série, meta ou dificuldades, fale com o
        suporte — esses dados moldam seu plano pedagógico e não são editáveis aqui.
      </p>

      <Card>
        <form onSubmit={handleSubmit} noValidate>
          {formError && (
            <div style={{ marginBottom: "var(--space-4)" }}>
              <Alert variant="error">{formError}</Alert>
            </div>
          )}
          {success && (
            <div style={{ marginBottom: "var(--space-4)" }}>
              <Alert variant="success">Preferências atualizadas.</Alert>
            </div>
          )}

          <div className="settings-page__field">
            <span className="settings-page__label">Dias disponíveis</span>
            <div className="settings-page__checkbox-group">
              {WEEKDAY_OPTIONS.map((option) => (
                <label key={option.value} className="settings-page__checkbox">
                  <input
                    type="checkbox"
                    checked={availableDays.includes(option.value)}
                    onChange={() => toggleDay(option.value)}
                  />
                  {option.label}
                </label>
              ))}
            </div>
            {fieldErrors.availableDays && (
              <p className="settings-page__field-error" role="alert">
                {fieldErrors.availableDays}
              </p>
            )}
          </div>

          <div className="settings-page__field">
            <label htmlFor="settings-daily-minutes">
              Minutos disponíveis por dia ({DAILY_MINUTES_MIN} a {DAILY_MINUTES_MAX})
            </label>
            <input
              id="settings-daily-minutes"
              type="number"
              inputMode="numeric"
              value={dailyMinutes}
              onChange={(event) => setDailyMinutes(event.target.value)}
            />
            {fieldErrors.dailyMinutes && (
              <p className="settings-page__field-error" role="alert">
                {fieldErrors.dailyMinutes}
              </p>
            )}
          </div>

          <div className="settings-page__field">
            <span className="settings-page__label">Preferência de horário</span>
            <div className="settings-page__radio-group">
              {TIME_PREFERENCE_OPTIONS.map((option) => (
                <label key={option.value} className="settings-page__radio">
                  <input
                    type="radio"
                    name="settings-time-preference"
                    value={option.value}
                    checked={timePreference === option.value}
                    onChange={() => setTimePreference(option.value)}
                  />
                  {option.label}
                </label>
              ))}
            </div>
            {fieldErrors.timePreference && (
              <p className="settings-page__field-error" role="alert">
                {fieldErrors.timePreference}
              </p>
            )}
          </div>

          <div className="settings-page__field">
            <label htmlFor="settings-accessibility">Necessidade ou preferência de acessibilidade</label>
            <p id="settings-accessibility-privacy-notice" className="settings-page__help">
              Opcional. Informe somente o que for necessário para adaptarmos sua experiência.
              Esse conteúdo nunca aparece em URL, logs, auditoria ou mensagens de erro.
            </p>
            <textarea
              id="settings-accessibility"
              maxLength={200}
              value={accessibilityNeeds}
              aria-describedby="settings-accessibility-privacy-notice"
              onChange={(event) => setAccessibilityNeeds(event.target.value)}
            />
            {fieldErrors.accessibilityNeeds && (
              <p className="settings-page__field-error" role="alert">
                {fieldErrors.accessibilityNeeds}
              </p>
            )}
          </div>

          <Button type="submit" isLoading={isSaving}>
            Salvar preferências
          </Button>
        </form>
      </Card>
    </div>
  );
}
