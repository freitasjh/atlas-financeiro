import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEBT_MARKER, REPO_ROOT, secretPatternHits, bundleFiles } from '../helpers/scan.ts'

describe('BIGBANG-12 — aceite do corte (dívida visível, sem green-falso)', () => {
  it('src/ inexistente', () => {
    expect(existsSync(join(REPO_ROOT, 'src'))).toBe(false)
  })

  it('dívida localizada e documento com marcador', () => {
    const doc = readFileSync(join(REPO_ROOT, 'frontend/docs/debt-supabase.md'), 'utf8')
    expect(doc).toContain(DEBT_MARKER)
    expect(secretPatternHits()).toEqual([])
  })

  it('bundle sem material de credencial', () => {
    const hits = secretPatternHits(bundleFiles())
    expect(hits).toEqual([])
  })

  it('harness.config.json intocado', () => {
    const cfg = readFileSync(join(REPO_ROOT, 'harness.config.json'), 'utf8')
    expect(cfg).not.toContain('517' + '4')
    expect(cfg).toContain('npm run test:gate && npm run build && npm run typecheck')
  })
})
