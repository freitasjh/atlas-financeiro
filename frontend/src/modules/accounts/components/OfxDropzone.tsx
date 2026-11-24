// P1.2 — dropzone reutilizável (hero na página, compacto no picker).
// Input real accept .ofx/.qfx + clique + drag + teclado; guarda/parse no dono.
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FileCode2, Upload } from 'lucide-react'
import { cn } from '@/lib/cn'

interface OfxDropzoneProps {
  fileName: string | null
  isReading: boolean
  parsedSummary?: string | null
  onFiles: (files: FileList | null) => void
  size?: 'hero' | 'compact'
}

export function OfxDropzone({ fileName, isReading, parsedSummary, onFiles, size = 'hero' }: OfxDropzoneProps) {
  const { t } = useTranslation()
  const [isDragging, setIsDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept=".ofx,.qfx"
        aria-label={t('accounts.ofx.chooseFile')}
        className="sr-only"
        onChange={(e) => {
          onFiles(e.target.files)
        }}
      />
      <div
        role="button"
        tabIndex={0}
        aria-label={t('accounts.ofx.chooseFile')}
        aria-busy={isReading}
        onDragOver={(e) => {
          e.preventDefault()
          setIsDragging(true)
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setIsDragging(false)
          onFiles(e.dataTransfer.files)
        }}
        onClick={() => fileInputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            fileInputRef.current?.click()
          }
        }}
        className={cn(
          'flex w-full min-w-0 flex-col items-center justify-center rounded-2xl border-2 border-dashed text-center transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
          size === 'hero' ? 'min-h-44 cursor-pointer p-8' : 'cursor-pointer p-6',
          isDragging
            ? 'border-primary bg-primary/10'
            : fileName
              ? 'border-emerald-500/50 bg-emerald-500/10'
              : 'border-border/80 bg-muted/20 hover:bg-muted/30',
        )}
      >
        {fileName ? (
          <div className="w-full min-w-0 space-y-1" aria-live="polite">
            <FileCode2 className="mx-auto h-10 w-10 text-emerald-600 dark:text-emerald-400" />
            <p className="truncate text-xs font-bold tabular-nums text-foreground">{fileName}</p>
            <span className="block text-[10px] text-muted-foreground">{t('accounts.ofx.fileValid')}</span>
            {parsedSummary ? (
              <span className="block text-[11px] tabular-nums text-muted-foreground">{parsedSummary}</span>
            ) : null}
          </div>
        ) : (
          <div className="space-y-1.5">
            <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Upload className="h-5 w-5" />
            </div>
            <p className="text-xs font-bold text-foreground">{t('accounts.ofx.dropHint')}</p>
            <p className="text-[11px] text-muted-foreground">{t('accounts.ofx.banksHint')}</p>
            <p className="text-[11px] text-muted-foreground">{t('accounts.ofx.limitsHint')}</p>
            {isReading ? (
              <p className="text-[11px] tabular-nums text-muted-foreground" aria-live="polite">
                {t('accounts.ofx.processing')}
              </p>
            ) : null}
          </div>
        )}
      </div>
    </>
  )
}
