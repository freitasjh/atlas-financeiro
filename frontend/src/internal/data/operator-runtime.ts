/**
 * Runtime do guard dentro da árvore interna (E8).
 *
 * Liga o store puro (`use-internal-operator`) ao fio real: a chave de sessão sai
 * de `readInternalSession` e o veredito sai da Edge `verify-operator`. Nenhum
 * veredito é persistido — `configureOperatorRuntime` só injeta funções.
 */

import { resolveSupabaseConfig } from "@/lib/supabase-env"
import {
  getInternalAccessToken,
  readInternalSession,
  subscribeInternalAuthState,
} from "@/internal/data/internal-client"
import { createVerifyOperatorService } from "@/internal/data/verify-operator.service"
import type { OperatorRuntime } from "@/internal/guard/use-internal-operator"

export function createInternalOperatorRuntime(): OperatorRuntime {
  const config = resolveSupabaseConfig({
    url: import.meta.env.VITE_SUPABASE_URL as string | undefined,
    anonKey: import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined,
    prod: import.meta.env.PROD,
  })
  const service = createVerifyOperatorService({
    baseUrl: config.url,
    anonKey: config.anonKey,
    getAccessToken: getInternalAccessToken,
  })

  return {
    sessionKey: readInternalSession,
    verify: service.verify,
    subscribeAuth: (onChange) =>
      typeof subscribeInternalAuthState === "function"
        ? subscribeInternalAuthState(onChange)
        : () => {},
  }
}
