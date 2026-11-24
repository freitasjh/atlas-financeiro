import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { frontendPath, REPO_ROOT } from '../helpers/scan'
import { readFileSync as read } from 'node:fs'

const doc = () => read(frontendPath('docs/migration-rule.md'), 'utf8')

describe('BIGBANG-06/13 — regra de migração futura e preço do big-bang', () => {
  it('documento mantém os 5 passos para a fatia 2', () => {
    const text = doc()
    const steps = text.split('\n').filter((line) => /^\d+\.\s/.test(line.trim()))
    expect(steps).toHaveLength(5)
    for (const keyword of ['pinar', 'v1', 'dois lados', 'aprovação', 'rollback']) {
      expect(text.toLowerCase()).toContain(keyword)
    }
  })

  it('rótulo M2 (override), 0 tela migrada nesta fatia e rollback por VCS', () => {
    const text = doc()
    expect(text).toContain('M2')
    expect(text).toContain('2026-11-23')
    expect(text.toLowerCase()).toContain('0 tela')
    expect(text).toContain('controle de versão')
    expect(existsSync(join(REPO_ROOT, 'src'))).toBe(false)
  })

  it('sem alegação de isolamento', () => {
    const lower = doc().toLowerCase()
    expect(lower.includes('frontend desacoplado')).toBe(false)
    expect(lower.includes('isolamento verificado')).toBe(false)
  })
})
