import { beforeEach, describe, expect, it, vi } from 'vitest'

// P3.1 — guards aplicáveis ao módulo cartões (TDD).
// - tenant: update/delete sempre escopados por id+user_id; sem sessão recusa
//   antes de tocar no banco (unauthenticated).
// - link imutável: o schema de update é strict e não conhece invoice_id /
//   total/paid/status — vínculo de compra não se edita por aqui (o guard
//   invoice-link-immutable vive no módulo transactions, fora deste escopo).

const sbMocks = vi.hoisted(() => ({ from: vi.fn(), getUser: vi.fn(), rpc: vi.fn() }))
vi.mock('@/lib/supabase', () => ({
  supabase: { from: sbMocks.from, rpc: sbMocks.rpc, auth: { getUser: sbMocks.getUser } },
}))

beforeEach(() => {
  sbMocks.from.mockReset()
  sbMocks.rpc.mockReset()
  sbMocks.getUser.mockReset()
  sbMocks.getUser.mockResolvedValue({ data: { user: { id: 'u1' } } })
})

describe('whenDeleteRuns_thenScopeIsIdPlusUserId', () => {
  it('delete filtra por id + user_id (tenant nunca apaga alheio)', async () => {
    const eqs: unknown[][] = []
    sbMocks.from.mockImplementation(() => ({
      delete: () => ({
        eq: (col: string, val: string) => {
          eqs.push([col, val])
          return { eq: (c2: string, v2: string) => {
            eqs.push([c2, v2])
            return Promise.resolve({ data: null, error: null })
          } }
        },
      }),
    }))
    const { deleteCreditCard } = await import('../credit-cards.service')
    await deleteCreditCard('card-1')
    expect(eqs).toEqual([
      ['id', 'card-1'],
      ['user_id', 'u1'],
    ])
  })

  it('sem sessão delete recusa com unauthenticated sem tocar no banco', async () => {
    sbMocks.getUser.mockResolvedValue({ data: { user: null } })
    const { deleteCreditCard } = await import('../credit-cards.service')
    await expect(deleteCreditCard('card-1')).rejects.toThrow('unauthenticated')
    expect(sbMocks.from).not.toHaveBeenCalled()
  })
})

describe('whenUpdateRunsWithoutSession_thenUnauthenticatedBeforeValidate', () => {
  it('sem sessão update recusa antes de validar', async () => {
    sbMocks.getUser.mockResolvedValue({ data: { user: null } })
    const { updateCreditCard } = await import('../credit-cards.service')
    await expect(updateCreditCard('card-1', { name: 'X', limit_cents: 1, closing_day: 1, due_day: 2 })).rejects.toThrow(
      'unauthenticated',
    )
    expect(sbMocks.from).not.toHaveBeenCalled()
  })
})

describe('whenUpdatePatchCarriesInvoiceLink_thenStrictSchemaRejects', () => {
  it('invoice_id / total_cents / paid / status nunca entram no patch', async () => {
    const { creditCardUpdateSchema } = await import('../../model/credit-card')
    for (const patch of [
      { name: 'X', limit_cents: 1, closing_day: 1, due_day: 2, invoice_id: 'inv-1' },
      { name: 'X', limit_cents: 1, closing_day: 1, due_day: 2, total_cents: 999 },
      { name: 'X', limit_cents: 1, closing_day: 1, due_day: 2, status: 'paid' },
      { name: 'X', limit_cents: 1, closing_day: 1, due_day: 2, paid_cents: 10 },
    ]) {
      expect(() => creditCardUpdateSchema.parse(patch)).toThrow()
    }
  })
})

describe('whenInvoicesReadFails_thenErrorPropagates', () => {
  it('falha de leitura de faturas propaga sem mascarar', async () => {
    sbMocks.from.mockImplementation(() => ({
      select: () => ({
        eq: () => ({ order: async () => ({ data: null, error: new Error('db-down') }) }),
      }),
    }))
    const { listInvoicesByCard } = await import('../credit-cards.service')
    await expect(listInvoicesByCard('card-1')).rejects.toThrow('db-down')
  })
})

