// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// C1.1 — trava de fronteira (Batch 1: model/service/store/hooks).
// O núcleo de cartões compõe SÓ primitivos `@/components/shadcn/ui/*` no
// futuro (Batch 2); no Batch 1 não há components/pages. Duas garantias já:
// 1) núcleo nunca importa UI (shadcn, sonner, router, i18n-react);
// 2) nenhum arquivo do módulo importa a galeria de exemplos
//    `@/components/shadcn/credit-card` (template é referência visual, nunca
//    import — SPEC §7). Qualquer match = regressão.

const MODULE_ROOT = join(__dirname, '..')
const CORE_DIRS = ['model', 'service', 'store', 'hooks']

function listFiles(dir: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
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

describe('whenCreditCardsModuleCompiles_thenShadcnBoundaryHolds', () => {
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

  it('módulo nunca importa a galeria de exemplos credit-card (exceto componentes canônicos reutilizáveis)', () => {
    const offenders: string[] = []
    const ALLOWED_REUSABLE = new Set([
      '@/components/shadcn/credit-card/card-invoice-header',
      '@/components/shadcn/credit-card/card-selector-bar',
      '@/components/shadcn/credit-card/invoice-month-tabs',
      '@/components/shadcn/credit-card/card-expenses-table',
    ])
    for (const file of filesIn([...CORE_DIRS, 'components', 'pages'])) {
      const source = readFileSync(file, 'utf8')
      const imports = [...source.matchAll(/from '(@\/components\/shadcn[^']*)'/g)].map((m) => m[1])
      for (const imp of imports) {
        if (
          (imp === '@/components/shadcn/credit-card' || imp.startsWith('@/components/shadcn/credit-card/')) &&
          !ALLOWED_REUSABLE.has(imp)
        ) {
          offenders.push(`${file} -> ${imp}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('módulo não recria o seletor do catálogo (CardSelectorBar.tsx removido)', () => {
    expect(existsSync(join(MODULE_ROOT, 'components', 'CardSelectorBar.tsx'))).toBe(false)
  })

  it('módulo não recria o tabs de meses (InvoiceMonthTabs.tsx removido)', () => {
    expect(existsSync(join(MODULE_ROOT, 'components', 'InvoiceMonthTabs.tsx'))).toBe(false)
  })

  it('módulo não recria a tabela de despesas (CardExpensesTable.tsx removido)', () => {
    expect(existsSync(join(MODULE_ROOT, 'components', 'CardExpensesTable.tsx'))).toBe(false)
  })
})
