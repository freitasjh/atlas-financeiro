import type { ReactNode } from "react"

/** Cabeçalho de tela do painel: título + descrição + ações à direita. */
export function InternalPageHeader({
  title,
  description,
  actions,
}: {
  title: string
  description: string
  actions?: ReactNode
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="text-xl font-bold tracking-tight text-foreground sm:text-2xl">{title}</h1>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      {actions !== undefined ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  )
}
