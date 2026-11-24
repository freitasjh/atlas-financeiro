// DEBT-SUPABASE — gate de dívida localizada (ADR-002)
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { DEBT_MARKER, debtHits, findForbidden, REPO_ROOT, type FrontendFile } from './helpers/scan'
import { tokenMatchesApp } from '../src/session/session'

const cliente = {
  context: 'cliente' as const,
  issuer: 'atlas-cliente',
  audience: 'atlas-cliente-api',
}

describe('correção de review — 🟡1 SEC-01 sobrevive ao root único', () => {
  it('deny de projeto intacto e nenhum allow de repo inteiro', () => {
    const cfg = readFileSync(`${REPO_ROOT}/vite.config.ts`, 'utf8')
    expect(cfg).toContain('projectRootDenyPattern')
    expect(cfg).toContain('fs: {')
    expect(cfg).toContain('deny: [...FS_DENY_PATTERNS]')
    expect(cfg.includes('allow: [repoRoot]')).toBe(false)
  })
})

describe('correção de review — 🟡2 token malformado não lança', () => {
  it('tokenMatchesApp com token inválido devolve false', () => {
    expect(tokenMatchesApp('a.b.c', cliente)).toBe(false)
  })
})

describe('correção de review — 🟡3 positive control do scanner dividido', () => {
  it('findForbidden pega tokens globais; debtHits pega o token de dívida', () => {
    const remote = 'supa' + 'base'
    const persist = 'local' + 'Storage'
    const adapter = 'Express' + 'Adapter'
    const fixtures: FrontendFile[] = [
      { abs: '/x/a.ts', rel: 'a.ts', text: `${persist}.setItem()` },
      { abs: '/x/b.ts', rel: 'b.ts', text: `new ${adapter}()` },
    ]
    const hits = findForbidden(fixtures)
    expect(hits.map((h) => h.token).sort()).toEqual(['adapter', 'persistA'])
    expect(hits.map((h) => h.file).sort()).toEqual(['a.ts', 'b.ts'])

    // Controle do token `remote` migrado: fora da zona => acusa.
    const debt = debtHits([{ abs: '/x/c.ts', rel: 'config.ts', text: `import ${remote} from 'x'` }])
    expect(debt.map((h) => h.token)).toEqual(['remote'])
    expect(DEBT_MARKER).toContain('SUPABASE')
  })
})
