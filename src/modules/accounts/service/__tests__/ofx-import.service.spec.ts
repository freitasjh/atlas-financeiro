// @vitest-environment happy-dom
// O3.1..O3.4 — lote OFX: chunks 500, 23505→skip, 1× recalc, abort parcial,
// dedup idempotência, RLS por escopo, volume 1000 linhas.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const sbMocks = vi.hoisted(() => ({ from: vi.fn(), getUser: vi.fn() }))
const accMocks = vi.hoisted(() => ({ recalcAccount: vi.fn() }))

vi.mock('@/lib/supabase', () => ({
  supabase: { from: sbMocks.from, auth: { getUser: sbMocks.getUser } },
}))

vi.mock('@/modules/accounts/service/accounts.service', () => ({
  recalcAccount: accMocks.recalcAccount,
}))

import {
  confirmOfxImport,
  fetchExistingHashes,
  OFX_IMPORT_CHUNK_SIZE,
  type OfxConfirmRow,
} from '../ofx-import.service'

const ACCOUNT_ID = '11111111-2222-4333-8444-555555555555'

function row(overrides: Partial<OfxConfirmRow> = {}): OfxConfirmRow {
  return {
    id: 'staged-0',
    date: '2026-11-01',
    description: 'PIX RECEBIDO',
    amount_cents: 15000,
    type: 'income',
    category_id: null,
    fitid: 'fit-1',
    dedup_hash:
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    selected: true,
    dup: false,
    ...overrides,
  }
}

function hashOf(i: number): string {
  return `${String(i).padStart(63, '0')}f`
}

beforeEach(() => {
  sbMocks.from.mockReset()
  sbMocks.getUser.mockReset()
  accMocks.recalcAccount.mockReset()
  sbMocks.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } } })
  accMocks.recalcAccount.mockResolvedValue(0)
})

function selectChain(result: { data: unknown; error: unknown }) {
  return {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    in: vi.fn().mockResolvedValue(result),
  }
}

describe('whenFetchingExistingHashes_thenScopesByAccountAndChunks', () => {
  it('consulta dedup_hash por account_id com RLS do client', async () => {
    const chain = selectChain({ data: [{ dedup_hash: 'h1' }], error: null })
    sbMocks.from.mockReturnValue(chain)
    const found = await fetchExistingHashes(ACCOUNT_ID, ['h1', 'h2'])
    expect(sbMocks.from).toHaveBeenCalledWith('transactions')
    expect(chain.eq).toHaveBeenCalledWith('account_id', ACCOUNT_ID)
    expect(chain.in).toHaveBeenCalledWith('dedup_hash', ['h1', 'h2'])
    expect(found).toEqual(new Set(['h1']))
  })

  it('retorna vazio sem query quando não há hashes', async () => {
    const found = await fetchExistingHashes(ACCOUNT_ID, [])
    expect(sbMocks.from).not.toHaveBeenCalled()
    expect(found.size).toBe(0)
  })
})

