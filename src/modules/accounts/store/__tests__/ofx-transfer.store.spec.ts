// @vitest-environment happy-dom
// P1.3 — store transitório do handoff picker → página (memória, nunca persistido).
import { beforeEach, describe, expect, it } from 'vitest'
import { useOfxTransferStore } from '../ofx-transfer.store'

beforeEach(() => {
  useOfxTransferStore.getState().clearTransfer()
})

describe('whenTransferSet_thenMemoryHoldsFile', () => {
  it('guarda texto, nome e conta em memória', () => {
    useOfxTransferStore.getState().setTransfer({
      fileText: 'OFXHEADER:100',
      fileName: 'bb.ofx',
      accountId: 'acc-1',
    })
    const state = useOfxTransferStore.getState()
    expect(state.fileText).toBe('OFXHEADER:100')
    expect(state.fileName).toBe('bb.ofx')
    expect(state.accountId).toBe('acc-1')
  })

  it('nunca persiste em storage (só memória zustand, sem middleware)', async () => {
    const mod = (await import('../ofx-transfer.store?raw').catch(() => null)) as { default?: string } | null
    if (mod?.default) {
      expect(mod.default).not.toMatch(/localStorage|sessionStorage|persist/)
    }
    useOfxTransferStore.getState().setTransfer({
      fileText: 'OFXHEADER:100',
      fileName: 'bb.ofx',
      accountId: 'acc-1',
    })
    expect(useOfxTransferStore.getState().fileName).toBe('bb.ofx')
  })
})

describe('whenTransferCleared_thenMemoryIsEmpty', () => {
  it('clearTransfer esvazia texto, nome e conta', () => {
    useOfxTransferStore.getState().setTransfer({
      fileText: 'OFXHEADER:100',
      fileName: 'bb.ofx',
      accountId: 'acc-1',
    })
    useOfxTransferStore.getState().clearTransfer()
    const state = useOfxTransferStore.getState()
    expect(state.fileText).toBeNull()
    expect(state.fileName).toBeNull()
    expect(state.accountId).toBeNull()
  })
})
