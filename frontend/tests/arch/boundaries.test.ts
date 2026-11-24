// DEBT-SUPABASE — gate de dívida localizada (ADR-002)
import { describe, expect, it } from 'vitest'
import { debtHits, forbiddenHits, frontendFiles, legacyImports, sourceFiles } from '../helpers/scan'

describe('BIGBANG-08 — fronteira do root único: 0 segredo + dívida localizada', () => {
  it('varredura de assinaturas proibidas no código frontend-native dá zero', () => {
    expect(forbiddenHits()).toEqual([])
  })

  it('acoplamento herdado não vaza para fora da zona de dívida', () => {
    expect(debtHits()).toEqual([])
  })

  it('nenhum specifier aponta para fora do root único', () => {
    expect(legacyImports()).toEqual([])
  })

  it('código frontend-native não faz chamada HTTP', () => {
    const net = 'fet' + 'ch'
    const xhr = 'XMLHttp' + 'Request'
    const client = 'axi' + 'os'
    const hits = sourceFiles()
      .filter((f) => !f.rel.startsWith('src/'))
      .filter((f) => new RegExp(`\\b${net}\\s*\\(|${xhr}|\\b${client}\\b`).test(f.text))
      .map((f) => f.rel)
    expect(hits).toEqual([])
  })

  it('toda a suíte é varrida (inclusive este arquivo)', () => {
    const rels = frontendFiles().map((f) => f.rel)
    expect(rels.some((r) => r.includes('boundaries.test'))).toBe(true)
    expect(rels.length).toBeGreaterThan(0)
  })
})
