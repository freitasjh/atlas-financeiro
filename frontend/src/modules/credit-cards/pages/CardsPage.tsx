import { CardsScreen } from "./CardsScreen"

/**
 * Rota /cartoes — conteúdo puro; o esqueleto (sidebar + header) vem do
 * AtlasAdminLayout pathless montado pelo router (Outlet), nunca daqui.
 */
export default function CardsPage() {
  return <CardsScreen />
}

export { CardsPage }
