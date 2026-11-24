import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { REPO_ROOT, sectionOf, specText } from '../helpers/scan'

const roadmap = () => readFileSync(`${REPO_ROOT}/ROADMAP.md`, 'utf8')

describe('BIGBANG-10 — RF de ROADMAP registrada e dívida visível no documento', () => {
  it('SPEC §15 registra as entradas com dono product-manager', () => {
    const delta = sectionOf(specText(), 15)
    for (const entry of ['stack-context.md', 'ROADMAP.md', 'harness.config.json']) {
      expect(delta, `entrada ${entry} ausente em §15`).toContain(entry)
    }
    expect(delta).toContain('product-manager')
  })

  it('ROADMAP registra a dívida em vez de alegar isolamento', () => {
    const text = roadmap()
    expect(text).toContain('Dívida arquitetural explícita')
    expect(text).toContain('Big-bang frontend')
    expect(text).toContain('isolamento verificado')
    expect(text).toContain('EM EXECUÇÃO')
  })
})
