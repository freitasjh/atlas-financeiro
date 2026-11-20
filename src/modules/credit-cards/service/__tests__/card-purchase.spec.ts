import { beforeEach, describe, expect, it, vi } from 'vitest'

// P1.1 (TDD FIRST) — compra 1x/Nx de cartão. BIGINT cents em todo valor;
// categoria tenant; RN02/RN03; recalc por RPC; rollback plano+linhas;
// fatura vazia residual é idempotente (UNIQUE card,period reaproveita).

const sbMocks = vi.hoisted(() => ({ from: vi.fn(), getUser: vi.fn(), rpc: vi.fn() }))
vi.mock('@/lib/supabase', () => ({
  supabase: { from: sbMocks.from, rpc: sbMocks.rpc, auth: { getUser: sbMocks.getUser } },
}))

type Row = Record<string, unknown>

interface RpcCall {
  name: string
  args: Row
}

interface State {
  categories: Row[]
  invoices: Row[]
  invoiceInserts: Row[]
  invoiceDeletes: unknown[]
  planInserts: Row[]
  planDeletes: unknown[]
  txInserts: Row[]
  txDeletesIn: unknown[][]
  txDeletesEq: unknown[]
  categoryQueries: Row[]
  categoryError: { message: string } | null
  txError: { message: string } | null
  txErrorAt: number | null
  recalcError: { message: string } | null
  payError: { message: string } | null
  rpcCalls: RpcCall[]
}

function makeState(overrides: Partial<State> = {}): State {
  return {
    categories: [],
    invoices: [],
    invoiceInserts: [],
    invoiceDeletes: [],
    planInserts: [],
    planDeletes: [],
    txInserts: [],
    txDeletesIn: [],
    txDeletesEq: [],
    categoryQueries: [],
    categoryError: null,
    txError: null,
    txErrorAt: null,
    recalcError: null,
    payError: null,
    rpcCalls: [],
    ...overrides,
  }
}

function filteredQuery(rows: Row[], filters: Row) {
  const q: Row = {}
  q.eq = (col: string, val: unknown) => {
    filters[col] = val
    return q
  }
  q.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
    const data = rows.filter((row) => Object.entries(filters).every(([k, v]) => row[k] === v))
    return Promise.resolve({ data, error: null }).then(resolve, reject)
  }
  q.maybeSingle = async () => {
    const data = rows.filter((row) => Object.entries(filters).every(([k, v]) => row[k] === v))
    return { data: data[0] ?? null, error: null }
  }
  return q
}

