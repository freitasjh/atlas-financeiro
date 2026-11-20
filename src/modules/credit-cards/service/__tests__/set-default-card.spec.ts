import { beforeEach, describe, expect, it, vi } from 'vitest'

// ADR-002 / E2.1 — wrapper de promoção de cartão principal via RPC.
// O cliente nunca monta as duas UPDATEs: 1 round-trip, erro nomeado propagado.

const sbMocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }))
vi.mock('@/lib/supabase', () => ({
  supabase: { from: sbMocks.from, rpc: sbMocks.rpc },
}))

beforeEach(() => {
  sbMocks.from.mockReset()
  sbMocks.rpc.mockReset()
})

describe('whenSetDefaultCardRuns_thenSingleRpcCallIsMade', () => {
  it('chama set_default_card com p_card_id em uma única chamada, sem UPDATEs no cliente', async () => {
    sbMocks.rpc.mockResolvedValue({ data: null, error: null })
    const { setDefaultCard } = await import('../credit-cards.service')
    await expect(setDefaultCard('c-1')).resolves.toBeUndefined()
    expect(sbMocks.rpc).toHaveBeenCalledTimes(1)
    expect(sbMocks.rpc).toHaveBeenCalledWith('set_default_card', { p_card_id: 'c-1' })
    expect(sbMocks.from).not.toHaveBeenCalled()
  })

  it('card-not-found vira CardNotFoundError com rótulo exato', async () => {
    sbMocks.rpc.mockResolvedValue({ data: null, error: { message: 'card-not-found', code: 'P0001' } })
    const { setDefaultCard, CardNotFoundError } = await import('../credit-cards.service')
    await expect(setDefaultCard('c-404')).rejects.toBeInstanceOf(CardNotFoundError)
    await expect(setDefaultCard('c-404')).rejects.toMatchObject({
      name: 'CardNotFoundError',
      message: 'card-not-found',
    })
  })

  it('erro desconhecido propaga sem mascarar', async () => {
    sbMocks.rpc.mockResolvedValue({ data: null, error: { message: 'connection reset' } })
    const { setDefaultCard } = await import('../credit-cards.service')
    await expect(setDefaultCard('c-1')).rejects.toMatchObject({ message: 'connection reset' })
  })
})
