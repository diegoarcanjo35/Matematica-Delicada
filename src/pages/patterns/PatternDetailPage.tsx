import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { ErrorState } from "../../components/ErrorState";
import { LoadingState } from "../../components/LoadingState";
import { fetchPatternDetail, PatternsApiError, type PatternDetail } from "../../api/patternsClient";
import {
  INDEX_UNAVAILABLE_LABEL,
  PROVISIONAL_CONTENT_NOTICE,
  RELATION_TYPE_LABELS,
} from "./patternOptions";
import "./PatternsPage.css";

/* Ficha /padroes-enem/:slug — Sprint 6 v1.0 (Documento Mestre, seção 2.3).

   Mostra apenas o que existe de fato. Os três índices vêm da API como
   `{ available: false, value: null }` enquanto não houver evidência — e são
   renderizados literalmente como "Ainda sem evidências suficientes", nunca
   como 0%, nunca como traço que sugira cálculo.

   "Treinar este padrão" é um botão nativo DESABILITADO: o banco de questões
   e o treino real não existem nesta sprint, e nenhum clique pode criar
   tentativa, atribuição de cronograma ou progresso. */

interface IndexRowProps {
  label: string;
  index: { available: boolean; value: number | null };
}

function IndexRow({ label, index }: IndexRowProps) {
  return (
    <div className="patterns__index-row">
      <span className="patterns__index-label">{label}</span>
      <span className={`patterns__index-value${index.available ? "" : " patterns__index-value--unavailable"}`}>
        {index.available ? index.value : INDEX_UNAVAILABLE_LABEL}
      </span>
    </div>
  );
}