function setup(state: State) {
  sbMocks.rpc.mockReset()
  sbMocks.rpc.mockImplementation(async (name: string, args: Row) => {
    state.rpcCalls.push({ name, args })
    if (name === 'recalc_invoice_total') {
      if (state.recalcError) return { data: null, error: state.recalcError }
      const total = state.txInserts
        .filter((t) => t.invoice_id === args.p_invoice && t.is_transfer === false)
        .reduce((sum, t) => sum + Number(t.amount_cents ?? 0), 0)
      return { data: total, error: null }
    }
    if (name === 'pay_invoice') {
      return { data: state.payError ? null : 'tx-pay', error: state.payError }
    }
    return { data: null, error: null }
  })

  sbMocks.from.mockImplementation((table: string) => {
    if (table === 'categories') {
      const filters: Row = {}
      const q: Row = {}
      q.select = () => q
      q.eq = (col: string, val: unknown) => {
        filters[col] = val
        return q
      }
      q.maybeSingle = async () => {
        state.categoryQueries.push({ ...filters })
        if (state.categoryError) return { data: null, error: state.categoryError }
        const found = state.categories.find((c) =>
          Object.entries(filters).every(([k, v]) => c[k] === v),
        )
        return { data: found ? { id: found.id } : null, error: null }
      }
      return q
    }

    if (table === 'invoices') {
      return {
        select: () => filteredQuery(state.invoices, {}),
        insert: (payload: Row) => {
          state.invoiceInserts.push(payload)
          const row = { id: `inv-${state.invoices.length + 1}`, paid_cents: 0, ...payload }
          state.invoices.push(row)
          return { select: () => ({ single: async () => ({ data: row, error: null }) }) }
        },
        delete: () => ({
          eq: async (_col: string, val: unknown) => {
            state.invoiceDeletes.push(val)
            return { error: null }
          },
        }),
        update: () => {
          throw new Error('cliente não escreve invoices (total_cents é da RPC)')
        },
      }
    }

    if (table === 'installment_plans') {
      return {
        insert: (payload: Row) => {
          state.planInserts.push(payload)
          return { select: () => ({ single: async () => ({ data: { id: 'plan-1' }, error: null }) }) }
        },
        delete: () => ({
          eq: async (_col: string, val: unknown) => {
            state.planDeletes.push(val)
            return { error: null }
          },
        }),
      }
    }

    if (table === 'transactions') {
      return {
        insert: (payload: Row) => {
          const index = state.txInserts.length
          state.txInserts.push(payload)
          const fail = state.txError !== null && (state.txErrorAt === null || state.txErrorAt === index)
          return {
            select: () => ({
              single: async () =>
                fail
                  ? { data: null, error: state.txError }
                  : { data: { id: `tx-${index + 1}`, ...payload }, error: null },
            }),
          }
        },
        delete: () => ({
          in: async (_col: string, ids: unknown[]) => {
            state.txDeletesIn.push(ids)
            return { error: null }
          },
          eq: async (_col: string, val: unknown) => {
            state.txDeletesEq.push(val)
            return { error: null }
          },
        }),
      }
    }

    throw new Error(`tabela inesperada: ${table}`)
  })
}

const card = { id: 'card-1', account_id: 'acc-1', closing_day: 15, due_day: 22 }
const cardClosing5 = { ...card, id: 'card-2', closing_day: 5 }

beforeEach(() => {
  sbMocks.from.mockReset()
  sbMocks.rpc.mockReset()
  sbMocks.getUser.mockReset()
  sbMocks.getUser.mockResolvedValue({ data: { user: { id: 'u1' } } })
})

describe('whenSinglePurchaseWithCategory_thenRoutedAndRecalculated', () => {
  it('valida categoria do tenant, cria 1 fatura/1 tx e chama recalc', async () => {
    const state = makeState({ categories: [{ id: 'cat-food', user_id: 'u1' }] })
    setup(state)
    const { createCardPurchase } = await import('../credit-cards.service')

    const row = await createCardPurchase(card, {
      description: 'Mercado',
      totalCents: 20000,
      date: '2026-04-14',
      categoryId: 'cat-food',
    })

    expect(state.categoryQueries).toEqual([{ id: 'cat-food', user_id: 'u1' }])
    expect(state.invoiceInserts).toHaveLength(1)
    expect(state.invoiceInserts[0]).toMatchObject({
      user_id: 'u1',
      credit_card_id: 'card-1',
      period_start: '2026-03-16',
      period_end: '2026-04-15',
      due_date: '2026-04-22',
      status: 'open',
    })
    expect('total_cents' in state.invoiceInserts[0]).toBe(false)
    expect('paid_cents' in state.invoiceInserts[0]).toBe(false)
    expect(state.txInserts).toEqual([
      expect.objectContaining({
        user_id: 'u1',
        account_id: 'acc-1',
        invoice_id: 'inv-1',
        category_id: 'cat-food',
        installment_plan_id: null,
        installment_number: null,
        description: 'Mercado',
        amount_cents: 20000,
        date: '2026-04-14',
        type: 'expense',
        is_transfer: false,
      }),
    ])
    expect(state.rpcCalls).toEqual([
      { name: 'recalc_invoice_total', args: { p_invoice: 'inv-1' } },
    ])
    expect(row.id).toBe('tx-1')
  })
})

