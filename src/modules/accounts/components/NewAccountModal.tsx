import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Building2, CheckCircle2, ChevronLeft, ChevronRight, ShieldCheck, Zap } from 'lucide-react'
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
import { Alert, AlertDescription, AlertTitle } from '@/components/shadcn/ui/alert'
import { cn } from '@/lib/cn'
import { formatCentsBRL } from '@/lib/utils'
import { parseBRLToCents, maskCentsInput } from '@/lib/money'
import {
  INSTITUTION_CODES,
  institutionInfo,
  type AccountType,
  type InstitutionCode,
  type NewBankAccountInput,
} from '../model/view-model'

interface NewAccountModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (input: NewBankAccountInput) => void | Promise<void>
}

const TYPE_LABEL_KEY: Record<AccountType, string> = {
  checking: 'accounts.typeChecking',
  savings: 'accounts.typeSavings',
  investment: 'accounts.typeInvestment',
  wallet: 'accounts.typeWallet',
  physical_cash: 'accounts.typePhysicalCash',
}

const TYPE_SHORT_KEY: Record<AccountType, string> = {
  checking: 'accounts.typeChecking',
  investment: 'accounts.typeInvestment',
  wallet: 'accounts.typeWallet',
  savings: 'accounts.typeSavings',
  physical_cash: 'accounts.typePhysicalCash',
}

