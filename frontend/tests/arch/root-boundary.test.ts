import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { exists, FRONTEND_ROOT, legacyImports, REPO_ROOT, sourceFiles } from '../helpers/scan'

describe('BIGBANG-01 — big-bang aplicado: src/ inexistente, único root', () => {
  it('src/ não existe e a árvore movida está em frontend/src', () => {
    expect(existsSync(join(REPO_ROOT, 'src'))).toBe(false)
    expect(exists('src/router.tsx')).toBe(true)
    expect(exists('src/internal/data/internal-client.ts')).toBe(true)
  })

  it('≥604 arquivos em frontend/ e contrato/sessão sobrevivem', () => {
    const count = sourceFiles().length
    expect(count).toBeGreaterThanOrEqual(604)
    expect(exists('src/contract/v1.ts')).toBe(true)
    expect(exists('src/session/session.ts')).toBe(true)
  })

  it('entry sobrevivente usa hash, não browser router', () => {
    const entry = sourceFiles().find((f) => f.rel === 'main.tsx')
    const router = sourceFiles().find((f) => f.rel === 'src/router.tsx')
    expect(entry?.text).toContain('RouterProvider')
    expect(router?.text).toContain('createHashRouter')
    const browser = 'createBrowser' + 'Router'
    for (const text of [entry?.text ?? '', router?.text ?? '']) {
      expect(text.toLowerCase().includes(browser.toLowerCase())).toBe(false)
    }
  })

  it('nenhum import relativo escapa do root único', () => {
    expect(legacyImports()).toEqual([])
    expect(FRONTEND_ROOT.startsWith(REPO_ROOT + '/')).toBe(true)
  })
})