describe('whenSinglePurchaseWithoutCategory_thenNoValidationQuery', () => {
  it('categoria ausente: NULL na tx, nenhuma consulta em categories', async () => {
    const state = makeState()
    setup(state)
    const { createCardPurchase } = await import('../credit-cards.service')

    await createCardPurchase(card, { description: 'Mercado', totalCents: 1000, date: '2026-04-14' })

    expect(state.categoryQueries).toEqual([])
    expect(state.txInserts[0]).toMatchObject({ category_id: null })
  })
})

describe('whenInvoiceForCycleAlreadyExists_thenReusedWithoutMutation', () => {
  it('fatura existente não é reinserida nem updateada', async () => {
    const existing = {
      id: 'inv-open',
      user_id: 'u1',
      credit_card_id: 'card-1',
      period_start: '2026-03-16',
      period_end: '2026-04-15',
      due_date: '2026-04-22',
      status: 'open',
      total_cents: 7000,
      paid_cents: 0,
    }
    const state = makeState({ invoices: [existing] })
    setup(state)
    const { createCardPurchase } = await import('../credit-cards.service')

    await createCardPurchase(card, { description: 'Farmácia', totalCents: 3500, date: '2026-04-14' })

    expect(state.invoiceInserts).toHaveLength(0)
    expect(state.txInserts[0]).toMatchObject({ invoice_id: 'inv-open' })
    expect(state.rpcCalls).toEqual([{ name: 'recalc_invoice_total', args: { p_invoice: 'inv-open' } }])
  })
})

describe('whenInstallmentPurchase_thenSplitMatchesTotalAndRoutesEachCycle', () => {
  it('3x de 100000 → [33334,33333,33333], 1 plano, 3 faturas, soma == total', async () => {
    const state = makeState()
    setup(state)
    const { createInstallmentPurchase } = await import('../credit-cards.service')

    const result = await createInstallmentPurchase(card, {
      description: 'TV',
      totalCents: 100000,
      count: 3,
      firstDate: '2026-04-14',
    })

    expect(result.planId).toBe('plan-1')
    expect(result.rows).toHaveLength(3)
    expect(state.planInserts).toEqual([
      expect.objectContaining({
        user_id: 'u1',
        description: 'TV',
        total_amount_cents: 100000,
        total_installments: 3,
      }),
    ])
    expect(state.txInserts.map((t) => t.amount_cents)).toEqual([33334, 33333, 33333])
    expect(state.txInserts.map((t) => Number(t.amount_cents)).reduce((a, b) => a + b, 0)).toBe(100000)
    expect(state.txInserts.map((t) => t.installment_number)).toEqual([1, 2, 3])
    expect(state.txInserts.map((t) => t.description)).toEqual(['TV 1/3', 'TV 2/3', 'TV 3/3'])
    expect(state.txInserts.map((t) => t.invoice_id)).toEqual(['inv-1', 'inv-2', 'inv-3'])
    expect(state.invoiceInserts.map((i) => i.period_end)).toEqual([
      '2026-04-15',
      '2026-05-15',
      '2026-06-15',
    ])
    expect(state.rpcCalls.map((c) => c.args.p_invoice)).toEqual(['inv-1', 'inv-2', 'inv-3'])
  })

  it('dois cartões com closing_days diferentes, mesmas datas → ciclos distintos', async () => {
    const state = makeState()
    setup(state)
    const { createInstallmentPurchase } = await import('../credit-cards.service')
    const input = { description: 'TV', totalCents: 60000, count: 2, firstDate: '2026-04-14' }

    await createInstallmentPurchase(card, input)
    await createInstallmentPurchase(cardClosing5, input)

    const byCard = (id: string) =>
      state.invoiceInserts.filter((i) => i.credit_card_id === id).map((i) => i.period_end)
    expect(byCard('card-1')).toEqual(['2026-04-15', '2026-05-15'])
    expect(byCard('card-2')).toEqual(['2026-05-05', '2026-06-05'])
  })
})

