// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { buildInvoiceCsv, createInvoiceCsvBlob, csvCell } from '../csv'

// Cartões Batch 2 — CSV seguro: aspas duplas, dobra " interna, prefixo '
// contra injeção de fórmula (=/python DDE), sem float (cents int).

describe('whenCsvCellFormats_thenFieldsAreQuotedAndSafe', () => {
  it('envolve texto simples em aspas duplas', () => {
    expect(csvCell('Compra')).toBe('"Compra"')
  })

  it('dobra aspas internas', () => {
    expect(csvCell('Livro "Clean Code"')).toBe('"Livro ""Clean Code"""')
  })

  it('prefixa apóstrofo quando começa com = + - @ (injeção de fórmula)', () => {
    expect(csvCell('=cmd|calc')).toBe('"\'=cmd|calc"')
    expect(csvCell('+SUM(A1)')).toBe('"\'+SUM(A1)"')
    expect(csvCell('-2+3')).toBe('"\'-2+3"')
    expect(csvCell('@outro')).toBe('"\'@outro"')
  })

  it('prefixa apóstrofo mesmo com espaço à esquerda (trimStart)', () => {
    expect(csvCell(' =1+1')).toBe(`"' =1+1"`)
    expect(csvCell('  +SUM(A1)')).toBe(`"'  +SUM(A1)"`)
  })

  it('cita campos com ponto-e-vírgula, quebra de linha ou espaços perigosos', () => {
    expect(csvCell('a;b')).toBe('"a;b"')
    expect(csvCell('linha1\nlinha2')).toBe('"linha1\nlinha2"')
  })

  it('converte números sem float e sem locale', () => {
    expect(csvCell(12000)).toBe('"12000"')
    expect(csvCell(0)).toBe('"0"')
  })
})

describe('whenBuildInvoiceCsvRuns_thenHeaderAndRowsAreSafe', () => {
  it('gera cabeçalho + linhas com células blindadas', () => {
    const csv = buildInvoiceCsv(
      [
        { description: '=HYPERLINK("x")', date: '2026-09-15', amountCents: 10000, installmentLabel: 'Parc. 1' },
        { description: 'Café; manhã', date: '2026-09-16', amountCents: 500, installmentLabel: null },
      ],
    )
    const lines = csv.split('\n')
    expect(lines[0]).toBe('descricao;data;valor_centavos;parcela')
    expect(lines[1]).toBe(`"'=HYPERLINK(""x"")";"2026-09-15";"10000";"Parc. 1"`)
    expect(lines[2]).toBe('"Café; manhã";"2026-09-16";"500";""')
    expect(lines).toHaveLength(3)
  })

  it('ignora período: assinatura só recebe linhas (sem param morto)', () => {
    const csv = buildInvoiceCsv([
      { description: 'Café', date: '2026-09-16', amountCents: 500, installmentLabel: null },
    ])
    expect(csv.split('\n')).toHaveLength(2)
  })
})

describe('whenCreateInvoiceCsvBlobRuns_thenBomPrefixIsReal', () => {
  it('prefixa BOM real (\\uFEFF) com MIME text/csv', async () => {
    const blob = createInvoiceCsvBlob('descricao;data\n"a";"b"')
    expect(blob.type).toBe('text/csv;charset=utf-8')
    const text = await blob.text()
    expect(text.charCodeAt(0)).toBe(0xfeff)
    expect(text.slice(1)).toBe('descricao;data\n"a";"b"')
  })
})
