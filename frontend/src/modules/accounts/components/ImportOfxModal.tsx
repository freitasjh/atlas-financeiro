// P1.3 — modal reduzido a picker-atalho (sm:max-w-[440px]).
// Dropzone + conta + "Continuar para revisão" → handoff em memória
// (store transitório) + navigate. Sem staging, sem trava de conta,
// sem persistência; upload inline na página é o caminho principal.
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowRight, Upload } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/shadcn/ui/dialog'
import { Button } from '@/components/shadcn/ui/button'
import { Label } from '@/components/shadcn/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/shadcn/ui/select'
import { Alert, AlertDescription } from '@/components/shadcn/ui/alert'
import { bankLineText } from './AccountCard'
import { OfxDropzone } from './OfxDropzone'
import { ofxGuardMessage } from './ofx-errors'
import type { AccountViewItem } from '../model/view-model'
import { useOfxImport } from '../hooks/useOfxImport'
import { useSafeNavigate } from '../hooks/useSafeNavigate'
import { useOfxTransferStore } from '../store/ofx-transfer.store'

export interface OfxPickerPayload {
  fileText: string
  fileName: string
  accountId: string
}

interface ImportOfxModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  accounts: AccountViewItem[]
  initialAccountId?: string
  onContinueToReview?: (payload: OfxPickerPayload) => void
}

export function ImportOfxModal({
  open,
  onOpenChange,
  accounts,
  initialAccountId,
  onContinueToReview,
}: ImportOfxModalProps) {
  const { t } = useTranslation()
  const [selectedAccountId, setSelectedAccountId] = useState(initialAccountId || accounts[0]?.id || '')
  const [pickedText, setPickedText] = useState<string | null>(null)
  const [pickedName, setPickedName] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const accountsRef = useRef(accounts)
  accountsRef.current = accounts
  const { errorCode, isReading, pickFile, reset } = useOfxImport()
  const setTransfer = useOfxTransferStore((s) => s.setTransfer)
  const clearTransfer = useOfxTransferStore((s) => s.clearTransfer)
  const navigate = useSafeNavigate()

  useEffect(() => {
    if (!open) return
    setSelectedAccountId(initialAccountId || accountsRef.current[0]?.id || '')
    setFormError(null)
    setPickedText(null)
    setPickedName(null)
    reset()
    // Handoff one-shot: o store transitório é consumido pela página
    // /contas/importar; aqui não se limpa na abertura/fechamento para não
    // apagar o payload antes da navegação (só swap limpa).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialAccountId])

  const handleFiles = async (files: FileList | null) => {
    const file = files?.[0] ?? null
    setFormError(null)
    setPickedText(null)
    setPickedName(null)
    const text = await pickFile(file)
    if (text === null) return
    setPickedText(text)
    setPickedName(file?.name ?? null)
  }

  const handleSwap = () => {
    setPickedText(null)
    setPickedName(null)
    setFormError(null)
    reset()
    clearTransfer()
  }

  const handleContinue = () => {
    if (!pickedText || !pickedName || !selectedAccountId) return
    const payload: OfxPickerPayload = { fileText: pickedText, fileName: pickedName, accountId: selectedAccountId }
    setTransfer(payload)
    if (onContinueToReview) {
      onContinueToReview(payload)
    } else if (navigate) {
      navigate(`/contas/importar?conta=${encodeURIComponent(selectedAccountId)}`, { state: payload })
    } else {
      window.location.hash = `#/contas/importar?conta=${encodeURIComponent(selectedAccountId)}`
    }
    onOpenChange(false)
  }

  const guardMessage = ofxGuardMessage(t, errorCode, formError)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[92vh] w-full min-w-0 flex-col gap-0 overflow-hidden overscroll-contain p-0 sm:max-w-[440px]">
        <DialogHeader className="shrink-0 space-y-1 border-b border-border/70 p-5 text-left sm:p-6 sm:pb-4">
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Upload className="h-5 w-5" />
            </div>
            <div>
              <DialogTitle className="text-base font-bold">{t('accounts.ofx.title')}</DialogTitle>
              <DialogDescription className="text-xs">{t('accounts.ofx.hint')}</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-5 py-4 sm:px-6">
          <div className="flex flex-col gap-1.5">
            <Label id="ofx-account-label" htmlFor="ofx-account" className="block text-xs font-semibold text-foreground">
              {t('accounts.ofx.accountLabel')}
            </Label>
            <Select value={selectedAccountId} onValueChange={setSelectedAccountId}>
              <SelectTrigger id="ofx-account" aria-labelledby="ofx-account-label" className="h-11 min-h-11 w-full text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {accounts.map((account) => (
                  <SelectItem key={account.id} value={account.id} className="text-xs">
                    {account.nickname} ({bankLineText(t, account)})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <OfxDropzone size="compact" fileName={pickedName} isReading={isReading} onFiles={(f) => void handleFiles(f)} />

          {pickedName ? (
            <div className="flex justify-center">
              <button
                type="button"
                onClick={handleSwap}
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
        </div>

        <DialogFooter className="flex shrink-0 flex-row items-center justify-end gap-3 border-t border-border/70 bg-muted/20 px-5 py-3 sm:space-x-0 sm:px-6">
          <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)} className="min-h-11 text-xs">
            {t('common.cancel')}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={isReading || !pickedText || !selectedAccountId}
            onClick={handleContinue}
            className="min-h-11 gap-1.5 bg-primary text-xs font-bold text-primary-foreground"
          >
            <span>{t('accounts.ofx.continueToReview')}</span>
            <ArrowRight className="h-4 w-4" />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
