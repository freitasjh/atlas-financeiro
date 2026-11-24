import { describe, expect, it } from 'vitest'
import {
  CARD_BRANDS,
  CARD_THEMES,
  canEditInvoiceExpenses,
  CardThemeSchema,
  consolidatedVerdict,
  DEFAULT_CARD_THEME,
  creditCardInputToInsert,
  creditCardRowToView,
  creditCardSchemaIdentity,
  creditCardSchema,
  creditCardUpdateSchema,
  detectCardBrand,
  cardIdentityFromPAN,
  displayInvoiceStatus,
  InvalidCardNumberError,
  remainingCents,
  validateLuhn,
} from '../credit-card'

// C1.1 — model zod + adapter + status + veredito (TDD: teste antes do código).

describe('whenCreditCardInputIsValidated_thenNameLimitAndCycleRulesHold', () => {
  const base = {
    name: '  Cartão final 1234  ',
    brand: 'visa',
    account_id: '11111111-1111-1111-8111-111111111111',
    limit_cents: 500000,
    closing_day: 10,
    due_day: 17,
  } as const

  it('aceita entrada válida com apelido aparado (trim 1-120)', () => {
    const parsed = creditCardSchema.parse({ ...base })
    expect(parsed.name).toBe('Cartão final 1234')
    expect(parsed.brand).toBe('visa')
  })

  it('rejeita apelido vazio ou só-espaços', () => {
    expect(() => creditCardSchema.parse({ ...base, name: '   ' })).toThrow()
    expect(() => creditCardSchema.parse({ ...base, name: '' })).toThrow()
  })

  it('rejeita apelido com mais de 120 caracteres', () => {
    expect(() => creditCardSchema.parse({ ...base, name: 'x'.repeat(121) })).toThrow()
  })

  it('rejeita limit_cents zero, negativo ou fracionado (int > 0, sem float)', () => {
    for (const limit_cents of [0, -100, 10.5, Number.NaN]) {
      expect(() => creditCardSchema.parse({ ...base, limit_cents })).toThrow()
    }
  })

  it('rejeita closing_day/due_day fora de 1-31', () => {
    for (const day of [0, 32, 1.5]) {
      expect(() => creditCardSchema.parse({ ...base, closing_day: day })).toThrow()
      expect(() => creditCardSchema.parse({ ...base, due_day: day })).toThrow()
    }
  })

  it('rejeita bandeira desconhecida e objeto com chaves extras (strict)', () => {
    expect(() => creditCardSchema.parse({ ...base, brand: 'diners' })).toThrow()
    expect(() => creditCardSchema.parse({ ...base, total_cents: 1 })).toThrow()
  })

  it('update aceita patch sem account_id e nunca carrega total/paid/status', () => {
    const parsed = creditCardUpdateSchema.parse({
      name: 'Novo nome',
      limit_cents: 100,
      closing_day: 5,
      due_day: 12,
    })
    expect(parsed).not.toHaveProperty('total_cents')
    expect(parsed).not.toHaveProperty('paid_cents')
    expect(parsed).not.toHaveProperty('status')
    expect(() =>
      creditCardUpdateSchema.parse({ name: 'X', limit_cents: 1, closing_day: 1, due_day: 1, status: 'paid' }),
    ).toThrow()
  })
})

describe('whenDetectCardBrandRuns_thenBinPrefixesResolve', () => {
  it('resolve visa/mastercard/amex pelos prefixos', () => {
    expect(detectCardBrand('4111 1111 1111 1111')).toBe('visa')
    expect(detectCardBrand('5500 0000 0000 0004')).toBe('mastercard')
    expect(detectCardBrand('2223000048400011')).toBe('mastercard')
    expect(detectCardBrand('340000000000009')).toBe('amex')
    expect(detectCardBrand('370000000000002')).toBe('amex')
  })

  it('resolve elo/hipercard e cai em other quando desconhecido', () => {
    expect(detectCardBrand('5067 1111 1111 1118')).toBe('elo')
    expect(detectCardBrand('6062825627367772')).toBe('hipercard')
    expect(detectCardBrand('9999999999999999')).toBe('other')
    expect(detectCardBrand('')).toBe('other')
  })

  it('CARD_BRANDS cobre o vocabulário fechado da UI', () => {
    expect([...CARD_BRANDS].sort()).toEqual(
      ['amex', 'elo', 'hipercard', 'mastercard', 'other', 'visa'].sort(),
    )
  })
})

describe('whenCardThemeIsValidated_thenOnlyBankCheckVocabularyIsAccepted', () => {
  const CHECK_THEMES = ['midnight', 'emerald', 'violet', 'platinum', 'rose_gold'] as const

  it('aceita os 5 valores do vocabulário', () => {
    for (const theme of CARD_THEMES) {
      expect(CardThemeSchema.parse(theme)).toBe(theme)
    }
  })

  it('rejeita vazio, desconhecido, null e uppercase', () => {
    for (const invalid of ['', 'blue', null, 'MIDNIGHT']) {
      expect(CardThemeSchema.safeParse(invalid).success).toBe(false)
    }
  })

  it('CARD_THEMES tem paridade com os valores do CHECK do ADR-001', () => {
    expect([...CARD_THEMES].sort()).toEqual([...CHECK_THEMES].sort())
  })

  it('DEFAULT_CARD_THEME é platinum e pertence ao vocabulário', () => {
    expect(DEFAULT_CARD_THEME).toBe('platinum')
    expect(CARD_THEMES).toContain(DEFAULT_CARD_THEME)
  })
})

