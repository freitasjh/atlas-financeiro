// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useOfxImport, guardOfxFile } from '../useOfxImport'

function fakeFile(name: string, size: number): File {
  const blob = new Blob([new Uint8Array(Math.min(size, 16))], { type: 'text/plain' })
  return new File([blob], name, { type: 'text/plain' })
}

describe('whenGuardRuns_thenHonestErrorsBeforeRead', () => {
  it('rejeita >2MB antes de ler', () => {
    const f = fakeFile('extrato.ofx', 2 * 1024 * 1024 + 1)
    // Simula size grande sem alocar: redefine size via getter.
    Object.defineProperty(f, 'size', { value: 2 * 1024 * 1024 + 1 })
    expect(guardOfxFile(f)).toBe('too-large')
  })

  it('rejeita extensão fora de .ofx/.qfx', () => {
    expect(guardOfxFile(fakeFile('extrato.csv', 10))).toBe('invalid-type')
    expect(guardOfxFile(fakeFile('extrato.ofx', 10))).toBeNull()
    expect(guardOfxFile(fakeFile('EXTRATO.QFX', 10))).toBeNull()
  })

  it('rejeita arquivo ausente', () => {
    expect(guardOfxFile(null)).toBe('required')
  })
})

describe('whenHookPicksFile_thenTooManyLinesIsHonest', () => {
  it('linhas >5000 viram erro sem parse', async () => {
    const { result } = renderHook(() => useOfxImport())
    const big = 'a\n'.repeat(5001)
    const file = new File([big], 'extrato.ofx')
    let out: string | null = 'unset'
    await act(async () => {
      out = await result.current.pickFile(file)
    })
    expect(out).toBeNull()
    expect(result.current.errorCode).toBe('too-many-lines')
  })

  it('arquivo válido retorna texto e limpa erro', async () => {
    const { result } = renderHook(() => useOfxImport())
    const file = new File(['<OFX>'], 'extrato.ofx')
    let out: string | null = null
    await act(async () => {
      out = await result.current.pickFile(file)
    })
    expect(out).toContain('<OFX>')
    expect(result.current.errorCode).toBeNull()
    expect(result.current.fileName).toBe('extrato.ofx')
  })
})