export function NewAccountModal({ open, onOpenChange, onSubmit }: NewAccountModalProps) {
  const { t } = useTranslation()
  const [institution, setInstitution] = useState<InstitutionCode>('itau')
  const [accountType, setAccountType] = useState<AccountType>('checking')
  const [nickname, setNickname] = useState('')
  const [agency, setAgency] = useState('')
  const [accountNumber, setAccountNumber] = useState('')
  const [accountDigit, setAccountDigit] = useState('')
  const [initialBalance, setInitialBalance] = useState('')
  const [connectionMethod, setConnectionMethod] = useState<'open_finance' | 'manual'>('manual')
  const [isDefault, setIsDefault] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [errorTarget, setErrorTarget] = useState<'nickname' | 'balance' | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const carouselRef = useRef<HTMLDivElement>(null)
  const nicknameRef = useRef<HTMLInputElement>(null)
  const balanceRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setFormError(null)
    setErrorTarget(null)
    setIsSubmitting(false)
  }, [open ])

  const resetForm = () => {
    setInstitution('itau')
    setAccountType('checking')
    setNickname('')
    setAgency('')
    setAccountNumber('')
    setAccountDigit('')
    setInitialBalance('')
    setConnectionMethod('manual')
    setIsDefault(false)
    setFormError(null)
    setErrorTarget(null)
  }

  const scrollCarousel = (direction: 'left' | 'right') => {
    if (carouselRef.current) {
      const scrollAmount = direction === 'left' ? -280 : 280
      carouselRef.current.scrollBy({ left: scrollAmount, behavior: 'smooth' })
    }
  }

  const handleBlurBalance = () => {
    const cents = parseBRLToCents(initialBalance)
    if (cents !== null && cents >= 0) setInitialBalance(formatCentsBRL(cents).replace(/^R\$\s?/, ''))
  }

  const institutionDisplayName = (code: InstitutionCode): string =>
    code === 'other' ? t('accounts.otherInstitution') : institutionInfo(code).name

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (nickname.trim() === '') {
      setFormError(t('accounts.nameError'))
      setErrorTarget('nickname')
      nicknameRef.current?.focus()
      return
    }
    const cents = parseBRLToCents(initialBalance.trim() === '' ? '0' : initialBalance)
    if (cents === null || cents < 0) {
      setFormError(t('accounts.balanceError'))
      setErrorTarget('balance')
      balanceRef.current?.focus()
      return
    }

    setFormError(null)
    setErrorTarget(null)
    setIsSubmitting(true)
    try {
      await onSubmit({
        name: nickname.trim(),
        type: accountType,
        institution,
        agency: agency.trim(),
        accountNumber: accountNumber.trim(),
        accountDigit: accountDigit.trim(),
        initialBalanceCents: cents,
        connectionStatus: connectionMethod === 'open_finance' ? 'connected' : 'manual',
        isDefault,
      })
      resetForm()
      onOpenChange(false)
    } catch {
      setFormError(t('accounts.saveError'))
      setErrorTarget(null)
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-full sm:max-w-2xl max-h-[92vh] flex flex-col p-0 gap-0 overflow-hidden">
        <DialogHeader className="p-5 sm:p-6 pb-4 border-b border-border/70 shrink-0">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary border border-primary/20">
              <Building2 className="h-5 w-5" />
            </div>
            <div>
              <DialogTitle className="text-lg font-bold text-foreground">{t('accounts.newTitle')}</DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground mt-0.5">{t('accounts.newHint')}</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col flex-1 min-h-0" noValidate>
          <div className="flex-1 overflow-y-auto overscroll-contain p-5 sm:p-6 space-y-5">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                  {t('accounts.institution')}
                </span>
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label={t('accounts.carouselPrev')}
                    onClick={() => scrollCarousel('left')}
                    className="min-h-11 min-w-11 rounded-lg border-border/70 hover:bg-muted sm:h-8 sm:min-h-8 sm:min-w-8"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label={t('accounts.carouselNext')}
                    onClick={() => scrollCarousel('right')}
                    className="min-h-11 min-w-11 rounded-lg border-border/70 hover:bg-muted sm:h-8 sm:min-h-8 sm:min-w-8"
                  >
                    <ChevronRight className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>

              <div
                ref={carouselRef}
                data-testid="institution-carousel"
                className="flex items-center gap-2.5 overflow-x-auto pb-1.5 pt-0.5 snap-x"
                style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
              >
                {INSTITUTION_CODES.map((code) => {
                  const info = institutionInfo(code)
                  const isSelected = institution === code
                  return (
                    <button
                      key={code}
                      type="button"
                      aria-pressed={isSelected}
                      onClick={() => {
                        setInstitution(code)
                        if (!nickname || nickname.includes('•')) {
                          setNickname(`${institutionDisplayName(code)} • ${t('accounts.operationalSuffix')}`)
                        }
                      }}
                      className={cn(
                        'group relative flex shrink-0 w-[170px] snap-start items-center gap-3 rounded-xl border p-2.5 text-left transition-all cursor-pointer shadow-xs',
                        isSelected
                          ? 'border-primary bg-primary/10 ring-1 ring-primary/30'
                          : 'border-border/80 bg-card hover:border-border hover:bg-muted/40',
                      )}
                    >
                      <div className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-xs font-bold border shadow-2xs', info.lightBg)}>
                        {info.iconInitials}
                      </div>
                      <div className="min-w-0 flex-1">
                        <span className="text-xs font-bold truncate block leading-tight text-foreground">
                          {institutionDisplayName(code)}
                        </span>
                        <span className="text-[10px] text-muted-foreground font-mono tabular-nums">COMPE: {info.compe}</span>
                      </div>
                      {isSelected && <div className="absolute right-2 top-2 h-2 w-2 rounded-full bg-primary" />}
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <fieldset className="space-y-1.5">
                <legend className="text-xs font-semibold text-foreground block">{t('accounts.typeLabel')}</legend>
                <div className="grid grid-cols-3 gap-1.5">
                  {(['checking', 'investment', 'wallet'] as AccountType[]).map((type) => (
                    <button
                      key={type}
                      type="button"
                      aria-pressed={accountType === type}
                      onClick={() => setAccountType(type)}
                      className={cn(
                        'min-h-11 py-2 px-1.5 rounded-lg border text-xs text-center transition-all truncate',
                        accountType === type
                          ? 'border-primary bg-primary/10 text-primary font-bold shadow-2xs ring-1 ring-primary/20'
                          : 'border-border/80 bg-card text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {t(TYPE_SHORT_KEY[type])}
                    </button>
                  ))}
                </div>
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {(['savings', 'physical_cash'] as AccountType[]).map((type) => (
                    <button
                      key={type}
                      type="button"
                      aria-pressed={accountType === type}
                      onClick={() => setAccountType(type)}
                      className={cn(
                        'min-h-11 py-2 px-2.5 rounded-lg border text-xs text-center transition-all',
                        accountType === type
                          ? 'border-primary bg-primary/10 text-primary font-bold shadow-2xs ring-1 ring-primary/20'
                          : 'border-border/80 bg-card text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {t(TYPE_LABEL_KEY[type])}
                    </button>
                  ))}
                </div>
              </fieldset>

              <div className="space-y-1.5">
                <label htmlFor="new-account-nickname" className="text-xs font-semibold text-foreground block">
                  {t('accounts.nickname')}
                </label>
                <Input
                  id="new-account-nickname"
                  ref={nicknameRef}
                  type="text"
                  placeholder={t('accounts.nicknamePlaceholder')}
                  value={nickname}
                  onChange={(e) => setNickname(e.target.value)}
                  aria-invalid={errorTarget === 'nickname'}
                  aria-describedby={errorTarget === 'nickname' ? 'new-account-nickname-error' : undefined}
                  className="h-11 min-h-11 text-xs w-full"
                />
                {errorTarget === 'nickname' && (
                  <p id="new-account-nickname-error" role="alert" className="text-xs font-medium text-destructive">
                    {t('accounts.nameError')}
                  </p>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-12 gap-3.5">
              <div className="sm:col-span-3 space-y-1.5">
                <label htmlFor="new-account-agency" className="text-xs font-semibold text-foreground block">
                  {t('accounts.agency')}
                </label>
                <Input
                  id="new-account-agency"
                  type="text"
                  placeholder="0001"
                  value={agency}
                  onChange={(e) => setAgency(e.target.value)}
                  className="h-11 min-h-11 text-xs font-mono tabular-nums w-full"
                />
              </div>
              <div className="sm:col-span-4 space-y-1.5">
                <label htmlFor="new-account-number" className="text-xs font-semibold text-foreground block">
                  {t('accounts.accountNumber')}
                </label>
                <Input
                  id="new-account-number"
                  type="text"
                  placeholder="12345"
                  value={accountNumber}
                  onChange={(e) => setAccountNumber(e.target.value)}
                  className="h-11 min-h-11 text-xs font-mono tabular-nums w-full"
                />
              </div>
              <div className="sm:col-span-2 space-y-1.5">
                <label htmlFor="new-account-digit" className="text-xs font-semibold text-foreground block">
                  {t('accounts.accountDigit')}
                </label>
                <Input
                  id="new-account-digit"
                  type="text"
                  placeholder="0"
                  maxLength={2}
                  value={accountDigit}
                  onChange={(e) => setAccountDigit(e.target.value)}
                  className="h-11 min-h-11 text-xs font-mono tabular-nums text-center w-full"
                />
              </div>
              <div className="sm:col-span-3 space-y-1.5">
                <label htmlFor="new-account-balance" className="text-xs font-semibold text-foreground block">
                  {t('accounts.initialBalance')}
                </label>
                <div className="relative w-full">
                  <span className="pointer-events-none absolute inset-y-0 left-2.5 my-auto text-xs font-semibold text-muted-foreground">
                    R$
                  </span>
                  <Input
                    id="new-account-balance"
                    ref={balanceRef}
                    type="text"
                    inputMode="decimal"
                    placeholder={t('accounts.initialPlaceholder')}
                    value={initialBalance}
                    onChange={(e) => setInitialBalance(maskCentsInput(e.target.value))}
                    onBlur={handleBlurBalance}
                    aria-invalid={errorTarget === 'balance'}
                    aria-describedby={errorTarget === 'balance' ? 'new-account-balance-error' : undefined}
                    className="pl-10 h-11 min-h-11 text-xs font-mono tabular-nums font-bold w-full"
                  />
                </div>
                {errorTarget === 'balance' && (
                  <p id="new-account-balance-error" role="alert" className="text-xs font-medium text-destructive">
                    {t('accounts.balanceError')}
                  </p>
                )}
              </div>
            </div>

            <div className="space-y-1.5">
              <span className="text-xs font-semibold text-foreground block">{t('accounts.connection')}</span>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <button
                  type="button"
                  aria-pressed={connectionMethod === 'open_finance'}
                  onClick={() => setConnectionMethod('open_finance')}
                  className={cn(
                    'min-h-11 p-3 rounded-xl border text-left transition-all cursor-pointer shadow-xs',
                    connectionMethod === 'open_finance'
                      ? 'border-emerald-500/60 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 ring-1 ring-emerald-500/30'
                      : 'border-border/80 bg-card text-muted-foreground hover:text-foreground',
                  )}
                >
                  <div className="flex items-center gap-1.5 text-xs font-bold mb-1">
                    <Zap className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                    <span>{t('accounts.openFinance')}</span>
                  </div>
                  <span className="text-[11px] text-muted-foreground block leading-tight">{t('accounts.openFinanceHint')}</span>
                </button>

                <button
                  type="button"
                  aria-pressed={connectionMethod === 'manual'}
                  onClick={() => setConnectionMethod('manual')}
                  className={cn(
                    'min-h-11 p-3 rounded-xl border text-left transition-all cursor-pointer shadow-xs',
                    connectionMethod === 'manual'
                      ? 'border-emerald-500/60 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 ring-1 ring-emerald-500/30'
                      : 'border-border/80 bg-card text-muted-foreground hover:text-foreground',
                  )}
                >
                  <div className="flex items-center gap-1.5 text-xs font-bold mb-1">
                    <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                    <span>{t('accounts.manualOfx')}</span>
                  </div>
                  <span className="text-[11px] text-muted-foreground block leading-tight">{t('accounts.manualOfxHint')}</span>
                </button>
              </div>
            </div>

            <div className="flex items-center gap-2.5 pt-0.5">
              <input
                type="checkbox"
                id="new-account-default"
                checked={isDefault}
                onChange={(e) => setIsDefault(e.target.checked)}
                className="h-4 w-4 rounded border-border text-primary focus:ring-primary cursor-pointer"
              />
              <label htmlFor="new-account-default" className="text-xs font-medium text-foreground cursor-pointer select-none">
                {t('accounts.defaultAccount')}
              </label>
            </div>

            {formError && errorTarget === null ? (
              <Alert variant="destructive" role="alert">
                <AlertTitle>{t('common.error')}</AlertTitle>
                <AlertDescription>{formError}</AlertDescription>
              </Alert>
            ) : null}
          </div>

          <DialogFooter className="p-4 sm:px-6 border-t border-border/70 bg-muted/20 shrink-0 flex flex-row items-center justify-end gap-3 sm:space-x-0">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                resetForm()
                onOpenChange(false)
              }}
              className="text-xs h-11 min-h-11 px-4"
            >
              {t('common.cancel')}
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={isSubmitting}
              aria-busy={isSubmitting}
              className="text-xs font-bold h-11 min-h-11 px-4 gap-1.5 bg-primary text-primary-foreground"
            >
              <CheckCircle2 className="h-4 w-4" />
              <span>{t('accounts.saveBankAccount')}</span>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
