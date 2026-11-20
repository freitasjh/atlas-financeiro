// O1.3/O2 — trava de fronteira: o módulo budgets compõe SÓ primitivos
// `@/components/shadcn/ui/*` (SPEC §7). Núcleo (model/service/store/hooks)
// nunca importa UI; components/pages nunca importam fora de /ui.

import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const MODULE_ROOT = join(__dirname, '..')
const CORE_DIRS = ['model', 'service', 'store', 'hooks']
const UI_DIRS = ['components', 'pages']

function listFiles(dir: string): string[] {
  const entries = readdirSync(dir)
  const files: string[] = []
  for (const entry of entries) {
    if (entry === '__tests__') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) files.push(...listFiles(full))
    else if (full.endsWith('.ts') || full.endsWith('.tsx')) files.push(full)
  }
  return files
}

function filesIn(dirs: string[]): string[] {
  return dirs.flatMap((dir) => listFiles(join(MODULE_ROOT, dir)))
}

describe('whenBudgetsModuleCompiles_thenShadcnBoundaryHolds', () => {
  it('núcleo nunca importa UI (shadcn, sonner, router, i18n-react)', () => {
    const offenders: string[] = []
    for (const file of filesIn(CORE_DIRS)) {
      const source = readFileSync(file, 'utf8')
      if (/@\/components\/shadcn|from 'sonner'|from 'react-router|from 'react-i18next/.test(source)) {
        offenders.push(file)
      }
    }
    expect(offenders).toEqual([])
  })

  it('components/pages compõem SÓ primitivos de @/components/shadcn/ui', () => {
    const offenders: string[] = []
    for (const file of filesIn(UI_DIRS)) {
      const source = readFileSync(file, 'utf8')
      const imports = [...source.matchAll(/from '(@\/components\/shadcn[^']*)'/g)].map((m) => m[1])
      for (const imp of imports) {
        if (!imp.startsWith('@/components/shadcn/ui/')) offenders.push(`${file} -> ${imp}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
