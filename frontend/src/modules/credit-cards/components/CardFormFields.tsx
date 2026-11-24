import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'
import { Input } from '@/components/shadcn/ui/input'
import { Label } from '@/components/shadcn/ui/label'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/shadcn/ui/select'
import { Badge } from '@/components/shadcn/ui/badge'
import { maskCentsInput, parseBRLToCents } from '@/lib/money'
import {
  cardIdentityFromPAN,
  CARD_THEMES,
  DEFAULT_CARD_THEME,
  detectCardBrand,
  InvalidCardNumberError,
  type CardBrand,
  type CardTheme,
} from '../model/credit-card'
import type { CreditCardInput } from '../model/credit-card'
import { cardBrandLabel } from './card-brand'
import { CARD_THEME_SWATCHES, CreditCardPreview } from './CreditCardPreview'

export interface CardAccountOption {
  id: string
  name: string
}

export type CardFormErrorKey =
  | 'nickname'
  | 'accountId'
  | 'limit'
  | 'closingDay'
  | 'dueDay'
  | 'cardNumber'
  | 'holderName'
  | 'expiry'
  | 'cvv'

export interface CardFormInitial {
  nickname: string
  accountId: string
  limitCents: number | null
  closingDay: number
  dueDay: number
}

// Hook-first: estado do formulário de cartão + validação + foco no 1º inválido.
// Bandeira é view-only (detectada pelo BIN, nunca persiste).
export function useCardForm(initial: CardFormInitial) {
  const { t } = useTranslation()
  const [nickname, setNickname] = useState(initial.nickname)
  const [cardNumber, setCardNumber] = useState('')
  const [holderName, setHolderName] = useState('')
  const [expiry, setExpiry] = useState('')
  const [cvv, setCvv] = useState('')
  const [theme, setTheme] = useState<CardTheme>(DEFAULT_CARD_THEME)
  const [isFlipped, setIsFlipped] = useState(false)
  const [accountId, setAccountId] = useState(initial.accountId)
  const [limitText, setLimitText] = useState(
    initial.limitCents === null ? '' : maskCentsInput(String(initial.limitCents)),
  )
  const [closingDayText, setClosingDayText] = useState(String(initial.closingDay))
  const [dueDayText, setDueDayText] = useState(String(initial.dueDay))
  const [errors, setErrors] = useState<Partial<Record<CardFormErrorKey, string>>>({})
  const [errorCodes, setErrorCodes] = useState<Partial<Record<CardFormErrorKey, string>>>({})

  const nicknameRef = useRef<HTMLInputElement>(null)
  const cardNumberRef = useRef<HTMLInputElement>(null)
  const accountTriggerRef = useRef<HTMLButtonElement>(null)
  const limitRef = useRef<HTMLInputElement>(null)
  const closingDayRef = useRef<HTMLInputElement>(null)
  const dueDayRef = useRef<HTMLInputElement>(null)
  const cvvRef = useRef<HTMLInputElement>(null)

  const brand: CardBrand = useMemo(() => detectCardBrand(cardNumber), [cardNumber])

  function validate(): { input: CreditCardInput; brand: CardBrand } | null {
    const next: Partial<Record<CardFormErrorKey, string>> = {}
    const codes: Partial<Record<CardFormErrorKey, string>> = {}
    const name = nickname.trim()
    if (name.length < 1 || name.length > 120) next.nickname = t('cards.nameError')
    if (!accountId) next.accountId = t('cards.accountRequired')
    const limitCents = parseBRLToCents(limitText)
    if (limitCents === null || limitCents <= 0) next.limit = t('cards.limitError')
    const closingDay = Number(closingDayText)
    if (!Number.isInteger(closingDay) || closingDay < 1 || closingDay > 31) {
      next.closingDay = t('cards.dayRangeError')
    }
    const dueDay = Number(dueDayText)
    if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) {
      next.dueDay = t('cards.dayRangeError')
    }

    // PAN não é persistido; só o last4 validado por Luhn sobrevive ao payload.
    let last4: string | null = null
    if (cardNumber.replace(/\D/g, '') !== '') {
      try {
        last4 = cardIdentityFromPAN(cardNumber).last4
      } catch (error) {
        if (error instanceof InvalidCardNumberError) {
          next.cardNumber = t('cards.preview.invalidCardNumber')
          codes.cardNumber = 'invalid-card-number'
        } else {
          throw error
        }
      }
      if (!holderName.trim()) next.holderName = t('cards.preview.holderError')
      if (!/^(0[1-9]|1[0-2])\/\d{2}$/.test(expiry.trim())) next.expiry = t('cards.preview.expiryError')
      if (!/^\d{3,4}$/.test(cvv.trim())) next.cvv = t('cards.preview.cvvError')
    }

    setErrors(next)
    setErrorCodes(codes)
    const order: CardFormErrorKey[] = [
      'nickname',
      'accountId',
      'limit',
      'closingDay',
      'dueDay',
      'cardNumber',
      'holderName',
      'expiry',
      'cvv',
    ]
    const first = order.find((key) => next[key] !== undefined)
    if (first || limitCents === null) {
      const targets: Record<CardFormErrorKey, React.RefObject<HTMLInputElement | null>> = {
        nickname: nicknameRef,
        cardNumber: cardNumberRef,
        accountId: { current: null },
        limit: limitRef,
        closingDay: closingDayRef,
        dueDay: dueDayRef,
        holderName: { current: null },
        expiry: { current: null },
        cvv: cvvRef,
      }
      if (first === 'accountId') accountTriggerRef.current?.focus()
      else if (first) targets[first].current?.focus()
      return null
    }

    const identity = last4
      ? {
          last4,
          holder_name: holderName.trim().toUpperCase(),
          expiry_mm_aa: expiry.trim(),
          theme,
        }
      : {}
    return {
      input: {
        name,
        brand,
        account_id: accountId,
        limit_cents: limitCents,
        closing_day: closingDay,
        due_day: dueDay,
        ...identity,
      },
      brand,
    }
  }

  return {
    nickname,
    setNickname,
    cardNumber,
    setCardNumber,
    cardNumberRef,
    holderName,
    setHolderName,
    expiry,
    setExpiry,
    cvv,
    setCvv,
    cvvRef,
    theme,
    setTheme,
    isFlipped,
    onCvvFocus: () => setIsFlipped(true),
    onCvvBlur: () => setIsFlipped(false),
    accountId,
    setAccountId,
    limitText,
    setLimitText,
    closingDayText,
    setClosingDayText,
    dueDayText,
    setDueDayText,
    errors,
    errorCodes,
    brand,
    nicknameRef,
    accountTriggerRef,
    limitRef,
    closingDayRef,
    dueDayRef,
    validate,
  }
}

