import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Building2, Landmark, Receipt } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/shadcn/ui/button'
import { PillToggle } from '@/components/shadcn/ui/pill-toggle'
import { useAccountsView, type AccountsViewMode } from '../hooks/useAccountsView'
import { useSafeNavigate } from '../hooks/useSafeNavigate'
import { SelectorBar } from './SelectorBar'
import { SummaryHeader } from './SummaryHeader'
import { AccountsGrid } from './AccountsGrid'
import { StatementTable } from './StatementTable'
import { TreasuryHeader } from './TreasuryHeader'
import { NewAccountModal } from './NewAccountModal'
import { EditAccountModal } from './EditAccountModal'
import { DeleteAccountDialog } from './DeleteAccountDialog'
import { TransferModal } from './TransferModal'
import { ImportOfxModal } from './ImportOfxModal'
import {
  computeTreasuryMetrics,
  type AccountViewItem,
  type EditBankAccountInput,
  type NewBankAccountInput,
  type StatementTxView,
} from '../model/view-model'

export interface AccountsViewProps {
  accounts: AccountViewItem[]
  transactions?: StatementTxView[]
  /** Estado real dos lançamentos (B-A12) — nunca renderizar vazio falso. */
  transactionsStatus?: 'idle' | 'loading' | 'ready' | 'error'
  onRetryTransactions?: () => void
  /** Total real de lançamentos no store (D2 — rodapé honesto). */
  transactionsTotalCount?: number
  initialViewMode?: AccountsViewMode
  selectedAccountId?: string
  onSelectAccount?: (id: string) => void
  onCreateAccount?: (input: NewBankAccountInput) => void | Promise<void>
  onUpdateAccount?: (id: string, input: EditBankAccountInput) => void | Promise<void>
  onDeleteAccount?: (id: string) => void | Promise<void>
  onExecuteTransfer?: (
    sourceAccountId: string,
    targetAccountId: string,
    amountCents: number,
    description: string,
    date: string,
  ) => void | Promise<boolean>
}

