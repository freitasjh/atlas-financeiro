import { describe, expect, it } from 'vitest'
import { fieldErrorEnvelopeSchema, healthStatusSchema } from '../../src/contract/v1'
import { firstFieldName, formatFieldError, messageForInvalidField } from '../../src/contract/errors'
import { FORBIDDEN, sourceFiles } from '../helpers/scan'

describe('FRONT-06 — 400/401/403 com nome de campo', () => {
  it('400 nomeia o campo rejeitado', () => {
    const envelope = fieldErrorEnvelopeSchema.parse({
      version: 'v1',
      field: 'status',
      message: 'valor rejeitado',
    })
    expect(formatFieldError(envelope)).toBe('status: valor rejeitado')
  })

  it('envelope com chave extra é barrado pelo strictObject', () => {
    expect(() =>
      fieldErrorEnvelopeSchema.parse({
        version: 'v1',
        field: 'status',
        message: 'x',
        extra: 1,
      } as unknown as Parameters<typeof fieldErrorEnvelopeSchema.parse>[0]),
    ).toThrow()
  })

  it('enum fora do conjunto aponta o campo, nunca frase genérica', () => {
    const result = healthStatusSchema.safeParse({
      status: 'ok',
      db: 'up',
      context: 'terceiro',
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(firstFieldName(result.error.issues)).toBe('context')
    }
    expect(messageForInvalidField('context')).toContain('context')
  })

  it('nenhum texto vago de contexto no root novo', () => {
    const hits = sourceFiles()
      .filter((f) => f.text.toLowerCase().includes(FORBIDDEN.badContext!.toLowerCase()))
      .map((f) => f.rel)
    expect(hits).toEqual([])
  })
})
