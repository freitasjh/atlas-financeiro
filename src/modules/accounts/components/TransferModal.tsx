import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeftRight, Calendar, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/shadcn/ui/dialog'
import { Button } from '@/components/shadcn/ui/button'
import { Input } from '@/components/shadcn/ui/input'
import { Label } from '@/components/shadcn/ui/label'
import { Alert, AlertDescription } from '@/components/shadcn/ui/alert'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/shadcn/ui/select'
import { formatCentsBRL } from '@/lib/utils'
import { parseBRLToCents, maskCentsInput } from '@/lib/money'
import { todayLocalISO } from '../model/account'
import type { AccountViewItem } from '../model/view-model'

interface TransferModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  accounts: AccountViewItem[]
  initialSourceAccountId?: string
  onExecuteTransfer: (sourceAccountId: string, targetAccountId: string, amountCents: number, description: string, date: string) => Promise<boolean>
}

export function TransferModal({ open, onOpenChange, accounts, initialSourceAccountId, onExecuteTransfer }: TransferModalProps) {
  const { t } = useTranslation()
  const [sourceId, setSourceId] = useState(initialSourceAccountId || accounts[0]?.id || '')
  const [targetId, setTargetId] = useState(accounts.find((a) => a.id !== (initialSourceAccountId || accounts[0]?.id))?.id || '')
  const [amount, setAmount] = useState('')
  const [date, setDate] = useState(() => todayLocalISO())
  const [description, setDescription] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const prevOpenRef = useRef(false)
  const prevSourceRef = useRef<string | undefined>(undefined)

  // Reset só na transição de abertura (closed → open) ou troca de origem
  // inicial com o modal aberto. Reload de accounts com o modal fechado/aberto
  // NÃO apaga a digitação: accounts é lido mas não é dependência do efeito.
  useEffect(() => {
    const justOpened = open && !prevOpenRef.current
    const sourceChanged = open && prevOpenRef.current && prevSourceRef.current !== initialSourceAccountId
    prevOpenRef.current = open
    prevSourceRef.current = initialSourceAccountId
    if (!open || (!justOpened && !sourceChanged)) return
    const nextSource = initialSourceAccountId || accounts[0]?.id || ''
    setSourceId(nextSource)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    setTargetId(accounts.find((a) => a.id !== nextSource)?.id || '')
    setAmount('')
    setDate(todayLocalISO())
    setDescription(t('accounts.transferDefaultDescription'))
    setFormError(null)
    setIsSubmitting(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialSourceAccountId])

  const sourceAccount = accounts.find((a) => a.id === sourceId)
  const targetAccount = accounts.find((a) => a.id === targetId)
  const amountCents = parseBRLToCents(amount.trim() === '' ? '0' : amount) ?? -1
  const isInsufficient = sourceAccount ? amountCents > sourceAccount.currentBalanceCents : false

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (isSubmitting) return
    if (!sourceId || !targetId || sourceId === targetId) {
      setFormError(t('accounts.transferSameAccount'))
      return
    }
    if (amountCents <= 0) {
      setFormError(t('accounts.transferInvalidAmount'))
      return
    }
    if (isInsufficient) {
      setFormError(t('accounts.transferInsufficient'))
      return
    }
    setFormError(null)
    setIsSubmitting(true)
    try {
      const ok = await onExecuteTransfer(sourceId, targetId, amountCents, description, date)
      if (ok) {
        onOpenChange(false)
        setAmount('')
      } else {
        setFormError(t('accounts.transferError'))
      }
    } catch {
      // Dono rejeitou (rede/RPC): mantém o modal aberto com erro inline
      // para o usuário corrigir e tentar de novo. Sem toast aqui — o dono
      // já toasta; este modal só exibe o inline.
      setFormError(t('accounts.transferError'))
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[92vh] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-[480px]">
        <DialogHeader className="shrink-0 space-y-1 border-b border-border/70 p-5 text-left sm:p-6 sm:pb-4">
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <ArrowLeftRight className="h-5 w-5" />
            </div>
            <div>
              <DialogTitle className="text-base font-bold">{t('accounts.transfer.title')}</DialogTitle>
              <DialogDescription className="text-xs">{t('accounts.transfer.hint')}</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <form onSubmit={(e) => void handleSubmit(e)} className="flex min-h-0 flex-1 flex-col" noValidate>
          <div
            data-testid="transfer-modal-body"
            className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-5 sm:p-6"
          >
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <Label id="transfer-source-label" htmlFor="transfer-source" className="font-semibold text-foreground">
                  {t('accounts.sourceAccount')}
                </Label>
                {sourceAccount && (
                  <span className="text-[11px] text-muted-foreground font-mono tabular-nums">
                    {t('accounts.transfer.balanceShort')} {formatCentsBRL(sourceAccount.currentBalanceCents)}
                  </span>
                )}
              </div>
              <Select value={sourceId} onValueChange={setSourceId}>
                <SelectTrigger id="transfer-source" aria-labelledby="transfer-source-label" className="h-11 min-h-11 w-full text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {accounts.map((account) => (
                    <SelectItem key={account.id} value={account.id} disabled={account.id === targetId} className="text-xs">
                      {account.nickname} • {t('accounts.transfer.balanceShort')} {formatCentsBRL(account.currentBalanceCents)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <Label id="transfer-target-label" htmlFor="transfer-target" className="font-semibold text-foreground">
                  {t('accounts.targetAccount')}
                </Label>
                {targetAccount && (
                  <span className="text-[11px] text-muted-foreground font-mono tabular-nums">
                    {t('accounts.transfer.targetBalance')} {formatCentsBRL(targetAccount.currentBalanceCents)}
                  </span>
                )}
              </div>
              <Select value={targetId} onValueChange={setTargetId}>
                <SelectTrigger id="transfer-target" aria-labelledby="transfer-target-label" className="h-11 min-h-11 w-full text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {accounts.map((account) => (
                    <SelectItem key={account.id} value={account.id} disabled={account.id === sourceId} className="text-xs">
                      {account.nickname} • {t('accounts.transfer.balanceShort')} {formatCentsBRL(account.currentBalanceCents)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="transfer-amount" className="text-xs font-semibold text-foreground block">
                {t('accounts.transfer.amountLabel')}
              </Label>
              <div className="relative">
                <span className="pointer-events-none absolute inset-y-0 left-3 my-auto text-xs font-semibold text-muted-foreground">
                  R$
                </span>
                <Input
                  id="transfer-amount"
                  type="text"
                  inputMode="decimal"
                  placeholder={t('accounts.transfer.amountPlaceholder')}
                  value={amount}
                  onChange={(e) => setAmount(maskCentsInput(e.target.value))}
                  aria-invalid={formError !== null}
                  className="pl-10 h-11 min-h-11 text-base font-mono font-bold tabular-nums bg-background border-border/80"
                />
              </div>
              {isInsufficient && (
                <p className="text-xs text-destructive flex items-center gap-1 font-medium" role="alert">
                  <AlertCircle className="h-3.5 w-3.5" />
                  {t('accounts.transferInsufficient')}
                </p>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label htmlFor="transfer-date" className="text-xs font-semibold text-foreground block">
                  {t('accounts.transfer.dateLabel')}
                </Label>
                <div className="relative">
                  <Calendar className="absolute inset-y-0 left-3 my-auto h-4 w-4 text-muted-foreground" />
                  <Input
                    id="transfer-date"
                    type="date"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    className="pl-9 h-11 min-h-11 text-xs bg-background border-border/80 tabular-nums"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="transfer-description" className="text-xs font-semibold text-foreground block">
                  {t('accounts.transfer.descriptionLabel')}
                </Label>
                <Input
                  id="transfer-description"
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder={t('accounts.transfer.descriptionPlaceholder')}
                  className="h-11 min-h-11 text-xs bg-background border-border/80"
                />
              </div>
            </div>

            {formError ? (
              <Alert variant="destructive" role="alert">
                <AlertDescription>{formError}</AlertDescription>
              </Alert>
            ) : null}
          </div>

          <DialogFooter className="shrink-0 justify-end gap-3 border-t border-border/60 bg-muted/20 px-5 py-3 sm:space-x-0 sm:px-6">
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)} className="text-xs min-h-11">
              {t('accounts.transfer.cancel')}
            </Button>
            <Button
              type="submit"
              disabled={amountCents <= 0 || isInsufficient || sourceId === targetId || isSubmitting}
              aria-busy={isSubmitting}
              className="text-xs font-bold gap-1.5 bg-primary text-primary-foreground min-h-11"
            >
              {isSubmitting ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
              )}
              <span>{t('accounts.transfer.confirm')}</span>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
