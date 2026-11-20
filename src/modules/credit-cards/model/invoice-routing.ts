// RN02 puro: compra dia >= closing → próxima fatura.
// Ciclo M = mês de fechamento. period_end = closing clamp(M).
// period_start = dia seguinte ao closing clamp(M-1).
// due: dueDay > closingDay → mês M; senão M+1 (cobre due<closing e due==closing).

export interface InvoiceCycle {
  period_start: string
  period_end: string
  due_date: string
}

function assertDay(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1 || value > 31) {
    throw new Error(`${name} deve ser inteiro 1..31`)
  }
}

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(year, monthIndex + 1, 0).getDate()
}

function iso(year: number, monthIndex: number, day: number): string {
  const date = new Date(year, monthIndex, day)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const dayPart = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${dayPart}`
}

function parseDate(input: string): { y: number; m: number; d: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.trim())
  if (!match) throw new Error('data deve ser YYYY-MM-DD')
  return { y: Number(match[1]), m: Number(match[2]) - 1, d: Number(match[3]) }
}

export function routeInvoice(purchase: string, closingDay: number, dueDay: number): InvoiceCycle {
  assertDay(closingDay, 'closing_day')
  assertDay(dueDay, 'due_day')
  const purchaseDate = parseDate(purchase)
  const effectiveClosing = Math.min(closingDay, daysInMonth(purchaseDate.y, purchaseDate.m))

  const closeInNext = purchaseDate.d >= effectiveClosing
  const closeMonth = closeInNext ? (purchaseDate.m + 1) % 12 : purchaseDate.m
  const closeYear = closeInNext ? purchaseDate.y + (purchaseDate.m === 11 ? 1 : 0) : purchaseDate.y

  const periodEndDay = Math.min(closingDay, daysInMonth(closeYear, closeMonth))
  const period_end = iso(closeYear, closeMonth, periodEndDay)

  const previousMonth = (closeMonth + 11) % 12
  const previousYear = closeMonth === 0 ? closeYear - 1 : closeYear
  const previousClosing = Math.min(closingDay, daysInMonth(previousYear, previousMonth))
  const previousLastDay = daysInMonth(previousYear, previousMonth)
  const period_start =
    previousClosing >= previousLastDay
      ? iso(closeYear, closeMonth, 1)
      : iso(previousYear, previousMonth, previousClosing + 1)

  const dueInCloseMonth = dueDay > closingDay
  const dueMonth = dueInCloseMonth ? closeMonth : (closeMonth + 1) % 12
  const dueYear = dueInCloseMonth ? closeYear : closeYear + (closeMonth === 11 ? 1 : 0)
  const due_date = iso(dueYear, dueMonth, Math.min(dueDay, daysInMonth(dueYear, dueMonth)))

  return { period_start, period_end, due_date }
}