describe('whenCategoryBelongsToAnotherTenant_thenRejectsBeforeProvisioning', () => {
  it('1x: categoria alheia não cria fatura nem tx', async () => {
    const state = makeState({ categories: [{ id: 'cat-foreign', user_id: 'u2' }] })
    setup(state)
    const { createCardPurchase, CategoryTenantMismatchError } = await import('../credit-cards.service')

    await expect(
      createCardPurchase(card, {
        description: 'Mercado',
        totalCents: 1000,
        date: '2026-04-14',
        categoryId: 'cat-foreign',
      }),
    ).rejects.toBeInstanceOf(CategoryTenantMismatchError)
    expect(state.invoiceInserts).toHaveLength(0)
    expect(state.txInserts).toHaveLength(0)
  })

  it('Nx: categoria alheia não cria plano nem parcelas', async () => {
    const state = makeState({ categories: [{ id: 'cat-foreign', user_id: 'u2' }] })
    setup(state)
    const { createInstallmentPurchase, CategoryTenantMismatchError } = await import('../credit-cards.service')

    await expect(
      createInstallmentPurchase(card, {
        description: 'TV',
        totalCents: 120000,
        count: 3,
        firstDate: '2026-04-14',
        categoryId: 'cat-foreign',
      }),
    ).rejects.toBeInstanceOf(CategoryTenantMismatchError)
    expect(state.planInserts).toHaveLength(0)
    expect(state.txInserts).toHaveLength(0)
  })

  it('erro de rede no pre-check bloqueia (fail-closed)', async () => {
    const state = makeState({ categoryError: { message: 'fetch failed' } })
    setup(state)
    const { createCardPurchase } = await import('../credit-cards.service')

    await expect(
      createCardPurchase(card, {
        description: 'Mercado',
        totalCents: 1000,
        date: '2026-04-14',
        categoryId: 'cat-food',
      }),
    ).rejects.toThrow('fetch failed')
    expect(state.invoiceInserts).toHaveLength(0)
    expect(state.txInserts).toHaveLength(0)
  })
})

describe('whenDatabaseGuardRejectsCategory_thenTypedErrorSurfaces', () => {
  it('1x: category-tenant-mismatch (0021) do banco vira CategoryTenantMismatchError', async () => {
    const state = makeState({
      categories: [{ id: 'cat-food', user_id: 'u1' }],
      txError: { message: 'category-tenant-mismatch' },
    })
    setup(state)
    const { createCardPurchase, CategoryTenantMismatchError } = await import('../credit-cards.service')

    await expect(
      createCardPurchase(card, {
        description: 'Mercado',
        totalCents: 1000,
        date: '2026-04-14',
        categoryId: 'cat-food',
      }),
    ).rejects.toBeInstanceOf(CategoryTenantMismatchError)
  })

  it('Nx: category-tenant-mismatch do banco vira CategoryTenantMismatchError', async () => {
    const state = makeState({
      categories: [{ id: 'cat-tech', user_id: 'u1' }],
      txError: { message: 'category-tenant-mismatch' },
    })
    setup(state)
    const { createInstallmentPurchase, CategoryTenantMismatchError } = await import('../credit-cards.service')

    await expect(
      createInstallmentPurchase(card, {
        description: 'TV',
        totalCents: 120000,
        count: 3,
        firstDate: '2026-04-14',
        categoryId: 'cat-tech',
      }),
    ).rejects.toBeInstanceOf(CategoryTenantMismatchError)
  })
})