describe('whenRowThemeIsAdapted_thenInvalidValueFallsBackToPlatinum', () => {
  const row = {
    id: 'card-theme-1',
    user_id: 'u1',
    account_id: 'acc-1',
    tenant_id: null,
    name: 'Cartão tema',
    limit_cents: 100000,
    closing_day: 10,
    due_day: 17,
    created_at: '',
    updated_at: '',
  }

  it('preserva tema válido do banco na View', () => {
    expect(creditCardRowToView({ ...row, theme: 'emerald' }).theme).toBe('emerald')
  })

  it('cai em platinum para tema nulo, ausente ou inválido', () => {
    for (const theme of [null, undefined, '', 'blue', 'MIDNIGHT']) {
      expect(creditCardRowToView({ ...row, theme }).theme).toBe(DEFAULT_CARD_THEME)
    }
  })
})

function invoice(overrides: Record<string, unknown> = {}) {
  return {
    status: 'open',
    total_cents: 10000,
    paid_cents: 0,
    due_date: '2026-11-20',
    ...overrides,
  }
}

describe('whenInvoiceStatusIsDerived_thenPaidBlocksAndOverdueShows', () => {
  it('paid permanece paid independente do vencimento', () => {
    expect(displayInvoiceStatus(invoice({ status: 'paid' }), '2026-12-01')).toBe('paid')
  })

  it('partial permanece partial (Resta X vive no veredito)', () => {
    expect(displayInvoiceStatus(invoice({ status: 'partial', paid_cents: 4000 }), '2026-11-25')).toBe(
      'partial',
    )
  })

  it('closed vencida vira overdue; dentro do prazo segue closed', () => {
    expect(displayInvoiceStatus(invoice({ status: 'closed', due_date: '2026-11-10' }), '2026-11-17')).toBe(
      'overdue',
    )
    expect(displayInvoiceStatus(invoice({ status: 'closed', due_date: '2026-11-20' }), '2026-11-17')).toBe(
      'closed',
    )
  })

  it('open segue open (pagamento só após fechamento — regra de UI)', () => {
    expect(displayInvoiceStatus(invoice({ status: 'open' }), '2026-11-17')).toBe('open')
  })
})

describe('whenRemainingCentsIsComputed_thenOutstandingClampsAtZero', () => {
  it('total menos pago, nunca negativo (reabertura pode editar total)', () => {
    expect(remainingCents(invoice({ total_cents: 10000, paid_cents: 4000 }))).toBe(6000)
    expect(remainingCents(invoice({ total_cents: 3000, paid_cents: 5000 }))).toBe(0)
    expect(remainingCents(invoice({ total_cents: 0, paid_cents: 0 }))).toBe(0)
  })
})

describe('whenPaidInvoiceIsChecked_thenExpensesAreLocked', () => {
  it('só paid bloqueia edição de lançamentos (invoice-paid-locked)', () => {
    expect(canEditInvoiceExpenses('paid')).toBe(false)
    expect(canEditInvoiceExpenses('open')).toBe(true)
    expect(canEditInvoiceExpenses('closed')).toBe(true)
    expect(canEditInvoiceExpenses('partial')).toBe(true)
  })
})

describe('whenCardsConsolidate_thenVerdictSumsLimitsAndOutstanding', () => {
  const cards = [{ limit_cents: 500000 }, { limit_cents: 200000 }]

  it('soma limites e devedor (paid não compõe o aberto)', () => {
    const verdict = consolidatedVerdict(cards, [
      invoice({ status: 'open', total_cents: 10000, paid_cents: 0 }),
      invoice({ status: 'partial', total_cents: 8000, paid_cents: 3000 }),
      invoice({ status: 'paid', total_cents: 5000, paid_cents: 5000 }),
    ])
    expect(verdict).toEqual({
      cardsCount: 2,
      totalLimitCents: 700000,
      totalOutstandingCents: 15000,
      openCount: 1,
      closedCount: 0,
      partialCount: 1,
      paidCount: 1,
    })
    expect(Number.isInteger(verdict.totalOutstandingCents)).toBe(true)
  })

  it('sem cartões o veredito zera sem NaN', () => {
    expect(consolidatedVerdict([], [])).toEqual({
      cardsCount: 0,
      totalLimitCents: 0,
      totalOutstandingCents: 0,
      openCount: 0,
      closedCount: 0,
      partialCount: 0,
      paidCount: 0,
    })
  })
})