export function AccountsView({
  accounts,
  transactions = [],
  transactionsStatus,
  onRetryTransactions,
  transactionsTotalCount,
  initialViewMode = 'statements',
  selectedAccountId: selectedAccountIdProp,
  onSelectAccount,
  onCreateAccount,
  onUpdateAccount,
  onDeleteAccount,
  onExecuteTransfer,
}: AccountsViewProps) {
  const { t } = useTranslation()
  const navigate = useSafeNavigate()
  const internal = useAccountsView(accounts, initialViewMode)
  const [internalSelected, setInternalSelected] = useState('')
  const selectedAccountId = selectedAccountIdProp ?? internalSelected
  const setSelectedAccountId = onSelectAccount ?? setInternalSelected
  const activeAccount = useMemo(
    () => accounts.find((account) => account.id === selectedAccountId) ?? null,
    [accounts, selectedAccountId],
  )
  const metrics = useMemo(() => computeTreasuryMetrics(accounts), [accounts])
  const viewMode = internal.viewMode
  const setViewMode = internal.setViewMode

  const [newAccountOpen, setNewAccountOpen] = useState(false)
  const [transferOpen, setTransferOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [transferSourceId, setTransferSourceId] = useState('')
  const [importAccountId, setImportAccountId] = useState('')
  const [editTarget, setEditTarget] = useState<AccountViewItem | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<AccountViewItem | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return
    setIsDeleting(true)
    setDeleteError(null)
    try {
      await onDeleteAccount?.(deleteTarget.id)
      setDeleteTarget(null)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setDeleteError(
        message.includes('account-has-history') || message.includes('card-has-history')
          ? t('accounts.removeBlocked')
          : t('accounts.removeError'),
      )
    } finally {
      setIsDeleting(false)
    }
  }

  const openTransfer = (accountId?: string) => {
    setTransferSourceId(accountId ?? selectedAccountId ?? accounts[0]?.id ?? '')
    setTransferOpen(true)
  }

  const openImport = (accountId?: string) => {
    setImportAccountId(accountId ?? selectedAccountId ?? accounts[0]?.id ?? '')
    setImportOpen(true)
  }

  return (
    <div className="flex w-full flex-col gap-5 px-4 pb-8 lg:px-6">
      <div className="flex flex-col gap-4 border-b border-border/70 pb-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-xl font-bold tracking-tight text-foreground sm:text-2xl flex items-center gap-2">
              <Landmark className="h-6 w-6 text-primary" />
              {t('accounts.templateTitle')}
            </h1>
            <p className="text-xs text-muted-foreground mt-0.5">{t('accounts.templateSubtitle')}</p>
          </div>

          <div
            data-testid="accounts-toggle"
            className="flex w-fit max-w-full shrink-0 items-center self-start sm:self-end"
          >
            <PillToggle
              size="sm"
              value={viewMode}
              onChange={(value) => setViewMode(value as AccountsViewMode)}
              aria-label={t('accounts.toolbar.viewMode')}
              className="max-w-full shrink-0"
              options={[
                {
                  value: 'statements',
                  label: t('accounts.viewStatements'),
                  title: t('accounts.viewStatements'),
                  icon: <Receipt className="h-3.5 w-3.5" aria-hidden="true" />,
                },
                {
                  value: 'grid',
                  label: t('accounts.viewGrid'),
                  title: t('accounts.viewGrid'),
                  icon: <Building2 className="h-3.5 w-3.5" aria-hidden="true" />,
                },
              ]}
            />
          </div>
        </div>
      </div>

      {/* Barra de contas: sticky só funciona fora do bloco curto do header (B-A1) */}
      {viewMode === 'statements' && accounts.length > 0 && (
        <div
          role="group"
          aria-label={t('accounts.toolbar.viewsAndAccounts')}
          className="sticky top-(--header-height) z-10 w-full min-w-0 max-w-full bg-background/95 py-1 backdrop-blur"
        >
          <SelectorBar
            accounts={accounts}
            selectedAccountId={selectedAccountId}
            totalConsolidatedBalanceCents={metrics.totalConsolidatedBalanceCents}
            onSelectAccount={(id) => setSelectedAccountId(id)}
            onAddNewAccount={() => setNewAccountOpen(true)}
          />
        </div>
      )}

      {viewMode === 'statements' ? (
        <div data-testid="accounts-mode-section" className="flex flex-col gap-4">
          {accounts.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border/80 bg-muted/20 p-8 text-center">
              <p className="text-sm font-bold text-foreground">{t('accounts.empty')}</p>
              <p className="text-xs text-muted-foreground mt-1">{t('accounts.emptyHint')}</p>
              <Button type="button" onClick={() => setNewAccountOpen(true)} className="mt-4 min-h-11 text-xs font-bold">
                {t('accounts.grid.add')}
              </Button>
            </div>
          ) : (
            <>
              <SummaryHeader
                account={activeAccount}
                metrics={metrics}
                onOpenTransfer={() => openTransfer()}
                onOpenImportOFX={() => openImport()}
                onSyncAccount={() => toast.info(t('accounts.syncUnavailable'))}
              />
              <StatementTable
                account={activeAccount}
                transactions={transactions}
                isLoading={transactionsStatus === 'loading' || transactionsStatus === 'idle'}
                hasError={transactionsStatus === 'error'}
                totalCount={transactionsTotalCount}
                onRetryTransactions={onRetryTransactions}
                onReconcileTransaction={() => toast.info(t('accounts.reconcileUnavailable'))}
                onExportStatement={(format) => toast.info(t('accounts.exportUnavailable', { format: format.toUpperCase() }))}
              />
            </>
          )}
        </div>
      ) : (
        <div data-testid="accounts-mode-section" className="flex flex-col gap-4">
          <TreasuryHeader
            metrics={metrics}
            accountsCount={accounts.length}
            hideNewAccountAction={accounts.length === 0}
            onOpenNewAccount={() => setNewAccountOpen(true)}
            onOpenTransfer={() => openTransfer()}
            onOpenImportOFX={() => openImport()}
            onSyncAll={() => toast.info(t('accounts.syncUnavailable'))}
          />
          <AccountsGrid
            accounts={accounts}
            selectedAccountId={selectedAccountId}
            onSelectAccount={(account) => {
              setSelectedAccountId(account.id)
              setViewMode('statements')
            }}
            onOpenNewAccount={() => setNewAccountOpen(true)}
            onTransferFrom={(account) => openTransfer(account.id)}
            onImportOFX={(account) => openImport(account.id)}
            onEdit={(account) => setEditTarget(account)}
            onDelete={(account) => {
              setDeleteError(null)
              setDeleteTarget(account)
            }}
          />
        </div>
      )}

      <NewAccountModal
        open={newAccountOpen}
        onOpenChange={setNewAccountOpen}
        onSubmit={async (input) => {
          await onCreateAccount?.(input)
          setNewAccountOpen(false)
        }}
      />

      <EditAccountModal
        open={editTarget !== null}
        account={editTarget}
        onOpenChange={(open) => {
          if (!open) setEditTarget(null)
        }}
        onSubmit={async (input) => {
          if (!editTarget) return
          await onUpdateAccount?.(editTarget.id, input)
          setEditTarget(null)
        }}
      />

      <DeleteAccountDialog
        open={deleteTarget !== null}
        accountName={deleteTarget?.nickname ?? ''}
        error={deleteError}
        isDeleting={isDeleting}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null)
            setDeleteError(null)
          }
        }}
        onConfirm={() => void handleConfirmDelete()}
      />

      <TransferModal
        open={transferOpen}
        onOpenChange={setTransferOpen}
        accounts={accounts}
        initialSourceAccountId={transferSourceId}
        onExecuteTransfer={async (sourceId, targetId, amountCents, description, date) => {
          // Sem swallow: repassa o boolean do dono (ou a rejeição) direto ao
          // modal, que decide fechar (true) ou exibir erro inline (false/catch).
          return (await onExecuteTransfer?.(sourceId, targetId, amountCents, description, date)) ?? false
        }}
      />

      <ImportOfxModal
        open={importOpen}
        onOpenChange={setImportOpen}
        accounts={accounts}
        initialAccountId={importAccountId}
        onContinueToReview={(payload) => {
          navigate?.(`/contas/importar?conta=${encodeURIComponent(payload.accountId)}`, {
            state: payload,
          })
        }}
      />
    </div>
  )
}
