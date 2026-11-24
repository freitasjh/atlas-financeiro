import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { FORBIDDEN, frontendPath, REPO_ROOT } from '../helpers/scan'

const read = (p: string) => readFileSync(p, 'utf8')

describe('BIGBANG-03 — porta 5173 única, porta legada extinta, hash preservado', () => {
  it('root fixa 5173 com strictPort false', () => {
    const cfg = read(`${REPO_ROOT}/vite.config.ts`)
    expect(cfg).toContain('port: 5173')
    expect(cfg).toContain('strictPort: false')
    expect(cfg.includes('517' + '4')).toBe(false)
  })

  it('0 segundo bootstrap: sem porta legada, strictPort true, adapter ou proxy', () => {
    const adapter = 'Express' + 'Adapter'
    const proxy = 'server' + '.proxy'
    const browser = 'createBrowser' + 'Router'
    for (const file of [`${REPO_ROOT}/vite.config.ts`, frontendPath('src/router.tsx'), frontendPath('main.tsx')]) {
      const text = read(file)
      const legacyPort = '517' + '4'
      const strict = 'strictPort: ' + 'true'
      for (const token of [legacyPort, strict, adapter, proxy, browser]) {
        expect(text.includes(token), `${file} contém ${token}`).toBe(false)
      }
    }
  })

  it('apps Nest permanecem em 3001/3002 via PORT', () => {
    for (const [app, port] of [['cliente', '3001'], ['control-plane', '3002']] as const) {
      const main = read(`${REPO_ROOT}/backend/apps/${app}/src/main.ts`)
      expect(main).toContain(port)
      expect(main).toContain('PORT')
    }
  })

  it('bootstrap usa hash router e não admite browser router/proxy/adapter', () => {
    const main = read(frontendPath('main.tsx'))
    const router = read(frontendPath('src/router.tsx'))
    expect(router).toContain('createHashRouter')
    expect(main).toContain('RouterProvider')
    for (const key of ['browserRouter', 'proxy', 'adapter'] as const) {
      expect(main.toLowerCase().includes(FORBIDDEN[key]!.toLowerCase()), main).toBe(false)
    }
  })
})
