import { describe, expect, it } from 'vitest'
import { normalizeTxn, trnAmtToSignedCents, ofxDateToIso } from '../normalize'

// O1.3 — TDD: data YYYYMMDD→date local meio-dia sem new Date(string); string→cents sem float.
describe('whenTrnAmtIsParsed_thenNoFloatIsUsed', () => {
  it('centavos exatos via split de string', () => {
    expect(trnAmtToSignedCents('-150.00')).toBe(-15000)
    expect(trnAmtToSignedCents('2500.50')).toBe(250050)
    expect(trnAmtToSignedCents('12.5')).toBe(1250)
    expect(trnAmtToSignedCents('100')).toBe(10000)
    expect(trnAmtToSignedCents('+7.07')).toBe(707)
  })

  it('-0.01 vira -1 centavo', () => {
    expect(trnAmtToSignedCents('-0.01')).toBe(-1)
  })

  it('rejeita formato inválido sem NaN silencioso', () => {
    expect(() => trnAmtToSignedCents('abc')).toThrow()
    expect(() => trnAmtToSignedCents('')).toThrow()
    expect(() => trnAmtToSignedCents('12.345')).toThrow()
  })
})

describe('whenOfxDateIsParsed_thenLocalNoonIsoDate', () => {
  it('YYYYMMDD vira YYYY-MM-DD sem Date(string)', () => {
    expect(ofxDateToIso('20261101')).toBe('2026-11-01')
    expect(ofxDateToIso('20261105120000')).toBe('2026-11-05')
  })

  it('timezone não desloca o dia (string pura)', () => {
    // Independe de TZ: saída é string fatiada, sem new Date().
    expect(ofxDateToIso('20261101')).not.toContain('T')
  })

  it('rejeita data inválida', () => {
    expect(() => ofxDateToIso('20261301')).toThrow()
    expect(() => ofxDateToIso('nope')).toThrow()
  })
})

describe('whenRawTxnIsNormalized_thenTypeBySignAndTransferFalse', () => {
  it('sinal negativo vira expense, positivo vira income', () => {
    const neg = normalizeTxn(
      { line: 1, trntype: 'DEBIT', dtposted: '20261101', trnamt: '-150.00', fitid: 'F1', memo: 'Mercado' },
      'acc-1',
    )
    expect(neg.type).toBe('expense')
    expect(neg.amount_cents).toBe(15000)
    expect(neg.is_transfer).toBe(false)
    expect(neg.date).toBe('2026-11-01')

    const pos = normalizeTxn(
      { line: 2, trntype: 'CREDIT', dtposted: '20261105', trnamt: '2500.50', fitid: 'F2', memo: 'Salario' },
      'acc-1',
    )
    expect(pos.type).toBe('income')
    expect(pos.amount_cents).toBe(250050)
  })
})
