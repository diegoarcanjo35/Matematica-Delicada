import { createContext, useContext } from "react";
import type { EditorialRole } from "../api/editorialClient";

export const EditorialRoleContext = createContext<EditorialRole>(null);

export function useEditorialRole(): EditorialRole {
  return useContext(EditorialRoleContext);
}
