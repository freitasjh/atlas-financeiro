// P2.1..P2.4 — página /contas/importar: Etapa 1 upload + Etapa 2 staging
// full-width (reuso ImportStagingTable/useImportStaging/confirmOfxImport) +
// confirmação (loading/sucesso/erro parcial + retry) + descarte com Dialog.
// Handoff do picker: store transitório (reativo) ou location.state (one-shot);
// nada persiste além da sessão — swap/sucesso/unmount limpam (clearTransfer).
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, CheckCircle2 } from 'lucide-react'
import { toast } from 'sonner'
import { Alert, AlertDescription, AlertTitle } from '@/components/shadcn/ui/alert'
import { Button } from '@/components/shadcn/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/shadcn/ui/dialog'
import { Skeleton } from '@/components/shadcn/ui/skeleton'
import { PageHeader } from '@/components/ui/PageHeader'
import { bankLineText } from '../components/AccountCard'
import { OfxDropzone } from '../components/OfxDropzone'
import { ImportStagingTable } from '../components/ImportStagingTable'
import { ofxGuardMessage } from '../components/ofx-errors'
import { useOfxImport } from '../hooks/useOfxImport'
import { useImportStaging, type StagedInput } from '../hooks/useImportStaging'
import { useOfxLookups } from '../hooks/useOfxLookups'
import { useOfxTransferStore } from '../store/ofx-transfer.store'
import { confirmOfxImport, fetchExistingHashes, type OfxImportReport } from '../service/ofx-import.service'
import { parseOfx } from '@/lib/ofx/parser'
import { normalizeTxn } from '@/lib/ofx/normalize'
import { hashTxn } from '@/lib/ofx/hash'
import { accountRowToBankAccount } from '../model/accounts.adapter'
import { useAccountsStore } from '../store/accounts.store'

interface HandoffState {
  fileText: string
  fileName: string
  accountId?: string
}

type Phase = 'upload' | 'review' | 'success'
type PendingDiscard = 'swap' | 'leave-accounts' | null

function readHandoff(state: unknown): HandoffState | null {
  if (!state || typeof state !== 'object') return null
  const candidate = state as Partial<HandoffState>
  if (typeof candidate.fileText !== 'string' || typeof candidate.fileName !== 'string') return null
  return {
    fileText: candidate.fileText,
    fileName: candidate.fileName,
    accountId: typeof candidate.accountId === 'string' ? candidate.accountId : undefined,
  }
}

