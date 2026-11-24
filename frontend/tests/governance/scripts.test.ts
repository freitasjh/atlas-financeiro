import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { exists, gitDiff, REPO_ROOT, sectionOf, specText } from '../helpers/scan'

const pkg = () => JSON.parse(readFileSync(`${REPO_ROOT}/package.json`, 'utf8'))

describe('BIGBANG-02 — scripts canônicos no root, sem package aditivo', () => {
  it('root expõe dev/build/preview/typecheck/test:run/test:gate', () => {
    const scripts = pkg().scripts
    for (const name of ['dev', 'build', 'preview', 'typecheck', 'test:run', 'test:gate']) {
      expect(scripts[name], `script ${name} ausente`).toBeTruthy()
    }
    expect(scripts.typecheck).toBe('tsc --noEmit')
  })

  it('não existe segundo package.json com scripts próprios', () => {
    expect(exists('package.json')).toBe(false)
  })

  it('harness intocado; SPEC §15 registra NENHUM delta de config', () => {
    expect(gitDiff(['harness.config.json']).trim()).toBe('')
    const delta = sectionOf(specText(), 15)
    expect(delta).toContain('harness.config.json')
    expect(delta).toContain('NENHUM')
    expect(delta).toContain('product-manager')
  })
})
