// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const DIR = join(__dirname, '..', '..', '..', 'components', 'shadcn')

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

// O1.3 — trava de fronteira shadcn: galeria nunca importa a camada budgets
// (direção única modules → shadcn; mesmo padrão de categories/transactions).
const FORBIDDEN: Array<{ name: string; pattern: RegExp }> = [
  { name: 'budgets module import', pattern: /@\/modules\/budgets/ },
]

describe('whenShadcnGalleryIsScanned_thenNoBudgetsDomainCouplingExists', () => {
  it('nenhum arquivo shadcn importa @/modules/budgets', () => {
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
