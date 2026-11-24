import { useTranslation } from "react-i18next"
import { PageHeader } from "@/components/ui/PageHeader"

/**
 * Página stub das rotas congeladas da Fase 1 (/lancamentos, /cartoes, /config).
 * Renderiza o título da rota (i18n) e estado "Em breve".
 */
export function PlaceholderPage({ titleKey }: { titleKey: string }) {
  const { t } = useTranslation()
  return (
    <>
      <PageHeader title={t(titleKey)} subtitle={t("placeholder.subtitle")} />
      <div className="flex h-64 w-full flex-col items-center justify-center gap-2 px-4 lg:px-6">
        <p className="text-sm font-medium text-foreground/80">{t("placeholder.comingSoon")}</p>
      </div>
    </>
  )
}

export default PlaceholderPage
