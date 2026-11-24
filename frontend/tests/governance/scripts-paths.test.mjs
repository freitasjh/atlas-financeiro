import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../helpers/scan.ts'
import { readFileSync } from 'node:fs'

const scripts = [
  'scripts/build-tokens.mjs',
  'scripts/check-internal.mjs',
  'scripts/check-template-overwrite.mjs',
]
const read = (rel) => readFileSync(`${REPO_ROOT}/${rel}`, 'utf8')

describe('BIGBANG-10 — scripts de build/governança reescritos', () => {
  it('0 path de código src/ nos 3 scripts reescritos', () => {
    for (const rel of scripts) {
      const normalized = read(rel).replaceAll('frontend/src/', 'ROOT_SRC/')
      const codePaths = normalized.match(/(?<![\w./-])(?:\.\/)?src\/[A-Za-z0-9._/-]+/g) ?? []
      expect(codePaths, `${rel} ainda aponta para src/`).toEqual([])
    }
  })

  it('check-internal preserva G-01..G-10 sobre frontend/src', () => {
    const text = read('scripts/check-internal.mjs')
    expect(text).toContain("const SOURCE_DIR = 'frontend/src'")
    for (let n = 1; n <= 10; n += 1) {
      const id = n < 10 ? `G-0${n}` : 'G-10'
      expect(text, `${id} ausente`).toContain(id)
    }
    expect(text).toContain('frontend/src/internal/data')
  })

  it('build-tokens gera CSS em frontend/', () => {
    const text = read('scripts/build-tokens.mjs')
    expect(text).toContain('frontend/tokens-generated.css')
    expect(text).toContain('frontend/tokens-shadcn.css')
  })

  it('init.mjs é scaffolder externo: semântica preservada (decisão reportada)', () => {
    const text = read('scripts/init.mjs')
    expect(text).toContain('--target')
    expect(text).toContain('createRepo')
  })
})
