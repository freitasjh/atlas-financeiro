import type { ReactNode } from "react"
import { GalleryVerticalEnd } from "lucide-react"
import { useTranslation } from "react-i18next"

import { cn } from "@/lib/cn"
import { revealInPageTarget } from "@/lib/in-page-anchor"
import { ModeToggle } from "@/components/shadcn/navigation/mode-toggle"

export interface AuthShellProps {
  children: ReactNode
  /** Largura máxima do card (formulários usam `max-w-sm`, telas de aviso `max-w-md`). */
  contentClassName?: string
  footer?: ReactNode
  /** Telas de aviso com 1 único tab stop: esconde skip link, marca e tema. */
  chrome?: boolean
}

/**
 * Shell único das telas públicas de auth (login, definir senha, link expirado,
 * solicitar convite). Extraído da LoginPage para cumprir `template-reuse.md`:
 * uma implementação, tokens semânticos, alvo de toque do tema preservado.
 */
export function AuthShell({ children, contentClassName, footer, chrome = true }: AuthShellProps) {
  const { t } = useTranslation()

  return (
    <div className="relative grid min-h-svh bg-background lg:grid-cols-2">
      {chrome ? (
        <button
          type="button"
          onClick={() => revealInPageTarget("main", { focus: true })}
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:min-h-11 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-xs focus:font-semibold focus:text-primary-foreground"
        >
          {t("a11y.skipToContent")}
        </button>
      ) : null}

      {chrome ? (
        <div className="absolute right-4 top-4 z-10">
          <ModeToggle />
        </div>
      ) : null}

      <div className="flex flex-col justify-between gap-4 p-6 md:p-10">
        <div className="flex justify-center gap-2 md:justify-start">
          {chrome ? (
            <a
              href="#/landing"
              className="flex max-sm:min-h-11 items-center gap-2 rounded-md font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring max-sm:-my-2.5 max-sm:py-2.5"
            >
              <span className="flex size-6 items-center justify-center rounded-md bg-primary text-primary-foreground">
                <GalleryVerticalEnd className="size-4" aria-hidden="true" />
              </span>
              Atlas
            </a>
          ) : (
            <span className="flex items-center gap-2 font-medium text-foreground">
              <span className="flex size-6 items-center justify-center rounded-md bg-primary text-primary-foreground">
                <GalleryVerticalEnd className="size-4" aria-hidden="true" />
              </span>
              Atlas
            </span>
          )}
        </div>

        <main id="main" tabIndex={-1} className="flex flex-1 items-center justify-center py-4 focus:outline-none">
          <div className={cn("w-full max-w-sm", contentClassName)}>
            <div className="relative overflow-hidden rounded-2xl border border-border/70 bg-card p-6 shadow-xs sm:p-8">
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-foreground/15 to-transparent"
              />
              {children}
            </div>
          </div>
        </main>

        {footer ? <div className="text-center text-xs text-muted-foreground">{footer}</div> : null}
      </div>

      <div className="relative hidden overflow-hidden bg-muted lg:block">
        <img
          src="/login-cover.jpg"
          alt={t("auth.coverAlt")}
          className="absolute inset-0 h-full w-full object-cover object-center"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-gradient-to-t from-background via-background/30 to-transparent"
        />
        <div className="absolute bottom-8 left-8 right-8 z-10 rounded-xl border border-border/70 bg-card/90 p-6 text-card-foreground shadow-xs backdrop-blur-md">
          <p className="text-xs font-semibold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
            {t("auth.coverEyebrow")}
          </p>
          <p className="mt-1 text-sm font-medium leading-relaxed">{t("auth.coverTagline")}</p>
        </div>
      </div>
    </div>
  )
}
