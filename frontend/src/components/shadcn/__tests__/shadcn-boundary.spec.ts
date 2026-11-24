// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const DIR = join(__dirname, '..', 'bank-accounts')

function collect(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__') continue
      out.push(...collect(full))
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full)
    }
  }
  return out
}

// P1.2 — direção única: modules → shadcn. A galeria de exemplos nunca
// importa a camada real (modules/store/supabase) nem toca em dinheiro
// de verdade (cents), RLS ou tenancy. Qualquer match = regressão.
const FORBIDDEN: Array<{ name: string; pattern: RegExp }> = [
  { name: 'modules import', pattern: /@\/modules\// },
  { name: 'store import', pattern: /@\/store\// },
  { name: 'supabase client', pattern: /@\/lib\/supabase/ },
  { name: 'supabase-js', pattern: /@supabase\/supabase-js/ },
  { name: 'cents reference', pattern: /[Cc]ents/ },
  { name: 'rls reference', pattern: /\bRLS\b/ },
  { name: 'auth.uid reference', pattern: /auth\.uid/ },
  { name: 'user_id reference', pattern: /user_id/ },
  { name: 'service_role reference', pattern: /service_role/ },
]

describe('whenShadcnGalleryIsScanned_thenNoDomainCouplingExists', () => {
  it('nenhum arquivo da galeria bank-accounts importa modules/store/supabase nem referencia cents/RLS', () => {
    const files = collect(DIR)
    expect(files.length).toBeGreaterThan(0)
    const violations: string[] = []
    for (const file of files) {
      const content = readFileSync(file, 'utf-8')
      for (const { name, pattern } of FORBIDDEN) {
        if (pattern.test(content)) violations.push(`${file} :: ${name}`)
      }
    }
    expect(violations).toEqual([])
  })
})
