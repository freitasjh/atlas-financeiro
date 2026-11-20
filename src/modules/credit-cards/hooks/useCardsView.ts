import { useState } from 'react'

export type CardsViewMode = 'statements' | 'wallet'

// Hook-first: modo de visão Extrato/Carteira (toggle preserva seleção, que vive
// no store via useCreditCards — aqui só o modo).
export function useCardsView(initialViewMode: CardsViewMode = 'statements') {
  const [viewMode, setViewMode] = useState<CardsViewMode>(initialViewMode)
  return { viewMode, setViewMode }
}
