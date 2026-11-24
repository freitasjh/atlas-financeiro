import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/shadcn/ui/skeleton'

export type BlockState = 'loading' | 'empty' | 'error' | 'success'

interface StateBlockProps {
  state: BlockState
  onRetry?: () => void
  /** B4F-07 — mensagem específica do consumidor (default: `common.error`). */
  messageKey?: string
  children?: ReactNode
}

export function StateBlock({ state, onRetry, messageKey, children }: StateBlockProps) {
  const { t } = useTranslation()

  if (state === 'loading') {
    return (
      <div role="status" className="flex flex-col gap-2 py-8">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <span className="sr-only">{t('common.loading')}</span>
      </div>
    )
  }

  if (state === 'error') {
    return (
      <div role="alert" className="flex flex-col items-center gap-3 py-8 text-center">
        <p className="text-sm text-slate-600">{t(messageKey ?? 'common.error')}</p>
        {onRetry ? (
          <Button variant="secondary" onClick={onRetry}>
            {t('common.retry')}
          </Button>
        ) : null}
      </div>
    )
  }

  if (state === 'empty') {
    return (
      <div className="flex flex-col items-center gap-3 py-8 text-center">
        <p className="text-sm text-slate-600">{t('common.empty')}</p>
        {children}
      </div>
    )
  }

  return <>{children}</>
}
