import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { exists, frontendPath, REPO_ROOT } from '../helpers/scan'

const read = (p: string) => readFileSync(p, 'utf8')

describe('BIGBANG-02 — root único, bootstrap aditivo removido', () => {
  it('entry raiz aponta para o entry sobrevivente em frontend/', () => {
    const html = read(`${REPO_ROOT}/index.html`)
    expect(html).toContain('/frontend/main.tsx')
    expect(html.includes('/src/main.tsx')).toBe(false)
  })

  it('alias @ e include do tsconfig apontam para frontend', () => {
    const alias = read(`${REPO_ROOT}/vite.config.ts`)
    expect(alias).toContain("'./frontend/src'")
    const ts = JSON.parse(read(`${REPO_ROOT}/tsconfig.json`))
    expect(ts.compilerOptions.paths['@/*']).toEqual(['./frontend/src/*'])
    expect(ts.include.some((p: string) => p.startsWith('frontend'))).toBe(true)
    expect(ts.include).not.toContain('src')
  })

  it('segundo bootstrap/config/package não existem', () => {
    for (const file of ['vite.config.ts', 'index.html', 'package.json', 'src/main.tsx']) {
      expect(exists(file), `frontend/${file} ainda presente`).toBe(false)
    }
  })

  it('entry sobrevivente usa hash router e não há main duplicado', () => {
    const main = read(frontendPath('main.tsx'))
    const router = read(frontendPath('src/router.tsx'))
    expect(router).toContain('createHashRouter')
    expect(main).toContain('RouterProvider')
    expect(exists('main.tsx')).toBe(true)
    expect(exists('src/main.tsx')).toBe(false)
  })
})
