// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const SCRIPT = join(ROOT, '.spec/archive/20261117-cartoes-preview-3d-followup/harness/visual-assert.mjs')
const RAW = join(ROOT, '.spec/archive/20261117-cartoes-preview-3d-followup/harness/visual-assert.raw.json')
const REPORT = join(ROOT, '.spec/archive/20261117-cartoes-preview-3d-followup/harness/visual-assert.json')

function runValidator(rawPath = RAW, reportPath = REPORT) {
  return execFileSync('node', [SCRIPT], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, VISUAL_ASSERT_RAW: rawPath, VISUAL_ASSERT_REPORT: reportPath },
  })
}

describe('whenE2EVisualEvidenceIsVersioned_thenAssertionsAreEnforced', () => {
  it('reexecuta o validador sobre as medições reais e exige veredito PASS', () => {
    const output = runValidator()

    expect(output).toContain('1280x800: 5 temas')
    expect(output).toContain('375x812: 5 temas')
    expect(output).toContain('VEREDITO: PASS')
    const report = JSON.parse(readFileSync(REPORT, 'utf8'))
    expect(report.verdict).toBe('PASS')
    expect(report.viewports).toHaveLength(2)
    for (const vp of report.viewports) {
      expect(vp.themes).toHaveLength(5)
      for (const theme of vp.themes) {
        expect(theme.gapHolderPx).toBeGreaterThan(0)
        expect(theme.gapExpiryPx).toBeGreaterThan(0)
        expect(theme.contrast.last4).toBeGreaterThanOrEqual(4.5)
        expect(theme.contrast.pending).toBeGreaterThanOrEqual(4.5)
        expect(theme.contrast.badge).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('rejeita medição com gap zerado e contraste abaixo de 4,5 (não é log passivo)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'visual-assert-'))
    const raw = JSON.parse(readFileSync(RAW, 'utf8'))
    raw.measurements['1280x800'][0].gapHolderPx = 0
    raw.measurements['1280x800'][0].contrast.pending = 2
    const badRaw = join(dir, 'bad.raw.json')
    const badReport = join(dir, 'bad.report.json')
    writeFileSync(badRaw, JSON.stringify(raw))

    try {
      expect(() => runValidator(badRaw, badReport)).toThrow(/visual-assert FAIL/)
      expect(JSON.parse(readFileSync(badReport, 'utf8')).verdict).toBe('FAIL')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
