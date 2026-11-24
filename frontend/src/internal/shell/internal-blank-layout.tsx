/**
 * Layout sem navegação para as superfícies terminais do control plane
 * (login, MFA e acesso negado). Não monta rail, chip nem `Sair`.
 */

import type { ReactNode } from "react"
import { ShieldCheck } from "lucide-react"
import { useInternalT } from "../ui/use-internal-t"

export function InternalBlankLayout({ children }: { children: ReactNode }) {
  const t = useInternalT()

  return (
    <div className="flex min-h-svh flex-col bg-background text-foreground">
      <header className="border-b border-border/70 bg-muted/30">
        <div className="flex h-14 items-center px-4 lg:px-6">
          <span className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            <ShieldCheck className="size-4" aria-hidden="true" />
            {t("internalAdmin.eyebrow")}
          </span>
        </div>
      </header>
      <main id="internal-main" className="flex flex-1 items-center justify-center px-4 py-10">
        <div className="w-full max-w-md">{children}</div>
      </main>
    </div>
  )
}
