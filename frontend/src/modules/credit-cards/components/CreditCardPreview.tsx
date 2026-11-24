import { useTranslation } from 'react-i18next'
import { Wifi } from 'lucide-react'
import { cn } from '@/lib/cn'
import type { CardBrand, CardTheme } from '../model/credit-card'
import { CardIdentity } from './CardIdentity'

// ADR-006: contrato visual congelado. Temas, bandeiras e geometria são copiados
// como DADO da galeria (somente leitura) — nenhum import de shadcn/credit-card.
// A arte é objeto representado (aria-hidden), não superfície estrutural: nenhuma
// cor da tabela vaza para Card/Dialog/Button/Input/tabela/shell. Sem prop className.
export type CreditCardPreviewProps =
  | {
      variant: 'dialog'
      number: string
      holderName: string
      expiry: string
      cvv: string
      theme: CardTheme
      brand: CardBrand
      isFlipped: boolean
    }
  | {
      variant: 'wallet'
      last4: string | null
      holderName: string | null
      expiry: string | null
      theme: CardTheme
      brand: CardBrand
      isFlipped?: never
    }
  | {
      variant: 'chip'
      theme: CardTheme
      brand: CardBrand
      isFlipped?: never
    }

const THEME_ART: Record<CardTheme, string> = {
  midnight: 'from-neutral-900 via-neutral-800 to-black text-white border-neutral-700/60',
  emerald: 'from-emerald-950 via-emerald-900 to-neutral-950 text-white border-emerald-700/60',
  violet: 'from-violet-950 via-purple-900 to-neutral-950 text-white border-purple-700/60',
  platinum: 'from-slate-700 via-neutral-600 to-slate-800 text-white border-slate-500/60',
  rose_gold: 'from-rose-950 via-rose-900 to-neutral-900 text-white border-rose-700/60',
}

export const CARD_THEME_SWATCHES: Record<CardTheme, string> = {
  midnight: 'bg-neutral-900 border-neutral-700',
  emerald: 'bg-emerald-900 border-emerald-700',
  violet: 'bg-purple-900 border-purple-700',
  platinum: 'bg-slate-600 border-slate-400',
  rose_gold: 'bg-rose-900 border-rose-700',
}

function displayNumber(number: string): string {
  if (number.trim() === '') return '•••• •••• •••• ••••'
  const digits = number.replace(/\D/g, '')
  const padded = digits.padEnd(16, '•')
  const groups = padded.match(/.{1,4}/g)
  return groups ? groups.join(' ') : padded
}

function BrandMark({ brand, compact = false }: { brand: CardBrand; compact?: boolean }) {
  switch (brand) {
    case 'visa':
      return (
        <span
          data-testid="card-preview-brand"
          className={cn(
            'font-sans font-black italic tracking-tighter text-white select-none',
            compact ? 'text-[8px]' : 'text-xl',
          )}
        >
          VISA
        </span>
      )
    case 'mastercard':
      return (
        <span className="flex items-center -space-x-2 select-none" data-testid="card-preview-brand">
          <span data-testid="card-preview-brand-circle" className="h-6 w-6 rounded-full bg-red-600 opacity-90 shadow-xs" />
          <span
            data-testid="card-preview-brand-circle"
            className="h-6 w-6 rounded-full bg-amber-500 opacity-90 shadow-xs"
          />
        </span>
      )
    case 'elo':
      return (
        <span
          data-testid="card-preview-brand"
          className={cn('flex items-center gap-1 select-none font-bold tracking-tight', compact ? 'text-[10px]' : 'text-lg')}
        >
          <span className="text-amber-400">e</span>
          <span className="text-cyan-400">l</span>
          <span className="text-red-500">o</span>
        </span>
      )
    case 'amex':
      return (
        <span
          data-testid="card-preview-brand"
          className="rounded bg-blue-600 px-1.5 py-0.5 text-[10px] font-extrabold tracking-widest text-white uppercase select-none"
        >
          AMEX
        </span>
      )
    case 'hipercard':
      return (
        <span
          data-testid="card-preview-brand"
          className="rounded bg-red-700 px-1.5 py-0.5 text-[10px] font-bold text-white uppercase select-none"
        >
          HIPER
        </span>
      )
    default:
      return (
        <span
          data-testid="card-preview-brand"
          className="flex h-6 w-10 items-center justify-center rounded border border-white/20 bg-white/10 font-mono text-[9px] text-white/70"
        >
          CARD
        </span>
      )
  }
}

