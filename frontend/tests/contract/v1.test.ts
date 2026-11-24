import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  fieldErrorEnvelopeSchema,
  healthEnvelopeSchema,
  healthStatusSchema,
  type HealthStatus,
} from '../../src/contract/v1'
import { frontendPath } from '../helpers/scan'

describe('FRONT-03 — contrato Zod v1 como única borda de dados', () => {
  it('valida health e infere tipo', () => {
    const value = healthStatusSchema.parse({ status: 'ok', db: 'up', context: 'cliente' })
    const typed: HealthStatus = value
    expect(typed.context).toBe('cliente')
    expect(healthEnvelopeSchema.parse({ version: 'v1', data: value }).version).toBe('v1')
  })

  it('strictObject rejeita campo extra nomeando o caminho', () => {
    const result = healthStatusSchema.safeParse({
      status: 'ok',
      db: 'up',
      context: 'cliente',
      extra: 1,
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const issue = result.error.issues[0] as { code?: string; keys?: string[] }
      expect(issue.code).toBe('unrecognized_keys')
      expect(issue.keys).toContain('extra')
    }
  })

  it('enum fechado rejeita contexto de terceiro app', () => {
    expect(() =>
      healthStatusSchema.parse({ status: 'ok', db: 'up', context: 'terceiro' }),
    ).toThrow()
  })

  it('erro de campo exige version/field/message e barra extra', () => {
    expect(
      fieldErrorEnvelopeSchema.parse({ version: 'v1', field: 'context', message: 'rejeitado' }),
    ).toEqual({ version: 'v1', field: 'context', message: 'rejeitado' })
    expect(() =>
      fieldErrorEnvelopeSchema.parse({ version: 'v1', field: '', message: 'x' }),
    ).toThrow()
  })

  it('reexporta a fonte congelada sem importar app nem emissor remoto', () => {
    const source = readFileSync(frontendPath('src/contract/v1.ts'), 'utf8')
    expect(source).toContain('shared-contracts/src/v1')
    expect(source.includes('backend/apps')).toBe(false)
    const lower = source.toLowerCase()
    const remote = 'supa' + 'base'
    const remoteEnv = 'VITE' + '_' + 'SUPA' + 'BASE' + '_'
    for (const token of [remote, remoteEnv]) {
      expect(lower.includes(token.toLowerCase())).toBe(false)
    }
  })
})