describe('whenRowIsAdapted_thenViewCarriesNicknameAndBrandIsViewOnly', () => {
  const row = {
    id: 'card-1',
    user_id: 'u1',
    account_id: 'acc-1',
    tenant_id: null,
    name: 'Cartão final 1234',
    limit_cents: 500000,
    closing_day: 10,
    due_day: 17,
    created_at: '',
    updated_at: '',
  }

  it('Row → View preserva cents inteiros e bandeira vai por parâmetro', () => {
    const view = creditCardRowToView(row, 'mastercard')
    expect(view).toMatchObject({
      id: 'card-1',
      nickname: 'Cartão final 1234',
      brand: 'mastercard',
      accountId: 'acc-1',
      limitCents: 500000,
      closingDay: 10,
      dueDay: 17,
    })
    expect(Number.isInteger(view.limitCents)).toBe(true)
  })

  it('insert do cliente nunca carrega total/paid/status nem brand', () => {
    const insert = creditCardInputToInsert(
      {
        name: 'Nu',
        brand: 'mastercard',
        account_id: '11111111-1111-1111-8111-111111111111',
        limit_cents: 1000,
        closing_day: 1,
        due_day: 8,
      },
      'u1',
    )
    expect(insert).toEqual({
      user_id: 'u1',
      account_id: '11111111-1111-1111-8111-111111111111',
      name: 'Nu',
      limit_cents: 1000,
      closing_day: 1,
      due_day: 8,
    })
  })
})

describe('whenPanIsValidated_thenOnlyLast4Survives', () => {
  it('Luhn aceita PAN de 13 a 19 dígitos e recusa curto/inválido', () => {
    expect(validateLuhn('4111111111111111')).toBe(true)
    expect(validateLuhn('5500000000000004')).toBe(true)
    expect(validateLuhn('4111111111111112')).toBe(false)
    expect(validateLuhn('123')).toBe(false)
    expect(validateLuhn('4111abcd11111111')).toBe(false)
  })

  it('cardIdentityFromPAN devolve os 4 últimos dígitos do PAN validado', () => {
    expect(cardIdentityFromPAN('4111 1111 1111 1111').last4).toBe('1111')
    expect(cardIdentityFromPAN('5500 0000 0000 0004').last4).toBe('0004')
  })

  it('PAN inválido lança erro nomeado invalid-card-number sem resíduo', () => {
    for (const pan of ['4111111111111112', '123', '']) {
      expect(() => cardIdentityFromPAN(pan)).toThrow(InvalidCardNumberError)
      try {
        cardIdentityFromPAN(pan)
      } catch (error) {
        const named = error as Error
        expect(named.name).toBe('InvalidCardNumberError')
        expect(named.message).toBe('invalid-card-number')
        if (pan !== '') expect(JSON.stringify(named)).not.toContain(pan)
      }
    }
  })

  it('last4 nunca é inferido de nome, bandeira ou apelido', () => {
    expect(cardIdentityFromPAN('4111111111111111').last4).toBe('1111')
    expect(() => cardIdentityFromPAN('Nubank Final 9999')).toThrow(InvalidCardNumberError)
  })
})

describe('whenIdentityFieldsAreInserted_thenOnlyPciSafeColumnsAreWritten', () => {
  const base = {
    name: 'Nu',
    account_id: '11111111-1111-1111-8111-111111111111',
    limit_cents: 1000,
    closing_day: 1,
    due_day: 8,
  } as const

  it('insert de identidade contém last4/holder_name/expiry_mm_aa/theme e nenhuma chave sensível', () => {
    const insert = creditCardInputToInsert(
      {
        ...base,
        last4: '1111',
        holder_name: 'JOAO SILVA',
        expiry_mm_aa: '12/29',
        theme: 'emerald',
      },
      'u1',
    )
    expect(insert).toEqual({
      user_id: 'u1',
      account_id: base.account_id,
      name: 'Nu',
      limit_cents: 1000,
      closing_day: 1,
      due_day: 8,
      last4: '1111',
      holder_name: 'JOAO SILVA',
      expiry_mm_aa: '12/29',
      theme: 'emerald',
    })
    for (const forbidden of ['number', 'cvv', 'pan', 'card_number', 'is_default']) {
      expect(Object.keys(insert)).not.toContain(forbidden)
    }
  })

  it('rejeita tema fora dos 5 e last4 fora de ^\\d{4}$', () => {
    expect(() => creditCardSchemaIdentity.parse({ ...base, theme: 'gold' })).toThrow()
    expect(() => creditCardSchemaIdentity.parse({ ...base, last4: '123' })).toThrow()
    expect(() => creditCardSchemaIdentity.parse({ ...base, last4: '12a4' })).toThrow()
    expect(() => creditCardSchemaIdentity.parse({ ...base, number: '4111111111111111' })).toThrow()
    expect(() => creditCardSchemaIdentity.parse({ ...base, cvv: '123' })).toThrow()
    expect(() => creditCardSchemaIdentity.parse({ ...base, is_default: true })).toThrow()
  })
})