describe('whenInvoicePaid_thenPurchaseUsesDistinctTypedError', () => {
  it('guard 0009 no insert de compra → PurchaseInvoicePaidError com invoiceId', async () => {
    const state = makeState({ txError: { message: 'invoice-paid-locked' } })
    setup(state)
    const { createCardPurchase, PurchaseInvoicePaidError } = await import('../credit-cards.service')

    await expect(
      createCardPurchase(card, { description: 'Mercado', totalCents: 1000, date: '2026-04-14' }),
    ).rejects.toMatchObject({
      name: 'PurchaseInvoicePaidError',
      message: 'invoice-already-paid',
      invoiceId: 'inv-1',
    })
    const { PurchaseInvoicePaidError: C } = await import('../credit-cards.service')
    expect(new C('inv-1')).toBeInstanceOf(Error)
    expect(PurchaseInvoicePaidError).toBeDefined()
  })

  it('payInvoice mantém InvoicePaidLockedError (invoice-paid-locked, sem id) — sem colisão', async () => {
    const state = makeState({ payError: { message: 'invoice-paid-locked' } })
    setup(state)
    const svc = await import('../credit-cards.service')

    await expect(
      svc.payInvoice({ invoiceId: 'inv-1', accountId: 'acc-1', date: '2026-04-14' }),
    ).rejects.toMatchObject({ name: 'InvoicePaidLockedError', message: 'invoice-paid-locked' })
    const err = await svc.payInvoice({
      invoiceId: 'inv-1',
      accountId: 'acc-1',
      date: '2026-04-14',
    }).catch((e: unknown) => e)
    expect('invoiceId' in (err as object)).toBe(false)
    expect(svc.PurchaseInvoicePaidError).not.toBe(svc.InvoicePaidLockedError)
    expect(new svc.PurchaseInvoicePaidError('x')).not.toBeInstanceOf(svc.InvoicePaidLockedError)
  })
})

describe('whenNxFailsMidway_thenRowsAndPlanAreRolledBack', () => {
  it('falha na 2ª parcela: delete só das linhas confirmadas + plano, nunca fatura', async () => {
    const state = makeState({ txError: { message: 'boom' }, txErrorAt: 1 })
    setup(state)
    const { createInstallmentPurchase } = await import('../credit-cards.service')

    await expect(
      createInstallmentPurchase(card, {
        description: 'TV',
        totalCents: 120000,
        count: 3,
        firstDate: '2026-04-14',
      }),
    ).rejects.toThrow('boom')

    expect(state.txDeletesIn).toEqual([['tx-1']])
    expect(state.planDeletes).toEqual(['plan-1'])
    expect(state.invoiceDeletes).toEqual([])
    expect(state.txDeletesEq).toEqual([])
  })

  it('fatura vazia residual é idempotente: próxima compra reaproveita o ciclo', async () => {
    const failed = makeState({ txError: { message: 'boom' }, txErrorAt: 1 })
    setup(failed)
    const { createInstallmentPurchase, createCardPurchase } = await import('../credit-cards.service')

    await expect(
      createInstallmentPurchase(card, {
        description: 'TV',
        totalCents: 120000,
        count: 3,
        firstDate: '2026-04-14',
      }),
    ).rejects.toThrow('boom')
    const insertsAfterFailure = failed.invoiceInserts.length

    await createCardPurchase(card, { description: 'Mercado', totalCents: 1000, date: '2026-04-14' })

    expect(failed.invoiceInserts).toHaveLength(insertsAfterFailure)
    expect(failed.txInserts.at(-1)).toMatchObject({ invoice_id: 'inv-1', amount_cents: 1000 })
    expect(failed.invoiceDeletes).toEqual([])
  })
})

describe('whenRecalcFailsOnSinglePurchase_thenRowIsDeleted', () => {
  it('delete da linha + erro original propagado', async () => {
    const state = makeState({ recalcError: new Error('recalc-down') })
    setup(state)
    const { createCardPurchase } = await import('../credit-cards.service')

    await expect(
      createCardPurchase(card, { description: 'Mercado', totalCents: 1000, date: '2026-04-14' }),
    ).rejects.toThrow('recalc-down')
    expect(state.txDeletesEq).toEqual(['tx-1'])
    expect(state.txDeletesIn).toEqual([])
  })
})

