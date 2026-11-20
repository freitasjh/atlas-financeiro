import { describe, expect, it } from 'vitest'
import {
  computeTreasuryMetrics,
  institutionInfo,
  type AccountViewItem,
} from '../view-model'

function item(overrides: Partial<AccountViewItem> = {}): AccountViewItem {
  return {
    id: 'acc-1',
    nickname: 'Conta Um',
    institution: 'itau',
    type: 'checking',
    agency: '0001',
    accountNumber: '12345',
    accountDigit: '0',
    currentBalanceCents: 100000,
    reconciledBalanceCents: 100000,
    blockedBalanceCents: 0,
    isDefault: false,
    connectionStatus: 'connected',
    ...overrides,
  }
}

describe('whenMetricsAreComputed_thenCentsAreSummedAsIntegers', () => {
  it('soma consolidado/disponível/bloqueado sem float', () => {
    const metrics = computeTreasuryMetrics([
      item({ currentBalanceCents: 18452040, blockedBalanceCents: 0 }),
      item({ id: 'acc-2', currentBalanceCents: 6241080, blockedBalanceCents: 250000 }),
    ])

    expect(metrics.totalConsolidatedBalanceCents).toBe(24693120)
    expect(metrics.totalBlockedBalanceCents).toBe(250000)
    expect(metrics.totalAvailableBalanceCents).toBe(24443120)
    expect(Number.isInteger(metrics.totalConsolidatedBalanceCents)).toBe(true)
  })

  it('vazio zera tudo e marca projeções como ausentes', () => {
    const metrics = computeTreasuryMetrics([])

    expect(metrics.totalConsolidatedBalanceCents).toBe(0)
    expect(metrics.hasProjections).toBe(false)
  })

  it('projeções seguem ausentes sem dados reais', () => {
    const metrics = computeTreasuryMetrics([item()])

    expect(metrics.projectedInflow15DaysCents).toBe(0)
    expect(metrics.projectedOutflow15DaysCents).toBe(0)
    expect(metrics.monthYieldCDICents).toBe(0)
    expect(metrics.hasProjections).toBe(false)
  })
})

describe('whenInstitutionIsUnknown_thenFallbackStaysGeneric', () => {
  it('código conhecido resolve catálogo', () => {
    expect(institutionInfo('itau').compe).toBe('341')
    expect(institutionInfo('itau').iconInitials).toBe('IT')
  })

  it('other usa entrada genérica sem quebrar', () => {
    const info = institutionInfo('other')
    expect(info.compe).toBe('---')
    expect(info.iconInitials).toHaveLength(2)
  })
})
