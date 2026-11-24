import { useEffect } from "react"
import { useTranslation } from "react-i18next"

/** Sincroniza o título da aba com o título resolvido da rota. */
export function useDocumentTitle(title: string | undefined): void {
  const { t } = useTranslation()
  const appName = t("shell.appName")

  useEffect(() => {
    document.title = title ? `${title} • ${appName}` : appName
    return () => {
      document.title = appName
    }
  }, [title, appName])
}
