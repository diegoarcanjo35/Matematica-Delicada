import "./Badge.css";

/* Estados de padrão pedagógico — Documento Mestre, seção 5.4 */
export type BadgeStatus =
  | "nao-iniciado"
  | "muito-fragil"
  | "prioridade-alta"
  | "em-evolucao"
  | "quase-dominado"
  | "dominado"
  | "revisao-vencida"
  | "neutro"
  | "sucesso"
  | "erro";

const STATUS_LABEL: Record<BadgeStatus, string> = {
  "nao-iniciado": "Não iniciado",
  "muito-fragil": "Muito frágil",
  "prioridade-alta": "Prioridade alta",
  "em-evolucao": "Em evolução",
  "quase-dominado": "Quase dominado",
  dominado: "Dominado",
  "revisao-vencida": "Revisão vencida",
  neutro: "Neutro",
  sucesso: "Sucesso",
  erro: "Erro",
};

interface BadgeProps {
  status: BadgeStatus;
  label?: string;
}

export function Badge({ status, label }: BadgeProps) {
  return <span className={`badge badge--${status}`}>{label ?? STATUS_LABEL[status]}</span>;
}
