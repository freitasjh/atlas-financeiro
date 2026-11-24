import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

export function formatCentsBRL(cents: number, locale = 'pt-BR'): string {
  if (!Number.isInteger(cents)) throw new Error('cents deve ser inteiro (sem float)')
  return new Intl.NumberFormat(locale, { style: 'currency', currency: 'BRL' }).format(cents / 100)
}

export function formatDayMonth(iso: string, locale = 'pt-BR'): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) throw new Error('data deve ser YYYY-MM-DD')
  const year = Number(m[1])
  const month = Number(m[2]) - 1
  const day = Number(m[3])
  const dt = new Date(year, month, day)
  if (dt.getFullYear() !== year || dt.getMonth() !== month || dt.getDate() !== day) {
    throw new Error('data inválida')
  }
  return new Intl.DateTimeFormat(locale, { day: '2-digit', month: '2-digit' }).format(dt)
}
