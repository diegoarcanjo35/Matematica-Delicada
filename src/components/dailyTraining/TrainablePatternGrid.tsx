import { Link } from "react-router-dom";
import type { TrainablePattern } from "../../api/dailyTrainingClient";
import "./TrainablePatternGrid.css";

/* Sprint 20 — "O que você quer treinar hoje?" (seção 5/24 da ordem).
   Reaproveitado IDÊNTICO pelo Dashboard (seção dominante) e pela
   DailyTrainingPage (seletor quando não há patternId na URL) — nunca duas
   implementações da mesma grade. A lista vem 100% da API (nenhum padrão
   hardcoded); um card com `canTrain: false` continua visível, só
   desabilitado com uma mensagem amigável (seção 4: "melhor do que esconder
   silenciosamente parte do catálogo"). Cards treináveis são `<Link>` (foco/
   ativação por teclado nativos); cards desabilitados nunca são um link que
   levaria a um preview vazio — um `<div aria-disabled>` com texto explícito,
   nunca só uma cor apagada. */

export function TrainablePatternGrid({ patterns }: { patterns: TrainablePattern[] }) {
  if (patterns.length === 0) {
    return <p className="pattern-grid__empty">Nenhum padrão publicado ainda — volte em breve.</p>;
  }

  return (
    <ul className="pattern-grid">
      {patterns.map((pattern) => (
        <li key={pattern.id} className="pattern-grid__item">
          {pattern.canTrain ? (
            <Link to={`/treino-diario?patternId=${encodeURIComponent(pattern.id)}`} className="pattern-grid__card pattern-grid__card--enabled">
              <span className="pattern-grid__name">{pattern.name}</span>
              <span className="pattern-grid__count">
                {pattern.availableQuestionCount} {pattern.availableQuestionCount === 1 ? "questão disponível" : "questões disponíveis"}
              </span>
              <span className="pattern-grid__cta" aria-hidden="true">
                Treinar →
              </span>
            </Link>
          ) : (
            <div className="pattern-grid__card pattern-grid__card--disabled" aria-disabled="true">
              <span className="pattern-grid__name">{pattern.name}</span>
              <span className="pattern-grid__count pattern-grid__count--muted">Questões em preparação</span>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
