// O1.3 — normalização OFX: data YYYYMMDD→date local meio-dia (string pura,
// sem new Date(string)); TRNAMT string→cents via split (nunca parseFloat).

import type { RawOfxTxn } from './parser'

export interface NormalizedTxn {
  accountId: string
  date: string
  amount_cents: number
  type: 'income' | 'expense'
  description: string
  fitid: string | null
  is_transfer: false
}

const AMT_RE = /^[+-]?\d+(\.\d{1,2})?$/
const DATE_RE = /^(\d{4})(\d{2})(\d{2})/

/** Converte "YYYYMMDD[hhmmss]" em "YYYY-MM-DD" sem construir Date. */
export function ofxDateToIso(dtposted: string): string {
  const m = DATE_RE.exec(dtposted.trim())
  if (!m) throw new Error('invalid-dtposted')
  const [, y, mo, d] = m
  const month = Number(mo)
  const day = Number(d)
  if (month < 1 || month > 12 || day < 1 || day > 31) throw new Error('invalid-dtposted')
  return `${y}-${mo}-${d}`
}

/** Converte TRNAMT em centavos com sinal via split de string (sem float). */
export function trnAmtToSignedCents(raw: string): number {
  const s = raw.trim()
  if (!AMT_RE.test(s)) throw new Error('invalid-trnamt')
  const negative = s.startsWith('-')
  const unsigned = s.replace(/^[+-]/, '')
  const [intPart, fracPart = ''] = unsigned.split('.')
  if (!/^\d+$/.test(intPart) || intPart.length > 15) throw new Error('invalid-trnamt')
  const frac = (fracPart + '00').slice(0, 2)
  if (!/^\d{2}$/.test(frac)) throw new Error('invalid-trnamt')
  const cents = Number(intPart) * 100 + Number(frac)
  if (!Number.isSafeInteger(cents)) throw new Error('invalid-trnamt')
  return negative ? -cents : cents
}

export function normalizeTxn(raw: RawOfxTxn, accountId: string): NormalizedTxn {
  const signed = trnAmtToSignedCents(raw.trnamt)
  const date = ofxDateToIso(raw.dtposted)
  const isNegative = signed < 0
  return {
    accountId,
    date,
    amount_cents: Math.abs(signed),
    type: isNegative ? 'expense' : 'income',
    description: raw.memo === '' ? 'Lançamento sem descrição' : raw.memo.slice(0, 240),
    fitid: raw.fitid,
    is_transfer: false,
  }
}
