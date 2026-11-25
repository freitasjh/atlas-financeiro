// DEBT-SUPABASE — gate de dívida localizada (ADR-002)
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import {
  DEBT_DOC,
  DEBT_MANIFEST_PATH,
  DEBT_MARKER,
  debtHits,
  debtManifest,
  frontendPath,
  secretPatternHits,
  type FrontendFile,
} from '../helpers/scan'

const doc = () => readFileSync(frontendPath(DEBT_DOC), 'utf8')

describe('BIGBANG-06 — dívida Supabase localizada, não isolamento', () => {
  it('doc tem marcador, dono e data de revisão', () => {
    const text = doc()
    expect(text).toContain(DEBT_MARKER)
    expect(text).toMatch(/dono:\s*\S+/i)
    expect(text).toMatch(/data de revisão:\s*\d{4}-\d{2}-\d{2}/i)
  })

  it('doc diz a verdade: alvo de dados, sem prova de desacoplamento', () => {
    const text = doc()
    expect(text).toContain('Supabase é alvo de dados; não há prova de desacoplamento')
    expect(text.toLowerCase()).toContain('contradição')
    for (const phrase of ['isolamento verificado', 'frontend desacoplado']) {
      expect(text.toLowerCase().includes(phrase)).toBe(false)
    }
  })

  it('manifesto é real e auditável: inventário gerado por varredura, não tautologia', () => {
    const manifest = debtManifest()
    expect(existsSync(frontendPath(DEBT_MANIFEST_PATH))).toBe(true)
    expect(manifest.files.length).toBeGreaterThanOrEqual(100)
    for (const pinned of [
      'src/boot/auth-hash-bootstrap.ts',
      'src/components/auth/SignupForm.tsx',
      'src/internal/data/internal-client.ts',
      'src/modules/accounts/service/accounts.service.ts',
      'src/lib/supabase.ts',
      DEBT_DOC,
    ]) {
      expect(manifest.files, `${pinned} ausente do inventário`).toContain(pinned)
    }
    const token = 'supa' + 'base'
    for (const rel of manifest.files) {
      const abs = frontendPath(rel)
      expect(existsSync(abs), `${rel} inexistente`).toBe(true)
      expect(readFileSync(abs, 'utf8').toLowerCase().includes(token), `${rel} sem acoplamento`).toBe(true)
    }
    expect(doc()).toContain(DEBT_MANIFEST_PATH)
    expect(doc().includes('confinado a frontend/src/**')).toBe(false)
  })

  it('debtHits acusa leak plantado fora do manifesto e não acusa arquivo pinado', () => {
    const token = 'supa' + 'base'
    const inside: FrontendFile[] = [
      { abs: '/x/a.ts', rel: 'src/boot/auth-hash-bootstrap.ts', text: `from '${token}'` },
    ]
    const outside: FrontendFile[] = [
      { abs: '/x/b.ts', rel: 'src/modules/acme/leak.ts', text: `import { ${token} } from 'x'` },
    ]
    expect(debtHits(inside)).toEqual([])
    expect(debtHits(outside).map((h) => h.file)).toEqual(['src/modules/acme/leak.ts'])
  })

  it('root real: 0 hit fora do manifesto e 0 padrão de credencial', () => {
    expect(debtHits()).toEqual([])
    expect(secretPatternHits()).toEqual([])
  })
})