export function ImportOfxPage() {
  const { t } = useTranslation()
  const [searchParams] = useSearchParams()
  const location = useLocation()
  const navigate = useNavigate()
  const accounts = useAccountsStore((s) => s.accounts)
  const status = useAccountsStore((s) => s.status)
  const load = useAccountsStore((s) => s.load)
  const setTransfer = useOfxTransferStore((s) => s.setTransfer)
  const clearTransfer = useOfxTransferStore((s) => s.clearTransfer)
  // Amarelo (c): store reativo — handoff tardio do picker sincroniza sem re-upload.
  const storeFileText = useOfxTransferStore((s) => s.fileText)
  const storeFileName = useOfxTransferStore((s) => s.fileName)
  const storeAccountId = useOfxTransferStore((s) => s.accountId)
  const { errorCode, isReading, pickFile, reset } = useOfxImport()

  const [handoff] = useState<HandoffState | null>(() => {
    const fromStore = useOfxTransferStore.getState()
    if (fromStore.fileText && fromStore.fileName) {
      return { fileText: fromStore.fileText, fileName: fromStore.fileName, accountId: fromStore.accountId ?? undefined }
    }
    return readHandoff(location.state)
  })
  const [picked, setPicked] = useState<{ name: string; text: string } | null>(() =>
    handoff ? { name: handoff.fileName, text: handoff.fileText } : null,
  )
  const [accountId, setAccountId] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [phase, setPhase] = useState<Phase>(() => (handoff ? 'review' : 'upload'))
  const [resolving, setResolving] = useState(false)
  const [isConfirming, setIsConfirming] = useState(false)
  const [confirmError, setConfirmError] = useState<string | null>(null)
  const [report, setReport] = useState<OfxImportReport | null>(null)
  const [discardOpen, setDiscardOpen] = useState(false)
  const pendingDiscard = useRef<PendingDiscard>(null)

  const uploadHeadingRef = useRef<HTMLHeadingElement>(null)
  const reviewHeadingRef = useRef<HTMLHeadingElement>(null)
  const successHeadingRef = useRef<HTMLHeadingElement>(null)
  const accountSelectRef = useRef<HTMLSelectElement>(null)
  const prevPhase = useRef<Phase>(phase)

  const { rows, counts, confirmCount, allNewSelected, load: loadStaging, reset: resetStaging, toggleRow, toggleAll, setCategory, applyRules } =
    useImportStaging()
  const stagingActive = phase === 'review' && picked !== null
  const { categories, rules } = useOfxLookups(stagingActive)

  useEffect(() => {
    void load()
  }, [load])

  // Handoff consumido uma vez: unmount limpa o transitório (nada além da sessão).
  useEffect(() => {
    return () => {
      useOfxTransferStore.getState().clearTransfer()
    }
  }, [])

  // Sincroniza handoff tardio do picker (store reativo, sem novo upload).
  useEffect(() => {
    if (storeFileText && storeFileName && !picked) {
      setPicked({ name: storeFileName, text: storeFileText })
      if (storeAccountId) setAccountId(storeAccountId)
      setPhase('review')
    }
  }, [storeFileText, storeFileName, storeAccountId, picked])

  const viewAccounts = useMemo(() => accounts.map(accountRowToBankAccount), [accounts])

  // Pré-seleção: ?conta= → conta do handoff → primeira conta.
  useEffect(() => {
    if (accountId !== '' || viewAccounts.length === 0) return
    const valid = (id: string | null | undefined) =>
      id && viewAccounts.some((a) => a.id === id) ? id : null
    setAccountId(
      valid(searchParams.get('conta')) ?? valid(handoff?.accountId) ?? valid(storeAccountId) ?? viewAccounts[0].id,
    )
  }, [accountId, viewAccounts, searchParams, handoff, storeAccountId])

  // Parse síncrono fileText → StagedInput[] (BIGINT cents, sem float) + inválidos.
  const parsed = useMemo(() => {
    if (!picked || accountId === '') return null
    try {
      const { transactions, errors } = parseOfx(picked.text)
      const inputs: StagedInput[] = []
      let invalid = errors.length
      transactions.forEach((raw, idx) => {
        try {
          const normalized = normalizeTxn(raw, accountId)
          const hashed = hashTxn({
            accountId,
            fitid: normalized.fitid,
            date: normalized.date,
            amountCents: normalized.amount_cents,
            description: normalized.description,
          })
          inputs.push({
            id: `staged-${idx}`,
            date: normalized.date,
            description: normalized.description,
            amount_cents: normalized.amount_cents,
            type: normalized.type,
            fitid: hashed.fitid,
            dedup_hash: hashed.dedup_hash,
          })
        } catch {
          invalid += 1
        }
      })
      return { inputs, invalid, total: transactions.length }
    } catch {
      return { inputs: [], invalid: 0, total: 0 }
    }
  }, [picked, accountId])

  // Carrega staging com dedup cruzado (RLS) + regras + seleção total de novos.
  useEffect(() => {
    if (phase !== 'review' || !parsed || accountId === '') return
    let cancelled = false
    setResolving(true)
    setConfirmError(null)
    const hashes = parsed.inputs.map((item) => item.dedup_hash)
    fetchExistingHashes(accountId, hashes)
      .then((existing) => {
        if (cancelled) return
        loadStaging(parsed.inputs, { existingHashes: existing, invalidCount: parsed.invalid })
        toggleAll(true)
      })
      .catch(() => {
        if (cancelled) return
        loadStaging(parsed.inputs, { invalidCount: parsed.invalid })
        toggleAll(true)
      })
      .finally(() => {
        if (!cancelled) setResolving(false)
      })
    return () => {
      cancelled = true
    }
  }, [phase, parsed, accountId, loadStaging, toggleAll])

  // Regras aplicadas quando o lookup resolve depois do load inicial.
  useEffect(() => {
    if (phase === 'review' && rules.length > 0 && rows.length > 0) applyRules(rules)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, rules])

  // Foco gerenciado na troca de etapa (pula o mount inicial).
  // Volta ao envio foca o seletor de conta (alvo útil); h2.sr-only só fallback.
  useEffect(() => {
    if (prevPhase.current === phase) return
    prevPhase.current = phase
    if (phase === 'upload') {
      const select = accountSelectRef.current
      if (select && !select.disabled) select.focus()
      else uploadHeadingRef.current?.focus()
    } else if (phase === 'review') reviewHeadingRef.current?.focus()
    else successHeadingRef.current?.focus()
  }, [phase])

  const activeNickname = viewAccounts.find((a) => a.id === accountId)?.nickname ?? ''
  const dirty = phase === 'review' && rows.length > 0

  const handleFiles = async (files: FileList | null) => {
    const file = files?.[0] ?? null
    resetStaging()
    setFormError(null)
    setConfirmError(null)
    setReport(null)
    setPicked(null)
    const text = await pickFile(file)
    if (text === null || !file) return
    const entry = { name: file.name, text }
    setPicked(entry)
    setPhase('review')
    if (accountId) setTransfer({ fileText: text, fileName: entry.name, accountId })
  }

  const doSwap = () => {
    setPicked(null)
    setFormError(null)
    setConfirmError(null)
    setReport(null)
    resetStaging()
    reset()
    clearTransfer()
    setPhase('upload')
  }

  const handleSwapRequest = () => {
    if (dirty) {
      pendingDiscard.current = 'swap'
      setDiscardOpen(true)
      return
    }
    doSwap()
  }

  const handleBackToUpload = () => {
    setConfirmError(null)
    setReport(null)
    setPhase('upload')
  }

  const handleAccountChange = (id: string) => {
    setAccountId(id)
    if (picked) setTransfer({ fileText: picked.text, fileName: picked.name, accountId: id })
  }

  const handleBackToAccounts = (e: React.MouseEvent) => {
    if (!dirty) return
    e.preventDefault()
    pendingDiscard.current = 'leave-accounts'
    setDiscardOpen(true)
  }

  const handleDiscardConfirm = () => {
    const pending = pendingDiscard.current
    pendingDiscard.current = null
    setDiscardOpen(false)
    if (pending === 'leave-accounts') {
      doSwap()
      void navigate('/contas')
    } else {
      doSwap()
    }
  }

  const handleConfirm = async () => {
    if (accountId === '' || isConfirming) return
    setIsConfirming(true)
    setConfirmError(null)
    try {
      const result = await confirmOfxImport(
        accountId,
        rows.map((row) => ({
          id: row.id,
          date: row.date,
          description: row.description,
          amount_cents: row.amount_cents,
          type: row.type,
          category_id: row.category_id,
          fitid: row.fitid,
          dedup_hash: row.dedup_hash,
          selected: row.selected,
          dup: row.dup,
        })),
      )
      if (result.failed === 0 && result.errors.length === 0) {
        setReport(result)
        setPhase('success')
        resetStaging()
        clearTransfer()
        toast.success(t('accounts.ofx.successToast', { count: result.inserted }))
      } else {
        setReport(result)
        setConfirmError(
          t('accounts.ofx.importPartial', {
            inserted: result.inserted,
            failed: result.failed,
            aborted: result.aborted,
          }),
        )
      }
    } catch {
      setConfirmError(t('accounts.ofx.importFailed'))
    } finally {
      setIsConfirming(false)
    }
  }

  const handleImportAnother = () => {
    doSwap()
  }

  const handleViewStatement = () => {
    void navigate(`/contas?conta=${encodeURIComponent(accountId)}`)
  }

  const guardMessage = ofxGuardMessage(t, errorCode, formError)

  if (status === 'loading' || status === 'idle') {
    return (
      <div aria-busy="true" aria-live="polite">
        <PageHeader title={t('accounts.ofx.importPageTitle')} subtitle={t('accounts.ofx.importPageSubtitle')} />
        <div className="flex w-full flex-col gap-4 px-4 pt-4 lg:px-6">
          <Skeleton className="h-6 w-64 rounded-md" />
          <Skeleton className="h-44 w-full rounded-2xl" />
          <Skeleton className="h-11 w-full rounded-md" />
        </div>
      </div>
    )
  }

  if (status === 'error') {
    return (
      <div>
        <PageHeader title={t('accounts.ofx.importPageTitle')} subtitle={t('accounts.ofx.importPageSubtitle')} />
        <div className="flex w-full flex-col gap-3 px-4 pt-4 lg:px-6">
          <Alert variant="destructive">
            <AlertTitle>{t('common.error')}</AlertTitle>
            <AlertDescription>{t('accounts.loadError')}</AlertDescription>
          </Alert>
          <Button onClick={() => void load()} variant="outline" className="min-h-11 w-fit">
            {t('common.retry')}
          </Button>
        </div>
      </div>
    )
  }

  const uploadCurrent = phase === 'upload'
  const reviewCurrent = phase !== 'upload'

  return (
    <div className="flex w-full flex-col gap-5 pb-8">
      <PageHeader title={t('accounts.ofx.importPageTitle')} subtitle={t('accounts.ofx.importPageSubtitle')} />

      <div className="flex w-full flex-col gap-4 px-4 lg:px-6">
        <nav aria-label={t('common.breadcrumb')}>
          <ol className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <li>
              <Link to="/contas" className="min-h-11 rounded underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
                {t('accounts.title')}
              </Link>
            </li>
            <li aria-hidden="true">/</li>
            <li aria-current="page" className="font-semibold text-foreground">
              {t('accounts.ofx.importPageTitle')}
            </li>
          </ol>
        </nav>

        <Link
          to="/contas"
          onClick={handleBackToAccounts}
          aria-label={t('accounts.ofx.backToAccounts')}
          className="inline-flex min-h-11 w-fit items-center gap-1.5 rounded-md text-xs font-semibold text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <ArrowLeft className="h-4 w-4" />
          <span>{t('accounts.ofx.backToAccounts')}</span>
        </Link>

        <ol aria-label={t('accounts.ofx.stepsLabel')} className="flex items-center gap-2 text-xs">
          <li
            aria-current={uploadCurrent ? 'step' : undefined}
            className={`flex items-center gap-2 ${uploadCurrent ? 'font-bold text-foreground' : 'text-muted-foreground'}`}
          >
            <span
              className={`flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-bold tabular-nums ${
                uploadCurrent ? 'bg-primary text-primary-foreground' : 'border border-border'
              }`}
            >
              1
            </span>
            <span>{t('accounts.ofx.stepUpload')}</span>
          </li>
          <li aria-hidden="true" className="h-px w-8 bg-border" />
          <li
            aria-current={reviewCurrent ? 'step' : undefined}
            className={`flex items-center gap-2 ${reviewCurrent ? 'font-bold text-foreground' : 'text-muted-foreground'}`}
          >
            <span
              className={`flex h-6 w-6 items-center justify-center rounded-full text-[11px] tabular-nums ${
                reviewCurrent ? 'bg-primary text-primary-foreground' : 'border border-border'
              }`}
            >
              2
            </span>
            <span>{t('accounts.ofx.stepReview')}</span>
          </li>
        </ol>

        {phase === 'upload' ? (
          <fieldset className="flex min-w-0 flex-col gap-3">
            <legend className="sr-only">{t('accounts.ofx.stepUpload')}</legend>
            <h2 ref={uploadHeadingRef} tabIndex={-1} data-testid="import-upload-heading" className="sr-only focus-visible:outline-none">
              {t('accounts.ofx.stepUpload')}
            </h2>

            <div className="flex min-w-0 flex-col gap-1.5">
              <label htmlFor="import-account" className="block text-xs font-semibold text-foreground">
                {t('accounts.ofx.accountLabel')}
              </label>
              <select
                id="import-account"
                ref={accountSelectRef}
                aria-label={t('accounts.targetAccount')}
                value={accountId}
                onChange={(e) => handleAccountChange(e.target.value)}
                disabled={viewAccounts.length === 0}
                className="flex h-11 min-h-11 w-full rounded-md border border-border/80 bg-background px-3 py-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-60"
              >
                {viewAccounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.nickname} ({bankLineText(t, account)})
                  </option>
                ))}
              </select>
              {viewAccounts.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">{t('accounts.emptyHint')}</p>
              ) : null}
            </div>

            <OfxDropzone
              size="hero"
              fileName={picked?.name ?? null}
              isReading={isReading}
              onFiles={(files) => void handleFiles(files)}
            />

            {picked ? (
              <div className="flex justify-center">
                <button
                  type="button"
                  onClick={handleSwapRequest}
                  className="min-h-11 px-3 text-[11px] text-destructive hover:underline"
                >
                  {t('accounts.ofx.swapFile')}
                </button>
              </div>
            ) : null}

            {guardMessage ? (
              <Alert variant="destructive" role="alert">
                <AlertDescription>{guardMessage}</AlertDescription>
              </Alert>
            ) : null}
          </fieldset>
        ) : null}

        {phase === 'review' ? (
          <section aria-labelledby="import-review-heading" className="flex w-full min-w-0 flex-col gap-3">
            <h2
              id="import-review-heading"
              ref={reviewHeadingRef}
              tabIndex={-1}
              data-testid="import-review-heading"
              className="text-sm font-bold text-foreground focus-visible:outline-none"
            >
              {t('accounts.staging.title')}
            </h2>

            <div className="flex min-w-0 flex-col gap-1.5">
              <label htmlFor="import-account-review" className="block text-xs font-semibold text-foreground">
                {t('accounts.ofx.accountLabel')}
              </label>
              <select
                id="import-account-review"
                aria-label={t('accounts.targetAccount')}
                value={accountId}
                onChange={(e) => handleAccountChange(e.target.value)}
                disabled={viewAccounts.length === 0 || isConfirming}
                className="flex h-11 min-h-11 w-full rounded-md border border-border/80 bg-background px-3 py-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-60"
              >
                {viewAccounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.nickname} ({bankLineText(t, account)})
                  </option>
                ))}
              </select>
            </div>

            {picked ? (
              <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-xl border border-border/70 bg-muted/20 px-3 py-2">
                <p className="min-w-0 flex-1 truncate font-mono text-xs text-foreground" title={picked.name}>
                  {picked.name}
                </p>
                <span className="shrink-0 text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">
                  {t('accounts.ofx.fileValid')}
                </span>
                <button
                  type="button"
                  onClick={handleSwapRequest}
                  className="min-h-11 shrink-0 px-2 text-[11px] font-semibold text-destructive hover:underline"
                >
                  {t('accounts.ofx.swapFile')}
                </button>
              </div>
            ) : null}

            <div className="flex justify-start">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleBackToUpload}
                disabled={isConfirming}
                className="min-h-11 gap-1.5 text-xs"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                <span>{t('accounts.ofx.backToUpload')}</span>
              </Button>
            </div>

            {resolving ? (
              <div aria-busy="true" aria-live="polite" className="flex w-full flex-col gap-3">
                <p className="text-xs font-semibold text-muted-foreground tabular-nums">
                  {t('accounts.ofx.analyzing', { count: parsed?.total ?? 0 })}
                </p>
                <Skeleton className="h-10 w-full rounded-md" />
                <Skeleton className="h-64 w-full rounded-2xl" />
              </div>
            ) : (
              <div className="w-full min-w-0">
                <ImportStagingTable
                  rows={rows}
                  counts={counts}
                  confirmCount={confirmCount}
                  allNewSelected={allNewSelected}
                  categories={categories}
                  onToggleRow={toggleRow}
                  onToggleAll={toggleAll}
                  onCategoryChange={setCategory}
                  onConfirm={() => void handleConfirm()}
                  isConfirming={isConfirming}
                />
              </div>
            )}

            {confirmError ? (
              <Alert variant="destructive" role="alert">
                <AlertTitle>{t('accounts.ofx.confirmErrorTitle')}</AlertTitle>
                <AlertDescription className="flex flex-col gap-2">
                  <span>{confirmError}</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void handleConfirm()}
                    disabled={isConfirming}
                    className="min-h-11 w-fit gap-1.5 text-xs"
                  >
                    {t('common.retry')}
                  </Button>
                </AlertDescription>
              </Alert>
            ) : null}
          </section>
        ) : null}

        {phase === 'success' ? (
          <section aria-labelledby="import-success-heading" className="flex w-full flex-col items-center gap-4 py-6 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="h-7 w-7" />
            </div>
            <h2
              id="import-success-heading"
              ref={successHeadingRef}
              tabIndex={-1}
              data-testid="import-success-heading"
              className="text-lg font-bold text-foreground focus-visible:outline-none"
            >
              {t('accounts.ofx.successTitle')}
            </h2>
            <p className="text-sm text-muted-foreground tabular-nums">
              {t('accounts.ofx.successSummary', { count: report?.inserted ?? 0, account: activeNickname })}
            </p>
            <div className="flex flex-col items-stretch gap-3 sm:flex-row">
              <Button type="button" onClick={handleViewStatement} className="min-h-11 text-xs font-bold">
                {t('accounts.ofx.viewStatement')}
              </Button>
              <Button type="button" variant="outline" onClick={handleImportAnother} className="min-h-11 text-xs">
                {t('accounts.ofx.importAnother')}
              </Button>
            </div>
          </section>
        ) : null}
      </div>

      <Dialog open={discardOpen} onOpenChange={setDiscardOpen}>
        <DialogContent className="w-full min-w-0 sm:max-w-[440px] max-h-[92vh] overflow-y-auto overscroll-contain">
          <DialogHeader>
            <DialogTitle>{t('accounts.ofx.discardTitle')}</DialogTitle>
            <DialogDescription>{t('accounts.ofx.discardBody')}</DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-3 sm:space-x-0">
            <Button type="button" variant="outline" onClick={() => setDiscardOpen(false)} className="min-h-11">
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={handleDiscardConfirm}
              className="min-h-11"
            >
              {t('accounts.ofx.discardYes')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export default ImportOfxPage
