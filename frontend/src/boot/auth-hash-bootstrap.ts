// Boot de auth: roda ANTES de `createHashRouter` (main.tsx importa este módulo
// primeiro e só então importa o router dinamicamente). Lê o payload do
// fragmento uma única vez, reescreve a URL imediatamente (tokens fora da barra
// de endereço) e só então troca o fragmento por uma sessão em memória/cookie.

import { authHashDestination, readAuthHashIntent } from "@/lib/auth-hash-intent"
import { writePendingPasswordSetup } from "@/lib/pending-password-setup"
import { supabase } from "@/lib/supabase"

function replaceHashRoute(route: string): void {
  if (typeof window === "undefined") return
  window.history.replaceState(null, "", `#${route}`)
}

/**
 * Consome `window.location.hash` (ou o hash recebido) e devolve o controle ao
 * router. Idempotente para hash sem payload: retorna sem tocar na URL.
 */
export async function bootstrapAuthFromHash(hash: string): Promise<void> {
  const intent = readAuthHashIntent(hash)
  if (intent.kind === "none") return

  const destination = authHashDestination(intent)
  if (destination) replaceHashRoute(destination)

  if (intent.kind === "error") return

  const { data, error } = await supabase.auth.setSession({
    access_token: intent.accessToken,
    refresh_token: intent.refreshToken,
  })

  if (error || !data.session) {
    replaceHashRoute("/link-expirado?motivo=invalido")
    return
  }

  if (intent.flow === "invite" || intent.flow === "recovery") {
    writePendingPasswordSetup(data.session.user.id, {
      origem: intent.flow === "recovery" ? "recuperacao" : "convite",
    })
  }
}