describe('whenConfirmingBatch_thenChunksAndSingleRecalc', () => {
  it('insere em chunks de 500 e recalcula 1×', async () => {
    const rows = Array.from({ length: 3 }, (_, i) =>
      row({ id: `s-${i}`, dedup_hash: hashOf(i) }),
    )
    const inserted = rows.map((r, i) => ({ id: `tx-${i}`, dedup_hash: r.dedup_hash }))
    sbMocks.from.mockReturnValue({
      insert: vi.fn().mockResolvedValue({ data: inserted, error: null }),
    })
    const report = await confirmOfxImport(ACCOUNT_ID, rows)
    expect(report).toMatchObject({ inserted: 3, duplicates: 0, failed: 0, aborted: 0 })
    expect(sbMocks.from).toHaveBeenCalledWith('transactions')
    expect(accMocks.recalcAccount).toHaveBeenCalledTimes(1)
    expect(accMocks.recalcAccount).toHaveBeenCalledWith(ACCOUNT_ID)
  })

  it('ignora linhas não selecionadas ou marcadas dup', async () => {
    sbMocks.from.mockReturnValue({
      insert: vi.fn().mockResolvedValue({ data: [{ id: 'tx-1' }], error: null }),
    })
    const report = await confirmOfxImport(ACCOUNT_ID, [
      row({ id: 'keep', dedup_hash: hashOf(1) }),
      row({ id: 'skip-sel', selected: false, dedup_hash: hashOf(2) }),
      row({ id: 'skip-dup', dup: true, dedup_hash: hashOf(3) }),
    ])
    expect(report.inserted).toBe(1)
    const payload = sbMocks.from('transactions').insert.mock.calls[0][0] as unknown[]
    expect(payload).toHaveLength(1)
  })

  it('payload carrega user_id autenticado + BIGINT cents + fitid/dedup (RLS por escopo)', async () => {
    sbMocks.from.mockReturnValue({
      insert: vi.fn().mockResolvedValue({ data: [{ id: 'tx-1' }], error: null }),
    })
    await confirmOfxImport(ACCOUNT_ID, [row({ amount_cents: 2599 })])
    const payload = sbMocks.from('transactions').insert.mock.calls[0][0] as Record<string, unknown>[]
    expect(payload[0]).toMatchObject({
      user_id: 'user-1',
      account_id: ACCOUNT_ID,
      amount_cents: 2599,
      type: 'income',
      is_transfer: false,
    })
    expect(payload[0]).toHaveProperty('dedup_hash')
    expect(payload[0]).toHaveProperty('fitid', 'fit-1')
  })

  it('conflito 23505 no chunk vira skip contado sem falhar o batch', async () => {
    const conflict = { code: '23505', message: 'duplicate key' }
    const insert = vi.fn().mockImplementation((payload: unknown[]) => {
      if (payload.length > 1) return Promise.resolve({ data: null, error: conflict })
      const h = (payload[0] as { dedup_hash: string }).dedup_hash
      if (h === hashOf(1)) return Promise.resolve({ data: [{ id: 'tx-a' }], error: null })
      return Promise.resolve({ data: null, error: conflict })
    })
    sbMocks.from.mockReturnValue({ insert })
    const report = await confirmOfxImport(ACCOUNT_ID, [
      row({ id: 'a', dedup_hash: hashOf(1) }),
      row({ id: 'b', dedup_hash: hashOf(2) }),
    ])
    expect(report.inserted).toBe(1)
    expect(report.duplicates).toBe(1)
    expect(report.failed).toBe(0)
    expect(report.aborted).toBe(0)
    expect(accMocks.recalcAccount).toHaveBeenCalledTimes(1)
  })

  it('erro não-23505 aborta restantes com relatório parcial honesto', async () => {
    const boom = { code: '500', message: 'db down' }
    const insert = vi.fn().mockResolvedValue({ data: null, error: boom })
    sbMocks.from.mockReturnValue({ insert })
    const rows = Array.from({ length: 3 }, (_, i) =>
      row({ id: `s-${i}`, dedup_hash: hashOf(i) }),
    )
    const report = await confirmOfxImport(ACCOUNT_ID, rows, { chunkSize: 1 })
    expect(report.inserted).toBe(0)
    expect(report.failed).toBe(1)
    expect(report.aborted).toBe(2)
    expect(report.errors.length).toBeGreaterThan(0)
    // nada gravou → sem recalc fantasma
    expect(accMocks.recalcAccount).not.toHaveBeenCalled()
  })

  it('re-import idempotente: tudo 23505 = 0 novos, N skips', async () => {
    const conflict = { code: '23505', message: 'duplicate key' }
    const insert = vi.fn().mockImplementation((payload: unknown[]) => {
      if (payload.length > 1) return Promise.resolve({ data: null, error: conflict })
      return Promise.resolve({ data: null, error: conflict })
    })
    sbMocks.from.mockReturnValue({ insert })
    const rows = Array.from({ length: 4 }, (_, i) =>
      row({ id: `s-${i}`, dedup_hash: hashOf(i) }),
    )
    const report = await confirmOfxImport(ACCOUNT_ID, rows)
    expect(report.inserted).toBe(0)
    expect(report.duplicates).toBe(4)
    expect(report.failed).toBe(0)
  })

  it('volume 1000 linhas: 2 chunks e completa <5s', async () => {
    const insert = vi
      .fn()
      .mockImplementation((payload: unknown[]) =>
        Promise.resolve({ data: payload.map((_, i) => ({ id: `tx-${i}` })), error: null }),
      )
    sbMocks.from.mockReturnValue({ insert })
    const rows = Array.from({ length: 1000 }, (_, i) =>
      row({ id: `s-${i}`, dedup_hash: hashOf(i) }),
    )
    const start = performance.now()
    const report = await confirmOfxImport(ACCOUNT_ID, rows)
    const elapsed = performance.now() - start
    expect(insert).toHaveBeenCalledTimes(Math.ceil(1000 / OFX_IMPORT_CHUNK_SIZE))
    expect(report.inserted).toBe(1000)
    expect(elapsed).toBeLessThan(5000)
  }, 15000)

  it('sem sessão autenticada recusa antes de qualquer escrita', async () => {
    sbMocks.getUser.mockResolvedValue({ data: { user: null } })
    await expect(confirmOfxImport(ACCOUNT_ID, [row()])).rejects.toThrow('unauthenticated')
    expect(sbMocks.from).not.toHaveBeenCalled()
    expect(accMocks.recalcAccount).not.toHaveBeenCalled()
  })

  it('aborted conta payload validado, não linhas selecionadas', async () => {
    const boom = { code: '500', message: 'db down' }
    const insert = vi.fn().mockResolvedValue({ data: null, error: boom })
    sbMocks.from.mockReturnValue({ insert })
    const rows = [
      row({ id: 's-0', dedup_hash: hashOf(0) }),
      row({ id: 's-1', dedup_hash: hashOf(1), amount_cents: -5 }),
      row({ id: 's-2', dedup_hash: hashOf(2) }),
    ]
    const report = await confirmOfxImport(ACCOUNT_ID, rows, { chunkSize: 1 })
    // chunk-0 válido perdido → failed; inválida do chunk-1 → failed; só chunk-2 abortado
    expect(report.failed).toBe(2)
    expect(report.aborted).toBe(1)
    expect(accMocks.recalcAccount).not.toHaveBeenCalled()
  })
})
