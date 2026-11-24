import { describe, expect, it } from 'vitest'
import { sectionOf, specText } from '../helpers/scan'

describe('BIGBANG-13 — premissas P-F..P-J sem virar fato', () => {
  it('SPEC §11 traz as 5 premissas com o mesmo tratamento do ADR', () => {
    const sec = sectionOf(specText(), 11)
    for (const p of ['P-F', 'P-G', 'P-H', 'P-I', 'P-J']) {
      expect(sec, `premissa ${p} ausente`).toContain(p)
    }
    expect(sec).toContain('Inferência de implementação')
    expect(sec).toContain('Dívida aberta declarada')
    expect(sec).toContain('Dependência externa confirmada')
  })

  it('§12 mantém 4 bloqueantes e 4 dívidas', () => {
    const sec = sectionOf(specText(), 12)
    for (const label of [
      'BLOQUEANTE-EMISSÃO',
      'BLOQUEANTE-ENDPOINT',
      'BLOQUEANTE-ÍNDICE',
      'F4',
    ]) {
      expect(sec, `bloqueante ${label} ausente`).toContain(label)
    }
    expect(sec.match(/\*\*Dívida/g)).toHaveLength(4)
  })
})
