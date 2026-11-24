import { CategoriesScreen } from "./CategoriesScreen"

/**
 * Rota /categorias — conteúdo puro; o esqueleto (sidebar + header) vem do
 * AtlasAdminLayout pathless montado pelo router (Outlet), nunca daqui.
 */
export default function CategoriesPage() {
  return <CategoriesScreen />
}

export { CategoriesPage }
