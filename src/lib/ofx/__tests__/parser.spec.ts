import { describe, expect, it } from 'vitest'
import { parseOfx } from '../parser'
import { BB_FIXTURE, ITAU_FIXTURE, NUBANK_QFX_FIXTURE, MALFORMED_FIXTURE } from './fixtures'

// O1.2 — TDD: parser SGML próprio, 3 fixtures reais, malformado listado.
describe('whenParsingBbFixture_thenAllValidLinesAreExtracted', () => {
  it('BB: 100% linhas válidas parseadas', () => {
    const result = parseOfx(BB_FIXTURE)
    expect(result.errors).toHaveLength(0)
    expect(result.transactions).toHaveLength(3)
    expect(result.transactions[0]).toMatchObject({ trntype: 'DEBIT', fitid: 'BB20261101001' })
  })
})

describe('whenParsingItauFixture_thenAccentsPreserved', () => {
  it('Itaú: MEMO com acentos preservado', () => {
    const result = parseOfx(ITAU_FIXTURE)
    expect(result.errors).toHaveLength(0)
    expect(result.transactions).toHaveLength(2)
    expect(result.transactions[0].memo).toContain('ENERGIA')
  })
})

describe('whenParsingNubankQfx_thenQfxIsAccepted', () => {
  it('Nubank QFX: parseia como OFX', () => {
    const result = parseOfx(NUBANK_QFX_FIXTURE)
    expect(result.errors).toHaveLength(0)
    expect(result.transactions).toHaveLength(2)
  })
})

describe('whenLinesAreMalformed_thenErrorsAreListedNeverSilent', () => {
  it('lista OfxParseError{line,reason} sem engolir', () => {
    const result = parseOfx(MALFORMED_FIXTURE)
    expect(result.transactions).toHaveLength(1)
    expect(result.errors.length).toBeGreaterThanOrEqual(2)
    for (const err of result.errors) {
      expect(err.line).toBeGreaterThan(0)
      expect(typeof err.reason).toBe('string')
      expect(err.reason.length).toBeGreaterThan(0)
    }
  })
})
