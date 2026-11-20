import { Skeleton } from "@/components/shadcn/ui/skeleton"
import { useTranslation } from "react-i18next"

/**
 * Placeholder visível de carregamento de rota/guard (padrão Atlas).
 * role="status" + conteúdo textual visível: nunca página branca enquanto
 * a sessão inicializa ou o chunk da rota carrega.
 */
export function RouteSkeleton({ label }: { label?: string }) {
  const { t } = useTranslation()
  const resolvedLabel = label ? `${label}…` : t("common.loading")
  return (
    <div
      role="status"
      aria-busy="true"
      className="flex min-h-svh w-full flex-col gap-3 p-6"
    >
      <span className="text-sm text-muted-foreground">{resolvedLabel}</span>
      <Skeleton className="h-7 w-40" />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-full max-w-md" />
        <Skeleton className="h-4 w-full max-w-sm" />
        <Skeleton className="h-4 w-2/3" />
      </div>
      <div className="mt-2 grid gap-3 md:grid-cols-2 lg:grid-cols-4">
        <Skeleton className="h-24 rounded-lg" />
        <Skeleton className="h-24 rounded-lg" />
        <Skeleton className="h-24 rounded-lg" />
        <Skeleton className="h-24 rounded-lg" />
      </div>
    </div>
  )
}
