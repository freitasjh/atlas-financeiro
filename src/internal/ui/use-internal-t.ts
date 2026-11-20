/**
 * `t()` do painel interno.
 *
 * `i18n` do app nasce com `escapeValue: true` (necessário para superfícies que
 * montam HTML). As telas internas só produzem **texto React**, que já é
 * escapado pelo próprio React — com a opção global, uma data interpolada
 * (`01/11/2026`) apareceria como entidade (`01&#x2F;11&#x2F;2026`). Este wrapper
 * desliga o escape apenas aqui, sem mexer na configuração global.
 */

import { useCallback } from "react"
import { useTranslation } from "react-i18next"
import type { TFunction } from "i18next"

export function useInternalT(): TFunction {
  const { t } = useTranslation()
  return useCallback(
    ((key: string, options?: Record<string, unknown>) =>
      t(key, { ...options, interpolation: { escapeValue: false } })) as TFunction,
    [t],
  )
}