describe('whenInputInvalid_thenRejectsBeforeAnyQuery', () => {
  it('descrição vazia, cents fracionados/negativos, parcelas fora de 2..24, data inválida', async () => {
    setup(makeState())
    const { createCardPurchase, createInstallmentPurchase } = await import('../credit-cards.service')

    await expect(
      createCardPurchase(card, { description: '  ', totalCents: 100, date: '2026-04-14' }),
    ).rejects.toThrow()
    await expect(
      createCardPurchase(card, { description: 'X', totalCents: 10.5, date: '2026-04-14' }),
    ).rejects.toThrow()
    await expect(
      createCardPurchase(card, { description: 'X', totalCents: -1, date: '2026-04-14' }),
    ).rejects.toThrow()
    await expect(
      createCardPurchase(card, { description: 'X', totalCents: 100, date: '14/04/2026' }),
    ).rejects.toThrow()
    await expect(
      createInstallmentPurchase(card, {
        description: 'TV',
        totalCents: 1000,
        count: 1,
        firstDate: '2026-04-14',
      }),
    ).rejects.toThrow()
    await expect(
      createInstallmentPurchase(card, {
        description: 'TV',
        totalCents: 1000,
        count: 25,
        firstDate: '2026-04-14',
      }),
    ).rejects.toThrow()
    expect(sbMocks.from).not.toHaveBeenCalled()
  })
})

describe('whenInvoiceInsertRaces_thenWinnerIsReused', () => {
  it('23505 no insert → re-select devolve a fatura vencedora sem mutar ou duplicar', async () => {
    const state = makeState()
    setup(state)
    const baseFrom = sbMocks.from.getMockImplementation()
    if (!baseFrom) throw new Error('setup ausente')
    let attempts = 0
    sbMocks.from.mockImplementation((table: string) => {
      const base = baseFrom(table) as Record<string, (...args: unknown[]) => unknown>
      if (table !== 'invoices') return base
      return {
        ...base,
        insert: (payload: Row) => {
          attempts += 1
          if (attempts === 1) {
            state.invoiceInserts.push(payload)
            state.invoices.push({
              id: 'inv-winner',
              user_id: 'u1',
              credit_card_id: card.id,
              period_start: '2026-03-16',
              period_end: '2026-04-15',
              due_date: '2026-04-22',
              status: 'open',
              total_cents: 0,
              paid_cents: 0,
            })
            return {
              select: () => ({
                single: async () => ({
                  data: null,
                  error: { code: '23505', message: 'duplicate key value violates unique constraint' },
                }),
              }),
            }
          }
          return base.insert(payload)
        },
      }
    })
    const { createCardPurchase } = await import('../credit-cards.service')

    await createCardPurchase(card, { description: 'Mercado', totalCents: 1000, date: '2026-04-14' })

    expect(state.invoiceInserts).toHaveLength(1)
    expect(state.txInserts[0]).toMatchObject({ invoice_id: 'inv-winner' })
    expect(state.rpcCalls).toEqual([
      { name: 'recalc_invoice_total', args: { p_invoice: 'inv-winner' } },
    ])
  })
})

describe('whenTargetInvoiceBelongsToAnotherCard_thenRejects', () => {
  it('invoice-card-mismatch: nenhuma tx gravada', async () => {
    const state = makeState({
      invoices: [
        {
          id: 'inv-b',
          user_id: 'u1',
          credit_card_id: 'card-2',
          period_start: '2026-04-01',
          period_end: '2026-04-30',
          due_date: '2026-05-10',
          status: 'open',
          total_cents: 0,
          paid_cents: 0,
        },
      ],
    })
    setup(state)
    const { createCardPurchase, InvoiceCardMismatchError } = await import('../credit-cards.service')

    await expect(
      createCardPurchase(card, {
        description: 'Mercado',
        totalCents: 1000,
        date: '2026-04-14',
        targetInvoiceId: 'inv-b',
      }),
    ).rejects.toBeInstanceOf(InvoiceCardMismatchError)
    expect(state.txInserts).toHaveLength(0)
  })
})
