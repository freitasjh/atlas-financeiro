// O1.2 — parser OFX SGML próprio (sem fast-xml-parser/DOMParser).
// Regex linha-a-linha em blocos <STMTTRN>; malformado vira OfxParseError listado.

export interface RawOfxTxn {
  line: number
  trntype: string
  dtposted: string
  trnamt: string
  fitid: string | null
  memo: string
}

export interface OfxParseError {
  line: number
  reason: string
}

export interface OfxParseResult {
  transactions: RawOfxTxn[]
  errors: OfxParseError[]
}

const TAG_RE = /<([A-Za-z0-9_]+)>([^<]*)/g
const TRNAMT_RE = /^[+-]?\d+(\.\d{1,2})?$/
const DTPOSTED_RE = /^(\d{4})(\d{2})(\d{2})/

function parseBlockTags(lines: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of lines) {
    TAG_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = TAG_RE.exec(line)) !== null) {
      const key = m[1].toUpperCase()
      if (!(key in out)) out[key] = m[2].trim()
    }
  }
  return out
}

export function parseOfx(text: string): OfxParseResult {
  const transactions: RawOfxTxn[] = []
  const errors: OfxParseError[] = []
  const lines = text.split(/\r?\n/)

  let inBlock = false
  let blockStart = 0
  let blockLines: string[] = []

  const flush = () => {
    const tags = parseBlockTags(blockLines)
    const dtposted = tags['DTPOSTED'] ?? ''
    const trnamt = tags['TRNAMT'] ?? ''
    if (dtposted === '') {
      errors.push({ line: blockStart, reason: 'missing-dtposted' })
      return
    }
    if (trnamt === '') {
      errors.push({ line: blockStart, reason: 'missing-trnamt' })
      return
    }
    if (!DTPOSTED_RE.test(dtposted)) {
      errors.push({ line: blockStart, reason: 'invalid-dtposted' })
      return
    }
    if (!TRNAMT_RE.test(trnamt.trim())) {
      errors.push({ line: blockStart, reason: 'invalid-trnamt' })
      return
    }
    transactions.push({
      line: blockStart,
      trntype: (tags['TRNTYPE'] ?? '').toUpperCase(),
      dtposted: dtposted.trim(),
      trnamt: trnamt.trim(),
      fitid: tags['FITID'] ? tags['FITID'].trim() || null : null,
      memo: (tags['MEMO'] ?? '').trim(),
    })
  }

  lines.forEach((raw, idx) => {
    const lineNo = idx + 1
    const upper = raw.toUpperCase()
    if (upper.includes('<STMTTRN>')) {
      if (inBlock) {
        // Bloco anterior sem fechar: registra e recomeça (nunca silencioso).
        errors.push({ line: blockStart, reason: 'unclosed-stmttrn' })
        blockLines = []
      }
      inBlock = true
      blockStart = lineNo
      blockLines = [raw]
      // Bloco de linha única.
      if (upper.includes('</STMTTRN>')) {
        flush()
        inBlock = false
        blockLines = []
      }
      return
    }
    if (!inBlock) return
    blockLines.push(raw)
    if (upper.includes('</STMTTRN>')) {
      flush()
      inBlock = false
      blockLines = []
    }
  })

  if (inBlock) errors.push({ line: blockStart, reason: 'unclosed-stmttrn' })

  return { transactions, errors }
}
