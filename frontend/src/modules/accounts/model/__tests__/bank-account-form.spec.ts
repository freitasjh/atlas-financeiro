import { describe, expect, it } from 'vitest'
import { buildAccountCreateInput } from '../bank-account-form'

const baseValues = {
  nickname: 'Itaú • Matriz',
  type: 'checking' as const,
  institution: 'itau' as const,
  agency: '1234',
  accountNumber: '56789',
  accountDigit: '0',
  initialBalanceRaw: '1.234,56',
  connectionMethod: 'open_finance' as const,
  isDefault: false,
}

describe('whenFormHasCommaBalance_thenCentsAreInteger', () => {
  it('converte "1.234,56" em 123456 cents (sem float)', () => {
    const result = buildAccountCreateInput(baseValues)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.input.initial_balance_cents).toBe(123456)
    expect(Number.isInteger(result.input.initial_balance_cents)).toBe(true)
    expect(result.input.connection_status).toBe('connected')
    expect(result.input.institution).toBe('itau')
    expect(result.input.agency).toBe('1234')
    expect(result.input.account_number).toBe('56789')
    expect(result.input.account_digit).toBe('0')
  })
})

describe('whenBalanceIsEmpty_thenStartsAtZero', () => {
  it('saldo vazio vira 0 cents', () => {
    const result = buildAccountCreateInput({ ...baseValues, initialBalanceRaw: '' })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.input.initial_balance_cents).toBe(0)
  })
})

describe('whenBalanceIsInvalid_thenFormRejects', () => {
  it('"12,345" é inválido (mais de 2 casas)', () => {
    const result = buildAccountCreateInput({ ...baseValues, initialBalanceRaw: '12,345' })

    expect(result).toEqual({ ok: false, error: 'invalid-balance' })
  })

  it('valor negativo é rejeitado', () => {
    const result = buildAccountCreateInput({ ...baseValues, initialBalanceRaw: '-10,00' })

    expect(result).toEqual({ ok: false, error: 'invalid-balance' })
  })
})

describe('whenNicknameIsBlank_thenFormRejects', () => {
  it('apelido vazio vira name-required', () => {
    const result = buildAccountCreateInput({ ...baseValues, nickname: '   ' })

    expect(result).toEqual({ ok: false, error: 'name-required' })
  })
})
