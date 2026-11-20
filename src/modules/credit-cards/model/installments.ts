// RN03: parcelas puras — base = floor(V/N), resto na 1ª.
// Só BIGINT cents (nunca float, nunca /100).

export const MIN_INSTALLMENTS = 2
export const MAX_INSTALLMENTS = 24

function assertTotal(totalCents: number): void {
  if (!Number.isInteger(totalCents) || totalCents < 0) {
    throw new Error('total deve ser inteiro >= 0 em cents (sem float)')
  }
}

function assertCount(count: number): void {
  if (!Number.isInteger(count) || count < MIN_INSTALLMENTS || count > MAX_INSTALLMENTS) {
    throw new Error(`parcelas deve ser inteiro ${MIN_INSTALLMENTS}..${MAX_INSTALLMENTS}`)
  }
}

export function splitInstallments(totalCents: number, count: number): number[] {
  assertTotal(totalCents)
  assertCount(count)
  const base = Math.floor(totalCents / count)
  const remainder = totalCents - base * count
  return Array.from({ length: count }, (_, index) => (index === 0 ? base + remainder : base))
}

export function sumCents(values: number[]): number {
  let total = 0
  for (const value of values) {
    if (!Number.isInteger(value)) throw new Error('cents deve ser inteiro (sem float)')
    total += value
  }
  return total
}

// Soma mês a mês em ISO YYYY-MM-DD (clamp fim de mês via Date).
export function addMonthsISO(dateISO: string, months: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) throw new Error('data deve ser YYYY-MM-DD')
  if (!Number.isInteger(months) || months < 0) throw new Error('months deve ser inteiro >= 0')
  const [year, month, day] = dateISO.split('-').map(Number)
  const date = new Date(year, month - 1 + months, 1)
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()
  date.setDate(Math.min(day, lastDay))
  const monthPart = String(date.getMonth() + 1).padStart(2, '0')
  const dayPart = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${monthPart}-${dayPart}`
}
