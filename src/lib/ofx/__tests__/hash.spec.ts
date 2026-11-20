import { describe, expect, it } from 'vitest'
import { sha256Hex, primaryDedupKey, secondaryDedupKey, hashTxn } from '../hash'
import { transactionSchema } from '@/modules/transactions/model/transaction'

// O1.4 — TDD: RN05 primário/secundário + zod fitid/dedup_hash opcionais.
describe('whenSha256Runs_thenDeterministic', () => {
  it('mesmo input gera mesmo hash (64 hex)', () => {
    const a = sha256Hex('atlas|F1|2026-11-01|15000')
    const b = sha256Hex('atlas|F1|2026-11-01|15000')
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })

  it('input distinto gera hash distinto', () => {
    expect(sha256Hex('a')).not.toBe(sha256Hex('b'))
  })
})

describe('whenKeysBuilt_thenRn05Format', () => {
  it('primário usa account|fitid|date|cents', () => {
    expect(primaryDedupKey('acc', 'FIT1', '2026-11-01', 15000)).toBe('acc|FIT1|2026-11-01|15000')
  })

  it('secundário normaliza descrição (trim+lower)', () => {
    expect(secondaryDedupKey('acc', '2026-11-01', 15000, '  Mercado CENTRAL ')).toBe(
      'acc|2026-11-01|15000|mercado central',
    )
  })
})

describe('whenTxnHashed_thenIdempotent', () => {
  it('com fitid usa primário; sem fitid usa secundário', () => {
    const withFit = hashTxn({ accountId: 'acc', fitid: 'F1', date: '2026-11-01', amountCents: 15000, description: 'X' })
    const withFit2 = hashTxn({ accountId: 'acc', fitid: 'F1', date: '2026-11-01', amountCents: 15000, description: 'Outra' })
    expect(withFit.fitid).toBe('F1')
    expect(withFit.dedup_hash).toBe(withFit2.dedup_hash)

    const noFit = hashTxn({ accountId: 'acc', fitid: null, date: '2026-11-01', amountCents: 15000, description: ' Mercado ' })
    expect(noFit.fitid).toBeNull()
    expect(noFit.dedup_hash).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('whenZodExtended_thenOldInsertsStillPass', () => {
  it('insert sem fitid/dedup_hash continua válido', () => {
    const r = transactionSchema.safeParse({
      account_id: '123e4567-e89b-12d3-a456-426614174000',
      amount_cents: 100,
      type: 'expense',
      date: '2026-11-01',
    })
    expect(r.success).toBe(true)
  })

  it('aceita fitid/dedup_hash quando presentes', () => {
    const r = transactionSchema.safeParse({
      account_id: '123e4567-e89b-12d3-a456-426614174000',
      amount_cents: 100,
      type: 'expense',
      date: '2026-11-01',
      fitid: 'FIT1',
      dedup_hash: 'a'.repeat(64),
    })
    expect(r.success).toBe(true)
  })
})