function sectionId(title: string): string {
  return `secao-${title.toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
}

function AttributeList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  const id = sectionId(title);
  return (
    <section className="patterns__section" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      <ul className="patterns__list">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </section>
  );
}

export function PatternDetailPage() {
  const { slug } = useParams<{ slug: string }>();
  const [phase, setPhase] = useState<"loading" | "ready" | "unavailable" | "notFound" | "error">("loading");
  const [pattern, setPattern] = useState<PatternDetail | null>(null);

  const load = useCallback(async () => {
    if (!slug) {
      setPhase("notFound");
      return;
    }
    setPhase("loading");
    try {
      const result = await fetchPatternDetail(slug);
      if (!result.available || !result.pattern) {
        setPhase("unavailable");
        return;
      }
      setPattern(result.pattern);
      setPhase("ready");
    } catch (error) {
      if (error instanceof PatternsApiError && error.status === 404) {
        setPhase("notFound");
        return;
      }
      setPhase("error");
    }
  }, [slug]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  if (phase === "loading") {
    return <LoadingState label="Carregando a ficha do padrão…" />;
  }

  if (phase === "unavailable") {
    return (
      <div className="patterns patterns--centered">
        <Card className="patterns__card">
          <h1>Ainda não há padrões publicados</h1>
          <p>
            O catálogo de padrões recorrentes já está pronto tecnicamente, mas nenhum padrão está
            publicado neste ambiente agora. Isso não é um erro do seu lado — tente novamente mais tarde.
          </p>
          <Link to="/padroes-enem">Voltar para o catálogo</Link>
        </Card>
      </div>
    );
  }

  if (phase === "notFound") {
    return (
      <div className="patterns patterns--centered">
        <Card className="patterns__card">
          <h1>Padrão não encontrado</h1>
          <p>Este padrão não existe ou ainda não está publicado.</p>
          <Link to="/padroes-enem">Voltar para o catálogo</Link>
        </Card>
      </div>
    );
  }

  if (phase === "error" || !pattern) {
    return (
      <ErrorState
        description="Não foi possível carregar a ficha deste padrão."
        action={<Button onClick={() => void load()}>Tentar novamente</Button>}
      />
    );
  }

  return (
    <article className="patterns patterns__detail">
      <p className="patterns__back">
        <Link to="/padroes-enem">← Voltar para o catálogo</Link>
      </p>

      {pattern.isLocalFixture && (
        <p className="patterns__provisional-notice" role="note">
          {PROVISIONAL_CONTENT_NOTICE}
        </p>
      )}

      <header className="patterns__header">
        <span className="patterns__card-code">{pattern.code}</span>
        <h1>{pattern.name}</h1>
        <p className="patterns__card-phrase">{pattern.recognitionPhrase}</p>
      </header>

      <section className="patterns__section" aria-labelledby="secao-descricao">
        <h2 id="secao-descricao">Descrição</h2>
        <p>{pattern.description}</p>
      </section>

      <section className="patterns__section" aria-labelledby="secao-estrategia">
        <h2 id="secao-estrategia">Estratégia principal</h2>
        <p>{pattern.mainStrategy}</p>
      </section>

      <AttributeList title="Pistas frequentes" items={pattern.frequentClues} />
      <AttributeList title="Palavras e expressões recorrentes" items={pattern.recurringPhrases} />
      <AttributeList title="Elementos visuais recorrentes" items={pattern.recurringVisualElements} />
      <AttributeList title="Estratégias alternativas" items={pattern.alternativeStrategies} />
      <AttributeList title="Conteúdos necessários" items={pattern.requiredContents} />
      <AttributeList title="Pré-requisitos" items={pattern.prerequisiteContents} />
      <AttributeList title="Erros e pegadinhas frequentes" items={pattern.commonMistakes} />
      <AttributeList title="Tags" items={pattern.tags} />

      <section className="patterns__section" aria-labelledby="secao-exemplo">
        <h2 id="secao-exemplo">Exemplo introdutório</h2>
        <p>{pattern.introductoryExample}</p>
      </section>

      <section className="patterns__section" aria-labelledby="secao-resumo">
        <h2 id="secao-resumo">Resumo estratégico</h2>
        <p>{pattern.strategicSummary}</p>
      </section>

      <section className="patterns__section" aria-labelledby="secao-relacoes">
        <h2 id="secao-relacoes">Relações com outros padrões</h2>
        {pattern.relations.length === 0 ? (
          <p>Nenhuma relação registrada até aqui.</p>
        ) : (
          <ul className="patterns__list">
            {pattern.relations.map((relation) => (
              <li key={`${relation.relationType}-${relation.slug}`}>
                <span className="patterns__card-label">
                  {RELATION_TYPE_LABELS[relation.relationType] ?? relation.relationType}:{" "}
                </span>
                <Link to={`/padroes-enem/${relation.slug}`}>
                  {relation.code} — {relation.name}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="patterns__section" aria-labelledby="secao-progresso">
        <h2 id="secao-progresso">Seu progresso neste padrão</h2>
        <div className="patterns__indices">
          <IndexRow label="Reconhecimento" index={pattern.progress.indices.recognition} />
          <IndexRow label="Resolução" index={pattern.progress.indices.resolution} />
          <IndexRow label="Domínio" index={pattern.progress.indices.mastery} />
        </div>
        <p className="patterns__index-note">
          As fórmulas dos três índices ainda estão em definição. Enquanto não houver evidência
          suficiente registrada, nenhum número é exibido — nem zero.
        </p>
        <p>
          <span className="patterns__card-label">Última prática: </span>
          {pattern.progress.lastPracticedAt ?? "Ainda sem registro"}
        </p>
        <p>
          <span className="patterns__card-label">Revisão sugerida: </span>
          {pattern.progress.nextReviewAt ?? "Ainda sem registro"}
        </p>
        <p>
          <span className="patterns__card-label">Questões disponíveis: </span>
          {pattern.availableQuestionCount}
        </p>
      </section>

      <section className="patterns__section" aria-labelledby="secao-treino">
        <h2 id="secao-treino">Treinar este padrão</h2>
        {pattern.trainableQuestionId ? (
          <>
            <Link to={`/questoes/${pattern.trainableQuestionId}`} className="btn btn--primary">
              Treinar este padrão
            </Link>
            <p className="patterns__training-note">
              A questão foi escolhida por uma seleção técnica inicial (a primeira questão publicada
              cadastrada com este padrão como principal) — nenhum algoritmo pedagógico ou adaptação
              está em uso ainda.
            </p>
          </>
        ) : (
          <>
            <Button type="button" disabled>
              Nenhuma questão publicada ainda
            </Button>
            <p className="patterns__training-note">
              Ainda não existe nenhuma questão publicada para este padrão. Este botão não inicia
              nenhuma sessão e não registra nenhum progresso.
            </p>
          </>
        )}
      </section>

      <section className="patterns__section" aria-labelledby="secao-conteudo-relacionado">
        <h2 id="secao-conteudo-relacionado">Conteúdo relacionado</h2>
        <p className="patterns__training-note">Conteúdo relacionado em preparação.</p>
      </section>
    </article>
  );
}
