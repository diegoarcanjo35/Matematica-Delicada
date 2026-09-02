import { createContext, useContext } from "react";
import type { TeacherDashboard } from "../api/teacherClient";

/* O dashboard já é buscado uma vez por RequireTeacherRole.tsx (é a mesma
   chamada usada para verificar o papel — ordem seção 14: "não aumentar a
   API sem necessidade", então não existe um /api/teacher/me separado).
   TeacherOverviewPage lê esta mesma resposta em vez de buscar de novo. */
export const TeacherDashboardContext = createContext<TeacherDashboard | null>(null);

export function useTeacherDashboard(): TeacherDashboard | null {
  return useContext(TeacherDashboardContext);
}
