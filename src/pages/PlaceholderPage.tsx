import { PageTitle } from "../components/PageTitle";
import { EmptyState } from "../components/EmptyState";
import "./PlaceholderPage.css";

interface PlaceholderPageProps {
  title: string;
  description: string;
}

export function PlaceholderPage({ title, description }: PlaceholderPageProps) {
  return (
    <div className="placeholder-page">
      <PageTitle title={title} description={description} />
      <EmptyState
        title="Módulo em construção"
        description="Esta área será implementada em uma sprint posterior, conforme o roadmap do Documento Mestre."
        action={<span className="placeholder-page__badge">Em breve</span>}
      />
    </div>
  );
}