describe('whenCreateCarriesIdentity_thenInsertPayloadIsPciSafe', () => {
  const input = {
    name: 'Nu',
    account_id: '11111111-1111-1111-8111-111111111111',
    limit_cents: 500000,
    closing_day: 10,
    due_day: 17,
    last4: '1111',
    holder_name: 'JOAO SILVA',
    expiry_mm_aa: '12/29',
    theme: 'emerald',
  } as const

  it('insert serializa exatamente 10 colunas, sem PAN/CVV/is_default', async () => {
    const inserted: Record<string, unknown>[] = []
    sbMocks.from.mockImplementation(() => ({
      insert: (payload?: unknown) => {
        inserted.push(payload as Record<string, unknown>)
        return { select: () => ({ single: async () => ({ data: { ...(payload as object), id: 'c1' }, error: null }) }) }
      },
    }))
    const { createCreditCard } = await import('../credit-cards.service')
    await createCreditCard(input)
    expect(inserted).toHaveLength(1)
    expect(Object.keys(inserted[0]).sort()).toEqual(
      [
        'user_id',
        'account_id',
        'name',
        'limit_cents',
        'closing_day',
        'due_day',
        'last4',
        'holder_name',
        'expiry_mm_aa',
        'theme',
      ].sort(),
    )
    expect(inserted[0]).toMatchObject({
      last4: '1111',
      holder_name: 'JOAO SILVA',
      expiry_mm_aa: '12/29',
      theme: 'emerald',
    })
    const serialized = JSON.stringify(inserted[0])
    for (const forbidden of ['number', 'cvv', 'pan', 'card_number', 'is_default']) {
      expect(Object.keys(inserted[0])).not.toContain(forbidden)
      expect(serialized).not.toContain(`"${forbidden}"`)
    }
    expect(serialized).not.toContain('4111111111111111')
  })

  it('dois submits não duplicam tipo de chave (idempotência de serialização)', async () => {
    const { creditCardInputToInsert, creditCardSchemaIdentity } = await import('../../model/credit-card')
    const first = Object.keys(creditCardInputToInsert(creditCardSchemaIdentity.parse(input), 'u1')).sort()
    const second = Object.keys(creditCardInputToInsert(creditCardSchemaIdentity.parse(input), 'u1')).sort()
    expect(first).toEqual(second)
    expect(new Set(first).size).toBe(first.length)
  })
})

describe('whenInsertClassIsInventoried_thenNoPathCanLeakSensitiveKeys', () => {
  it('todo insert em credit_cards usa o único serializador PCI-safe (aspas simples ou duplas)', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs')
    const { join } = await import('node:path')
    const root = join(process.cwd(), 'src')
    const sources: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (entry === '__tests__') continue
        if (statSync(full).isDirectory()) walk(full)
        else if (/\.tsx?$/.test(full)) sources.push(full)
      }
    }
    walk(root)
    const read = (file: string) => readFileSync(file, 'utf8')
    const insertFiles = sources.filter((file) => /\.insert\s*\(/.test(read(file)))
    expect(insertFiles.length).toBeGreaterThan(0)
    const cardInsertFiles = insertFiles.filter((file) => /from\s*\(\s*['"]credit_cards['"]\s*\)/.test(read(file)))
    expect(cardInsertFiles).toEqual([join(root, 'modules/credit-cards/service/credit-cards.service.ts')])
    for (const file of cardInsertFiles) expect(read(file)).toContain('creditCardInputToInsert')
    for (const file of insertFiles) {
      const source = read(file)
      if (/['"]credit_cards['"]/.test(source)) expect(source).toContain('creditCardInputToInsert')
    }
  })

  it('o inventário de chaves do insert é fechado (sem number/cvv/pan/is_default)', async () => {
    const { CREDIT_CARD_INSERT_KEYS } = await import('../../model/credit-card')
    expect([...CREDIT_CARD_INSERT_KEYS].sort()).toEqual(
      [
        'user_id',
        'account_id',
        'name',
        'limit_cents',
        'closing_day',
        'due_day',
        'last4',
        'holder_name',
        'expiry_mm_aa',
        'theme',
      ].sort(),
    )
    for (const forbidden of ['number', 'cvv', 'pan', 'card_number', 'is_default']) {
      expect(CREDIT_CARD_INSERT_KEYS).not.toContain(forbidden as never)
    }
  })
})