export type CardForm = ReturnType<typeof useCardForm>

export function CardFormFields({ form, accounts }: { form: CardForm; accounts: CardAccountOption[] }) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-5">
      <CreditCardPreview
        variant="dialog"
        number={form.cardNumber}
        holderName={form.holderName}
        expiry={form.expiry}
        cvv={form.cvv}
        theme={form.theme}
        brand={form.brand}
        isFlipped={form.isFlipped}
      />

      <div className="grid grid-cols-1 gap-x-4 gap-y-3.5 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <Label htmlFor="card-nickname" className="text-xs font-medium">
          {t('cards.name')} *
        </Label>
        <Input
          id="card-nickname"
          name="nickname"
          ref={form.nicknameRef}
          value={form.nickname}
          onChange={(event) => form.setNickname(event.target.value)}
          placeholder={t('cards.namePlaceholder')}
          aria-invalid={form.errors.nickname ? true : undefined}
          className="h-10 w-full"
        />
        {form.errors.nickname ? (
          <p role="alert" className="text-xs text-destructive">
            {form.errors.nickname}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="card-number" className="text-xs font-medium">
          {t('cards.cardEnding')}
        </Label>
        <Input
          id="card-number"
          name="cardNumber"
          ref={form.cardNumberRef}
          value={form.cardNumber}
          onChange={(event) => form.setCardNumber(event.target.value)}
          inputMode="numeric"
          autoComplete="cc-number"
          maxLength={19}
          placeholder="0000 0000 0000 0000"
          aria-invalid={form.errors.cardNumber ? true : undefined}
          className="h-10 min-h-11 w-full font-mono tabular-nums"
        />
        {form.errors.cardNumber ? (
          <p role="alert" data-error-code={form.errorCodes.cardNumber} className="text-xs text-destructive">
            {form.errors.cardNumber}
          </p>
        ) : null}
      </div>
      <div className="flex flex-col justify-end gap-1.5">
        <span className="text-xs font-medium text-muted-foreground" aria-live="polite">
          {form.cardNumber.replace(/\D/g, '') === '' ? (
            t('cards.cardAria.last4Unknown')
          ) : (
            <Badge variant="secondary" className="w-fit text-[11px]">
              {cardBrandLabel(form.brand, t('cards.brandOther'))}
            </Badge>
          )}
        </span>
      </div>

      <div className="flex flex-col gap-1.5 sm:col-span-2">
        <Label htmlFor="card-holder" className="text-xs font-medium">
          {t('cards.preview.holderLabel')}
        </Label>
        <Input
          id="card-holder"
          name="holderName"
          value={form.holderName}
          onChange={(event) => form.setHolderName(event.target.value)}
          autoComplete="cc-name"
          maxLength={120}
          placeholder={t('cards.preview.holderPlaceholder')}
          aria-invalid={form.errors.holderName ? true : undefined}
          className="h-10 min-h-11 w-full font-mono tabular-nums"
        />
        {form.errors.holderName ? (
          <p role="alert" className="text-xs text-destructive">
            {form.errors.holderName}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="card-expiry" className="text-xs font-medium">
          {t('cards.preview.expiryLabel')}
        </Label>
        <Input
          id="card-expiry"
          name="expiry"
          value={form.expiry}
          onChange={(event) => form.setExpiry(event.target.value)}
          inputMode="numeric"
          autoComplete="cc-exp"
          maxLength={5}
          placeholder={t('cards.preview.expiryPlaceholder')}
          aria-invalid={form.errors.expiry ? true : undefined}
          className="h-10 min-h-11 w-full font-mono tabular-nums"
        />
        {form.errors.expiry ? (
          <p role="alert" className="text-xs text-destructive">
            {form.errors.expiry}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="card-cvv" className="text-xs font-medium">
          {t('cards.preview.cvvLabel')}
        </Label>
        <Input
          id="card-cvv"
          name="cvv"
          ref={form.cvvRef}
          value={form.cvv}
          onChange={(event) => form.setCvv(event.target.value)}
          onFocus={form.onCvvFocus}
          onBlur={form.onCvvBlur}
          inputMode="numeric"
          autoComplete="cc-csc"
          maxLength={4}
          placeholder={t('cards.preview.cvvPlaceholder')}
          aria-invalid={form.errors.cvv ? true : undefined}
          className="h-10 min-h-11 w-full font-mono tabular-nums"
        />
        {form.errors.cvv ? (
          <p role="alert" className="text-xs text-destructive">
            {form.errors.cvv}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-1.5 sm:col-span-2">
        <span className="text-xs font-medium text-foreground">{t('cards.preview.themeLabel')}</span>
        <div className="flex items-center gap-2">
          {CARD_THEMES.map((theme) => (
            <button
              key={theme}
              type="button"
              title={t(`cards.theme.${theme}`)}
              aria-label={t(`cards.theme.${theme}`)}
              aria-pressed={form.theme === theme}
              onClick={() => form.setTheme(theme)}
              className={cn(
                'flex min-h-11 min-w-11 items-center justify-center rounded-lg border p-1.5 transition-colors',
                'focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
                'motion-reduce:transition-none',
                form.theme === theme
                  ? 'ring-1 ring-primary ring-offset-1 ring-offset-background'
                  : 'border-border/70 hover:bg-accent',
              )}
            >
              <span className={cn('size-5 rounded-full border', CARD_THEME_SWATCHES[theme])} />
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-1.5 sm:col-span-2">
        <Label htmlFor="card-account" className="text-xs font-medium">
          {t('cards.account')} *
        </Label>
        <Select value={form.accountId} onValueChange={form.setAccountId}>
          <SelectTrigger id="card-account" ref={form.accountTriggerRef} className="h-10 w-full">
            <SelectValue placeholder={t('cards.selectAccount')} />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {accounts.map((account) => (
                <SelectItem key={account.id} value={account.id}>
                  {account.name}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        {form.errors.accountId ? (
          <p role="alert" className="text-xs text-destructive">
            {form.errors.accountId}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="card-limit" className="text-xs font-medium">
          {t('cards.limit')} *
        </Label>
        <div className="relative w-full">
          <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm font-semibold text-muted-foreground">
            R$
          </span>
          <Input
            id="card-limit"
            name="limit"
            ref={form.limitRef}
            value={form.limitText}
            onChange={(event) => form.setLimitText(event.target.value)}
            inputMode="decimal"
            placeholder="0,00"
            aria-invalid={form.errors.limit ? true : undefined}
            className="h-10 w-full pl-10 font-mono text-base font-bold tabular-nums"
          />
        </div>
        {form.errors.limit ? (
          <p role="alert" className="text-xs text-destructive">
            {form.errors.limit}
          </p>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="card-closing" className="text-xs font-medium">
            {t('cards.closingDay')} *
          </Label>
          <Input
            id="card-closing"
            name="closingDay"
            ref={form.closingDayRef}
            value={form.closingDayText}
            onChange={(event) => form.setClosingDayText(event.target.value)}
            inputMode="numeric"
            aria-invalid={form.errors.closingDay ? true : undefined}
            className="h-10 min-h-11 w-full font-mono tabular-nums"
          />
          {form.errors.closingDay ? (
            <p role="alert" className="text-xs text-destructive">
              {form.errors.closingDay}
            </p>
          ) : null}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="card-due" className="text-xs font-medium">
            {t('cards.dueDay')} *
          </Label>
          <Input
            id="card-due"
            name="dueDay"
            ref={form.dueDayRef}
            value={form.dueDayText}
            onChange={(event) => form.setDueDayText(event.target.value)}
            inputMode="numeric"
            aria-invalid={form.errors.dueDay ? true : undefined}
            className="h-10 min-h-11 w-full font-mono tabular-nums"
          />
          {form.errors.dueDay ? (
            <p role="alert" className="text-xs text-destructive">
              {form.errors.dueDay}
            </p>
          ) : null}
        </div>
      </div>
      </div>
    </div>
  )
}
