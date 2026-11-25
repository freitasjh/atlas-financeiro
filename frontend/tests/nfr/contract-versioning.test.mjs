import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { FORBIDDEN, gitDiff, REPO_ROOT, sourceFiles } from '../helpers/scan.ts'

describe('BIGBANG-16 — NFR-03: v1 imutável, OpenAPI diferido', () => {
  it('v1 aditivo no diff (ADR-001 §3): nada congelado é removido', () => {
    const removed = gitDiff(['backend/libs/shared-contracts/src/v1'])
      .split('\n')
      .filter((line) => line.startsWith('-') && !line.startsWith('---'))
    expect(removed).toEqual([])
  })

  it('Swagger diferido: nenhuma dependência no root único', () => {
    const hits = sourceFiles()
      .filter((f) => f.text.toLowerCase().includes(FORBIDDEN.swagger.toLowerCase()))
      .map((f) => f.rel)
    expect(hits).toEqual([])
  })

  it('v1 continua sendo diretório do contrato, não versão da lib', () => {
    const pkg = JSON.parse(readFileSync(`${REPO_ROOT}/package.json`, 'utf8'))
    expect(pkg.dependencies.zod).toMatch(/^\^?4\./)
    expect(readFileSync(`${REPO_ROOT}/frontend/src/contract/v1.ts`, 'utf8')).toContain('shared-contracts/src/v1')
  })
})
