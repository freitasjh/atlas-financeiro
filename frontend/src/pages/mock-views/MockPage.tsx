import type { ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { PageHeader } from "@/components/ui/PageHeader"

/** Cabeçalho i18n comum às páginas de views de template (mock) navegáveis por rota. */
export function MockPage({
  titleKey,
  children,
}: {
  titleKey: string
  children: ReactNode
}) {
  const { t } = useTranslation()
  return (
    <>
      <PageHeader title={t(`${titleKey}.title`)} subtitle={t(`${titleKey}.subtitle`)} />
      {children}
    </>
  )
}
