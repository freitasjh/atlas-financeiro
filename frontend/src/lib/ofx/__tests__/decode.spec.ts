import { describe, expect, it } from 'vitest'
import { decodeOfxBytes, decodeBlob, countOfxLines, OFX_MAX_BYTES, OFX_MAX_LINES } from '../decode'

// O1.1 — TDD: decode windows-1252 + UTF-8 com acentos (Itaú/Bradesco çãõ).
describe('whenBytesAreWindows1252_thenDecodePreservesAccents', () => {
  it('decodifica çãõ em windows-1252 (Itaú/Bradesco)', () => {
    // "TRANSAÇÃO CONTA POUPANÇA" em windows-1252 bytes
    const bytes = new Uint8Array([0x54, 0x52, 0x41, 0x4e, 0x53, 0x41, 0xc7, 0xc3, 0x4f, 0x20, 0x50, 0x4f, 0x55, 0x50, 0x41, 0x4e, 0xc7, 0x41])
    const text = decodeOfxBytes(bytes)
    expect(text).toContain('Ç')
    expect(text).toContain('Ã')
    expect(text).toContain('TRANSA')
  })
})

describe('whenBytesAreUtf8_thenDecodePreservesAccents', () => {
  it('decodifica çãõ em UTF-8', () => {
    const original = 'PAGAMENTO ENERGIAÇÃO NÚMERO çãõ'
    const bytes = new TextEncoder().encode(original)
    expect(decodeOfxBytes(bytes)).toBe(original)
  })
})

describe('whenBlobIsGiven_thenDecodeBlobResolvesText', () => {
  it('lê Blob via arrayBuffer', async () => {
    const original = 'OFXHEADER:100\n<MEMO>CAFÉ AÇAÍ</MEMO>'
    const blob = new Blob([new TextEncoder().encode(original)], { type: 'text/plain' })
    await expect(decodeBlob(blob)).resolves.toBe(original)
  })
})

describe('whenCountingLines_thenLimitsAreHonest', () => {
  it('conta linhas e expõe limites 2MB/5000', () => {
    expect(OFX_MAX_BYTES).toBe(2 * 1024 * 1024)
    expect(OFX_MAX_LINES).toBe(5000)
    expect(countOfxLines('a\nb\nc')).toBe(3)
    expect(countOfxLines('')).toBe(0)
  })
})
