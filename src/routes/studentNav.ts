/* Menu do aluno — Documento Mestre, seção 21. Fonte única para Sidebar, MobileNav e rotas. */

export interface NavItem {
  path: string;
  label: string;
  description: string;
  icon: string;
}

export const STUDENT_NAV_ITEMS: NavItem[] = [
  { path: "/", label: "Início", description: "Seu painel de estratégia do dia.", icon: "🏠" },
  {
    path: "/treino-diario",
    label: "Treino Diário",
    description: "A sessão adaptativa de hoje, escolhida para atacar seus gargalos.",
    icon: "📘",
  },
  {
    path: "/padroes-enem",
    label: "Padrões ENEM",
    description: "O mapa completo dos padrões recorrentes e o seu domínio em cada um.",
    icon: "🧭",
  },
  {
    path: "/reconheca-o-padrao",
    label: "Reconheça o Padrão",
    description: "Desafios rápidos para treinar o reconhecimento antes da resolução.",
    icon: "🔍",
  },
  {
    path: "/banco-de-questoes",
    label: "Banco de Questões",
    description: "Questões oficiais e autorais, filtráveis por padrão e dificuldade.",
    icon: "🗂️",
  },
  {
    path: "/simulados",
    label: "Simulados",
    description: "Os quatro simulados programados do seu ciclo de preparação.",
    icon: "📝",
  },
  {
    path: "/caderno-de-erros",
    label: "Caderno de Erros",
    description: "Todo erro registrado, classificado e agendado para revisão.",
    icon: "📓",
  },
  {
    path: "/desempenho",
    label: "Desempenho",
    description: "Reconhecimento, resolução e domínio, em detalhe e ao longo do tempo.",
    icon: "📊",
  },
  {
    path: "/aulas-e-estrategias",
    label: "Aulas e Estratégias",
    description: "Aulas, vídeos curtos e resumos estratégicos por padrão.",
    icon: "🎓",
  },
  {
    path: "/conquistas",
    label: "Conquistas",
    description: "Sua sequência, selos e marcos de consistência.",
    icon: "🏆",
  },
  {
    path: "/cronograma",
    label: "Cronograma",
    description: "Sua agenda adaptativa — hoje, semana, mês e histórico.",
    icon: "📅",
  },
];

export const MOBILE_NAV_ITEMS: NavItem[] = [
  STUDENT_NAV_ITEMS[0],
  STUDENT_NAV_ITEMS[1],
  STUDENT_NAV_ITEMS[2],
  STUDENT_NAV_ITEMS[6],
];
