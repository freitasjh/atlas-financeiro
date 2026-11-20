import { useTranslation } from "react-i18next"
import { PageHeader } from "@/components/ui/PageHeader"
import { SectionCards, ChartAreaInteractive, DataTable } from "@/components/shadcn/dashboard"
import data from "@/app/dashboard/data.json"

/**
 * Rota "/" — visão geral do painel (conteúdo do antigo App.tsx, extraído
 * para rota própria; layout vem do AtlasAdminLayout pathless).
 */
export function OverviewPage() {
  const { t } = useTranslation()
  return (
    <>
      <PageHeader title={t("dashboard.title")} subtitle={t("dashboard.subtitle")} />
      <SectionCards />
      <div className="px-4 lg:px-6">
        <ChartAreaInteractive />
      </div>
      <DataTable data={data} />
    </>
  )
}

export default OverviewPage
