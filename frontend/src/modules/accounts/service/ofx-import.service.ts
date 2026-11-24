// O3.1/O3.2 — lote OFX real: insert em chunks + 23505→skip + 1× recalc.
// BIGINT cents (sem float); RLS via client auth; sem service_role.
import { z } from 'zod'
import { supabase } from '@/lib/supabase'
import { recalcAccount } from './accounts.service'

/** Tamanho do lote por insert (SPEC O3.1). */
export const OFX_IMPORT_CHUNK_SIZE = 500

const confirmRowSchema = z.strictObject({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'invalid-date'),
  description: z.string().trim().min(1).max(240),
  amount_cents: z.number().int().nonnegative(),
  type: z.enum(['income', 'expense']),
  category_id: z.string().nullable(),
  fitid: z.string().max(128).nullable(),
  dedup_hash: z.string().regex(/^[0-9a-f]{64}$/, 'invalid-dedup'),
})

export interface OfxConfirmRow {
  id: string
  date: string
  description: string
  amount_cents: number
  type: 'income' | 'expense'
  category_id: string | null
  fitid: string | null
  dedup_hash: string
  selected: boolean
  dup: boolean
}

export interface OfxImportReport {
  inserted: number
  duplicates: number
  failed: number
  aborted: number
  errors: string[]
}

export interface ConfirmOptions {
  chunkSize?: number
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === '23505'
  )
}

function chunkOf<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * O3.1 — dedup cruzado com o banco: hashes já persistidos p/ conta.
 * RLS do client garante isolamento (A nunca vê B).
 */
export async function fetchExistingHashes(accountId: string, hashes: string[]): Promise<Set<string>> {
  const unique = [...new Set(hashes.filter((h) => h !== ''))]
  if (unique.length === 0) return new Set()
  const found = new Set<string>()
  for (const batch of chunkOf(unique, OFX_IMPORT_CHUNK_SIZE)) {
    const { data, error } = await supabase
      .from('transactions')
      .select('dedup_hash')
      .eq('account_id', accountId)
      .in('dedup_hash', batch)
    if (error) throw error
    for (const row of (data ?? []) as Array<{ dedup_hash: string | null }>) {
      if (row.dedup_hash) found.add(row.dedup_hash)
    }
  }
  return found
}

/**
 * O3.2 — persiste selecionados em chunks; 23505→skip contado (fallback por
 * linha no chunk conflitante); erro não-23505 aborta restantes; 1× recalc
 * final quando algo foi gravado. Sem recalc fantasma quando nada gravou.
 *
 * Contagem honesta: `failed` = linhas inválidas no zod (nunca tentadas) +
 * payload perdido no chunk do erro; `aborted` = soma dos payloads validados
 * dos chunks seguintes (inválidas não entram — não seriam tentadas).
 */
export async function confirmOfxImport(
  accountId: string,
  rows: OfxConfirmRow[],
  options: ConfirmOptions = {},
): Promise<OfxImportReport> {
  const chunkSize = options.chunkSize ?? OFX_IMPORT_CHUNK_SIZE
  const report: OfxImportReport = { inserted: 0, duplicates: 0, failed: 0, aborted: 0, errors: [] }

  const { data: user } = await supabase.auth.getUser()
  const userId = user?.user?.id
  if (!userId) throw new Error('unauthenticated')

  const selected = rows.filter((r) => r.selected && !r.dup)
  const chunks = chunkOf(selected, chunkSize)

  const validated = chunks.map((rows) => {
    const payload: Array<Record<string, unknown>> = []
    let invalid = 0
    for (const row of rows) {
      const parsed = confirmRowSchema.safeParse({
        date: row.date,
        description: row.description,
        amount_cents: row.amount_cents,
        type: row.type,
        category_id: row.category_id,
        fitid: row.fitid,
        dedup_hash: row.dedup_hash,
      })
      if (!parsed.success) {
        invalid += 1
        continue
      }
      payload.push({
        user_id: userId,
        account_id: accountId,
        amount_cents: parsed.data.amount_cents,
        type: parsed.data.type,
        description: parsed.data.description,
        category_id: parsed.data.category_id,
        date: parsed.data.date,
        is_transfer: false,
        transfer_destination_account_id: null,
        reconciled: true,
        installment_plan_id: null,
        invoice_id: null,
        fitid: parsed.data.fitid,
        dedup_hash: parsed.data.dedup_hash,
      })
    }
    return { payload, invalid }
  })
  report.failed += validated.reduce((acc, v) => acc + v.invalid, 0)

  for (let ci = 0; ci < validated.length; ci += 1) {
    const { payload } = validated[ci]
    if (payload.length === 0) continue

    const { error } = await supabase.from('transactions').insert(payload)
    if (!error) {
      report.inserted += payload.length
      continue
    }
    if (!isUniqueViolation(error)) {
      // Erro real: chunk perdido + restantes abortados (parcial honesto).
      report.failed += payload.length
      report.aborted += validated.slice(ci + 1).reduce((acc, v) => acc + v.payload.length, 0)
      report.errors.push(`chunk-${ci + 1}`)
      break
    }
    // 23505 no chunk: resolve por linha (skip contado, sem falhar o batch).
    for (const item of payload) {
      const { error: rowError } = await supabase.from('transactions').insert([item])
      if (!rowError) {
        report.inserted += 1
      } else if (isUniqueViolation(rowError)) {
        report.duplicates += 1
      } else {
        report.failed += 1
        report.errors.push('row-insert')
      }
    }
  }

  if (report.inserted > 0) {
    await recalcAccount(accountId)
  }
  return report
}
