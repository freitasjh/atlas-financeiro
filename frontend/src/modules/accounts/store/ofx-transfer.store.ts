// P1.3 — handoff picker → página: arquivo em memória (zustand, sem gravar).
// Nunca grava em storage; reload limpa (estado vazio honesto, P1.4).
import { create } from 'zustand'

export interface OfxTransferPayload {
  fileText: string
  fileName: string
  accountId: string
}

interface OfxTransferState {
  fileText: string | null
  fileName: string | null
  accountId: string | null
  setTransfer: (payload: OfxTransferPayload) => void
  clearTransfer: () => void
}

export const useOfxTransferStore = create<OfxTransferState>((set) => ({
  fileText: null,
  fileName: null,
  accountId: null,
  setTransfer: (payload) =>
    set({ fileText: payload.fileText, fileName: payload.fileName, accountId: payload.accountId }),
  clearTransfer: () => set({ fileText: null, fileName: null, accountId: null }),
}))
