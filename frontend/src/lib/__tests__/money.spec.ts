import { describe, expect, it } from 'vitest'
import { parseBRLToCents, maskCentsInput } from '../money'

describe('whenInputUsesPtBrFormat_thenCentsAreInteger', () => {
  it('aceita vírgula decimal e ponto de milhar', () => {
    expect(parseBRLToCents('1.234,56')).toBe(123456)
    expect(parseBRLToCents('1234,56')).toBe(123456)
    expect(parseBRLToCents('1.234')).toBe(123400)
    expect(parseBRLToCents('R$ 12,00')).toBe(1200)
  })
})

describe('whenInputUsesEnUsDecimalDot_thenCentsAreInteger', () => {
  it('aceita ponto decimal (en-US)', () => {
    expect(parseBRLToCents('1234.56')).toBe(123456)
    expect(parseBRLToCents('12.5')).toBe(1250)
    expect(parseBRLToCents('0.09')).toBe(9)
  })

  it('ponto de milhar continua ambíguo resolvido como milhar', () => {
    expect(parseBRLToCents('1.234.567')).toBe(123456700)
  })
})

describe('whenInputIsInvalid_thenReturnsNull', () => {
  it('rejeita formatos fora do contrato', () => {
    expect(parseBRLToCents('')).toBeNull()
    expect(parseBRLToCents('abc')).toBeNull()
    expect(parseBRLToCents('12,345')).toBeNull()
    expect(parseBRLToCents('1.23.456')).toBeNull()
    expect(parseBRLToCents('12.3456')).toBeNull()
    expect(parseBRLToCents('-10,00')).toBeNull()
  })
})

describe('whenMaskCentsInput_thenFormatsDigitsAsBRL', () => {
  it('digita 1500 -> 15,00', () => {
    expect(maskCentsInput('1500')).toBe('15,00')
  })
  it('digita 123456 -> 1.234,56', () => {
    expect(maskCentsInput('123456')).toBe('1.234,56')
  })
  it('descarta não dígitos', () => {
    expect(maskCentsInput('15,00')).toBe('15,00')
    expect(maskCentsInput('abc')).toBe('')
  })
  it('vazio -> vazio', () => {
    expect(maskCentsInput('')).toBe('')
  })
})
