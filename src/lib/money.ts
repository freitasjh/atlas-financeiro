import { formatCentsBRL } from '@/lib/utils'

export function parseBRLToCents(raw: string): number | null {
  const compact = raw.replace(/[\s\u00a0]/g, '').replace(/^R\$/i, '')
  if (compact === '') return null

  const hasComma = compact.includes(',')
  const hasDot = compact.includes('.')
  let integerDigits: string
  let fractionDigits = ''

  if (hasComma) {
    const parts = compact.split(',')
    if (parts.length !== 2) return null
    const [intPart, fracPart] = parts
    if (!/^\d{1,2}$/.test(fracPart)) return null
    fractionDigits = fracPart
    if (hasDot) {
      if (!/^\d{1,3}(\.\d{3})+$/.test(intPart)) return null
      integerDigits = intPart.replace(/\./g, '')
    } else {
      if (!/^\d+$/.test(intPart)) return null
      integerDigits = intPart
    }
  } else if (hasDot) {
    if (/^\d{1,3}(\.\d{3})+$/.test(compact)) {
      // pt-BR: agrupamento de milhar ("1.234", "1.234.567").
      integerDigits = compact.replace(/\./g, '')
    } else if (/^\d+\.\d{1,2}$/.test(compact)) {
      // en-US: ponto decimal ("1234.56", "12.5").
      const [intPart, fracPart] = compact.split('.')
      integerDigits = intPart
      fractionDigits = fracPart
    } else {
      return null
    }
  } else {
    if (!/^\d+$/.test(compact)) return null
    integerDigits = compact
  }

  if (integerDigits.length > 15) return null
  const cents = Number(integerDigits) * 100 + Number(fractionDigits.padEnd(2, '0'))
  return Number.isSafeInteger(cents) ? cents : null
}

export function formatBRL(cents: number, locale = 'pt-BR'): string {
  return formatCentsBRL(cents, locale)
}

// Máscara de centavos: digitar apenas dígitos; "1500" -> "15,00".
// Sem float: interpreta os dígitos como centavos inteiros e formata em BRL.
export function maskCentsInput(raw: string): string {
  const digits = (raw ?? '').replace(/\D/g, '')
  if (digits === '') return ''
  const cents = Number(digits)
  if (!Number.isSafeInteger(cents)) return digits
  return formatCentsBRL(cents).replace(/^R\$\s?/, '')
}

// Aliases para compatibilidade com diferentes convenções de nome.
export const formatCentsInput = maskCentsInput
export const centsMask = maskCentsInput
export const parseCentsInput = parseBRLToCents
