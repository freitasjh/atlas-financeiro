import type { ReactNode } from "react"
import { cn } from "@/lib/cn"

interface PageHeaderProps {
  title: string
  subtitle?: string
  actions?: ReactNode
  className?: string
}

/**
 * Cabeçalho de página filho do AtlasAdminLayout: cada rota renderiza o próprio
 * título/subtítulo (i18n) dentro do <main> do layout, que não é mais dono do título.
 */
export function PageHeader({ title, subtitle, actions, className }: PageHeaderProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-1 border-b border-border/70 px-4 pb-3 lg:px-6",
        className,
      )}
    >
      <div className="flex items-end justify-between gap-4">
        <h1 className="text-xl font-bold tracking-tight text-foreground sm:text-2xl">
          {title}
        </h1>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      {subtitle ? <p className="text-xs text-muted-foreground">{subtitle}</p> : null}
    </div>
  )
}
