import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FRONTEND_ROOT, gitDiff, REPO_ROOT, TASKS_PATH } from '../helpers/scan.ts'

const runChecks = () => {
  const code =
    "import('./.opencode/plugins/lib/prd-adr-pipeline/checks.mjs')" +
    '.then(m=>process.stdout.write(JSON.stringify(m.runPrdChecks(process.cwd()))))'
  const out = execFileSync(process.execPath, ['-e', code], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return JSON.parse(out)
}

describe('BIGBANG-11 — gates estruturais: ADR-002 PASS (índice creditado ao architect)', () => {
  it('runPrdChecks dá ok:true e PRD-01/ADR-01/ADR-02 PASS', () => {
    const result = runChecks()
    expect(result.ok).toBe(true)
    expect(result.results.map((r) => r.id)).toEqual(['PRD-01', 'ADR-01', 'ADR-02'])
    for (const row of result.results) expect(row.status).toBe('PASS')
  })

  it('TASKS.md tem marcador ADR-002 e a raiz do PRD não tem SDD', () => {
    const text = readFileSync(TASKS_PATH, 'utf8')
    expect(text).toContain('<!-- scope: adr/ADR-002 -->')
    expect(text.includes('<!-- scope: adr/ADR-001 -->')).toBe(false)
    const prdRoot = join(REPO_ROOT, '.spec/prd/frontend-migracao')
    expect(existsSync(join(prdRoot, 'SPEC.md'))).toBe(false)
    expect(existsSync(join(prdRoot, 'TASKS.md'))).toBe(false)
  })

  it('config protegido intacto; runPrdChecks não é evidência de dívida', () => {
    expect(gitDiff(['harness.config.json']).trim()).toBe('')
    expect(FRONTEND_ROOT.startsWith(REPO_ROOT)).toBe(true)
  })
})
