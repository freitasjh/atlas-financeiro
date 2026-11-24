// CSV seguro para exportação de extratos: dinheiro em cents inteiros,
// células sempre entre aspas duplas, " interna dobrada, prefixo ' contra
// injeção de fórmula (= + - @). Sem float, sem locale.

export interface InvoiceCsvRow {
  description: string
  date: string
  amountCents: number
  installmentLabel: string | null
}

function isFormulaStart(text: string): boolean {
  const head = text.trimStart()
  return head.startsWith('=') || head.startsWith('+') || head.startsWith('-') || head.startsWith('@')
}

export function csvCell(value: string | number): string {
  if (typeof value === 'number' && !Number.isInteger(value)) {
    throw new Error('csvCell: valor monetário deve ser inteiro em cents (sem float)')
  }
  const raw = typeof value === 'number' ? String(value) : value
  const doubled = raw.replace(/"/g, '""')
  const guarded = isFormulaStart(raw) ? `'${doubled}` : doubled
  return `"${guarded}"`
}

export function buildInvoiceCsv(rows: InvoiceCsvRow[]): string {
  const header = 'descricao;data;valor_centavos;parcela'
  const body = rows.map((row) =>
    [csvCell(row.description), csvCell(row.date), csvCell(row.amountCents), csvCell(row.installmentLabel ?? '')].join(
      ';',
    ),
  )
  return [header, ...body].join('\n')
}

// Blob de exportação com BOM real (escape \uFEFF, nunca literal "ufeff"):
 // Excel/Windows detecta UTF-8 e preserva acentos.
export function createInvoiceCsvBlob(csv: string): Blob {
  return new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' })
}
