import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/shadcn/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/shadcn/ui/dialog'
import { Input } from '@/components/shadcn/ui/input'
import { Label } from '@/components/shadcn/ui/label'
import { Alert, AlertDescription } from '@/components/shadcn/ui/alert'
import { cn } from '@/lib/cn'
import type { CategoryType } from '../model/category'
import type { CategoryFormValues } from '../model/category-diff'

// C2.3 — CategoryDialog: Nome* + Tipo segmentado + Cor (swatch fechado).
// Validação inline + foco no 1º inválido; sm:max-w-[480px].

export const CATEGORY_SWATCH = [
  '#10b981',
  '#0ea5e9',
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
  '#f43f5e',
  '#f97316',
  '#f59e0b',
  '#14b8a6',
  '#64748b',
] as const

export interface CategoryDialogInitial {
  name: string
  type: CategoryType
  color: string | null
}

interface CategoryDialogProps {
  open: boolean
  mode: 'create' | 'edit'
  initial?: CategoryDialogInitial
  isSaving: boolean
  serverError: string | null
  onOpenChange: (open: boolean) => void
  onSubmit: (values: CategoryFormValues) => Promise<void>
}

export function CategoryDialog({
  open,
  mode,
  initial,
  isSaving,
  serverError,
  onOpenChange,
  onSubmit,
}: CategoryDialogProps) {
  const { t } = useTranslation()
  const [name, setName] = useState(initial?.name ?? '')
  const [type, setType] = useState<CategoryType>(initial?.type ?? 'expense')
  const [color, setColor] = useState<string | null>(initial?.color ?? null)
  const [nameError, setNameError] = useState<string | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  // Re-sincroniza ao abrir (mesmo dialog serve criar + editar).
  useEffect(() => {
    if (open) {
      setName(initial?.name ?? '')
      setType(initial?.type ?? 'expense')
      setColor(initial?.color ?? null)
      setNameError(null)
      // Foco gerenciado: abrir → 1º campo.
      requestAnimationFrame(() => nameRef.current?.focus())
    }
  }, [open, initial?.name, initial?.type, initial?.color])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (trimmed.length === 0 || trimmed.length > 120) {
      setNameError(t('categories.nameError'))
      nameRef.current?.focus()
      return
    }
    setNameError(null)
    await onSubmit({ name: trimmed, type, color })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] w-full overflow-y-auto overscroll-contain sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{mode === 'create' ? t('categories.create') : t('categories.edit')}</DialogTitle>
          <DialogDescription>
            {mode === 'create' ? t('categories.createHint') : t('categories.editHint')}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="category-name" className="text-xs font-medium">
              {t('categories.name')} *
            </Label>
            <Input
              ref={nameRef}
              id="category-name"
              name="name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('categories.namePlaceholder')}
              aria-invalid={nameError ? true : undefined}
              aria-describedby={nameError ? 'category-name-error' : undefined}
              className="h-10 w-full"
              required
            />
            {nameError ? (
              <p id="category-name-error" role="alert" className="text-xs text-destructive">
                {nameError}
              </p>
            ) : null}
          </div>

          <fieldset className="flex flex-col gap-1.5">
            <legend className="text-xs font-medium">{t('categories.typeLabel')} *</legend>
            <div role="radiogroup" aria-label={t('categories.type')} className="grid grid-cols-2 gap-2">
              {(['expense', 'income'] as const).map((option) => {
                const selected = type === option
                return (
                  <button
                    key={option}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setType(option)}
                    className={cn(
                      'flex min-h-11 items-center justify-center rounded-lg border px-3 text-sm font-semibold transition-colors',
                      'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                      selected
                        ? option === 'income'
                          ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                          : 'border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-400'
                        : 'border-border/70 bg-card text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {option === 'expense' ? t('categories.typeExpense') : t('categories.typeIncome')}
                  </button>
                )
              })}
            </div>
          </fieldset>

          <fieldset className="flex flex-col gap-1.5">
            <legend className="text-xs font-medium">{t('categories.colorLabel')}</legend>
            <div role="radiogroup" aria-label={t('categories.colorLabel')} className="flex flex-wrap gap-2">
              <button
                type="button"
                role="radio"
                aria-checked={color === null}
                aria-label={t('categories.colorNone')}
                title={t('categories.colorNone')}
                onClick={() => setColor(null)}
                className={cn(
                  'flex size-11 items-center justify-center rounded-full border text-xs font-bold transition-all',
                  'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                  color === null
                    ? 'border-primary ring-2 ring-ring/50'
                    : 'border-border/70 text-muted-foreground',
                )}
              >
                ∅
              </button>
              {CATEGORY_SWATCH.map((hex) => {
                const selected = color === hex
                return (
                  <button
                    key={hex}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    aria-label={hex}
                    title={hex}
                    onClick={() => setColor(hex)}
                    style={{ backgroundColor: hex }}
                    className={cn(
                      'size-11 rounded-full transition-all',
                      'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none',
                      selected && 'ring-2 ring-ring ring-offset-2',
                    )}
                  />
                )
              })}
            </div>
            <p className="text-[11px] text-muted-foreground">{t('categories.colorHint')}</p>
          </fieldset>

          {serverError ? (
            <Alert variant="destructive">
              <AlertDescription role="alert">{serverError}</AlertDescription>
            </Alert>
          ) : null}

          <DialogFooter className="mt-1 flex flex-row items-center justify-end gap-3 sm:space-x-0">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} className="min-h-11">
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={isSaving} aria-busy={isSaving} className="min-h-11 font-semibold">
              {isSaving ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
              {mode === 'create' ? t('categories.create') : t('categories.update')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