function EmvChip() {
  return (
    <span className="relative h-7 w-9 rounded-md border border-amber-600/40 bg-gradient-to-br from-amber-200 via-amber-400 to-yellow-600 shadow-inner overflow-hidden sm:h-8 sm:w-11">
      <span className="absolute inset-x-1 top-2.5 h-px bg-amber-800/40" />
      <span className="absolute inset-x-1 bottom-2.5 h-px bg-amber-800/40" />
      <span className="absolute inset-y-1 left-3 w-px bg-amber-800/40" />
    </span>
  )
}

function FrontFace({
  theme,
  brand,
  number,
  holder,
  expiry,
  holderPlaceholder,
  expiryPlaceholder,
  identity,
}: {
  theme: CardTheme
  brand: CardBrand
  number?: string
  holder: string | null
  expiry: string | null
  holderPlaceholder: string
  expiryPlaceholder: string
  identity?: React.ReactNode
}) {
  return (
    <div
      data-testid="card-preview-art"
      className={cn(
        'absolute inset-0 flex flex-col justify-between rounded-2xl border p-5 shadow-lg overflow-hidden bg-gradient-to-br backface-hidden sm:p-6',
        THEME_ART[theme],
      )}
    >
      <div className="pointer-events-none absolute -top-16 -right-16 h-48 w-48 rounded-full bg-white/10 blur-2xl" />

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <EmvChip />
          <Wifi className="h-4 w-4 rotate-90 text-white/80 opacity-80" />
        </div>
        <BrandMark brand={brand} />
      </div>

      {number !== undefined ? (
        <div className="my-auto py-1">
          <div
            data-testid="card-preview-number"
            className="truncate font-mono text-base font-bold tracking-[0.18em] text-white/95 tabular-nums drop-shadow-sm sm:text-xl"
          >
            {number}
          </div>
        </div>
      ) : identity !== undefined ? (
        <div className="my-auto py-1">{identity}</div>
      ) : null}

      <div className="flex items-end justify-between pt-1">
        <div className="max-w-[70%]">
          <span data-testid="card-preview-holder-caption" className="block text-[9px] font-semibold tracking-wider text-white/70 uppercase">
            {holderPlaceholder}
          </span>
          {holder != null ? (
            <span
              data-testid="card-preview-holder"
              className="block truncate font-mono text-xs font-bold tracking-wider text-white tabular-nums sm:text-sm"
            >
              {holder}
            </span>
          ) : null}
        </div>
        <div className="text-right">
          <span data-testid="card-preview-expiry-caption" className="block text-[9px] font-semibold tracking-wider text-white/70 uppercase">
            {expiryPlaceholder}
          </span>
          {expiry != null ? (
            <span
              data-testid="card-preview-expiry"
              className="block font-mono text-xs font-bold tracking-wider text-white tabular-nums sm:text-sm"
            >
              {expiry}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function BackFace({
  theme,
  brand,
  cvv,
  cvvCaption,
  signatureLabel,
  disclaimer,
}: {
  theme: CardTheme
  brand: CardBrand
  cvv: string
  cvvCaption: string
  signatureLabel: string
  disclaimer: string
}) {
  return (
    <div
      data-testid="card-preview-art"
      className={cn(
        'absolute inset-0 flex flex-col justify-between rounded-2xl border py-5 shadow-lg overflow-hidden bg-gradient-to-br rotate-y-180 backface-hidden sm:py-6',
        THEME_ART[theme],
      )}
    >
      <div className="-mt-1 h-10 w-full bg-black/90 shadow-inner sm:h-11" />
      <div className="space-y-1 px-5 sm:px-6">
        <div className="flex items-center justify-between text-[9px] font-semibold text-white/70 uppercase">
          <span data-testid="card-preview-signature-caption">{signatureLabel}</span>
          <span data-testid="card-preview-cvv-caption" className="text-white/70">
            {cvvCaption}
          </span>
        </div>
        <div className="flex h-8 items-center rounded bg-neutral-200 overflow-hidden shadow-inner">
          <div className="h-full flex-1 bg-gradient-to-r from-neutral-200 via-neutral-100 to-neutral-200 px-3 opacity-90">
            <span className="font-serif text-[10px] text-neutral-500 italic select-none">{signatureLabel}</span>
          </div>
          <div
            data-testid="card-preview-cvv"
            className="flex h-full w-14 items-center justify-center border-l border-neutral-300 bg-white font-mono text-xs font-bold text-neutral-900 tabular-nums tracking-wider"
          >
            {cvv}
          </div>
        </div>
      </div>
      <div className="flex items-center justify-between px-5 text-[9px] text-white/70 sm:px-6">
        <p className="max-w-[70%] text-[8px] leading-tight sm:text-[9px]">{disclaimer}</p>
        <div className="origin-right scale-75">
          <BrandMark brand={brand} compact />
        </div>
      </div>
    </div>
  )
}

export function CreditCardPreview(props: CreditCardPreviewProps) {
  const { t } = useTranslation()
  const holderPlaceholder = t('cards.preview.holderPlaceholder')
  const expiryPlaceholder = t('cards.preview.expiryPlaceholder')
  const theme = props.theme

  if (props.variant === 'chip') {
    return (
      <div
        data-testid="card-preview-root"
        aria-hidden="true"
        className="pointer-events-none relative aspect-[1.586/1] w-12 overflow-hidden rounded-md border shadow-xs bg-gradient-to-br"
      >
        <div className={cn('absolute inset-0 bg-gradient-to-br', THEME_ART[theme])} />
        <span className="absolute right-0.5 bottom-0.5 origin-bottom-right scale-[0.4]">
          <BrandMark brand={props.brand} compact />
        </span>
      </div>
    )
  }

  if (props.variant === 'wallet') {
    const holder = props.holderName?.trim() ? props.holderName.toUpperCase() : null
    const expiry = props.expiry?.trim() ? props.expiry : null
    const hasLast4 = props.last4 != null && props.last4 !== ''
    const identityLabel = hasLast4
      ? t('cards.cardAria.last4', { last4: props.last4 })
      : t('cards.cardAria.last4Unknown')
    return (
      <>
        <div
          data-testid="card-preview-root"
          aria-hidden="true"
          className="relative aspect-[1.586/1] w-full max-w-[280px] select-none"
        >
          <FrontFace
            theme={theme}
            brand={props.brand}
            holder={holder}
            expiry={expiry}
            holderPlaceholder={holderPlaceholder}
            expiryPlaceholder={expiryPlaceholder}
            identity={<CardIdentity last4={hasLast4 ? props.last4 : null} tone="art" />}
          />
        </div>
        <span
          data-testid="card-preview-identity-aria"
          role="img"
          aria-label={identityLabel}
          className="sr-only"
        />
      </>
    )
  }

  const holder = props.holderName.trim() ? props.holderName.toUpperCase() : holderPlaceholder
  const expiry = props.expiry.trim() ? props.expiry : expiryPlaceholder
  const cvv = props.cvv.trim() ? props.cvv : t('cards.preview.cvvPlaceholder')
  return (
    <div
      data-testid="card-preview-root"
      aria-hidden="true"
      className="relative mx-auto aspect-[1.586/1] w-full max-w-[340px] select-none perspective-[1000px] sm:max-w-[380px]"
    >
      <div
        data-testid="card-preview-rotator"
        className={cn(
          'relative h-full w-full rounded-2xl transform-style-preserve-3d transition-transform duration-500 motion-reduce:transition-none',
          props.isFlipped ? 'rotate-y-180' : 'rotate-y-0',
        )}
      >
        <FrontFace
          theme={theme}
          brand={props.brand}
          number={displayNumber(props.number)}
          holder={holder}
          expiry={expiry}
          holderPlaceholder={holderPlaceholder}
          expiryPlaceholder={expiryPlaceholder}
        />
        <BackFace
          theme={theme}
          brand={props.brand}
          cvv={cvv}
          cvvCaption={t('cards.preview.cvvLabel')}
          signatureLabel={t('cards.preview.signatureLabel')}
          disclaimer={t('cards.preview.disclaimer')}
        />
      </div>
    </div>
  )
}
