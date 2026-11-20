/**
 * Árvore do control plane — chunk lazy único (REQ-01).
 *
 * Nada de `src/internal/**` entra no grafo estático de `main.tsx`: o router
 * importa este módulo dinamicamente (E9). Aqui mora a configuração única do
 * runtime do guard, o shell e as 8 superfícies.
 */

import { Route, Routes } from "react-router-dom"

import { applyStoredColorMode } from "@/lib/color-mode"
import { NotFoundPage } from "@/pages/NotFoundPage"
import { createInternalOperatorRuntime } from "@/internal/data/operator-runtime"
import { configureOperatorRuntime } from "@/internal/guard/use-internal-operator"
import { useOperatorRevalidation } from "@/internal/guard/use-operator-revalidation"
import { RequireInternalOperator } from "@/internal/guard/RequireInternalOperator"
import { InternalShell } from "@/internal/shell/internal-shell"
import { InternalAuditPage } from "@/internal/pages/internal-audit-page"
import { InternalDeniedPage } from "@/internal/pages/internal-denied-page"
import { InternalHomePage } from "@/internal/pages/internal-home-page"
import { InternalLoginPage } from "@/internal/pages/internal-login-page"
import { InternalMfaPage } from "@/internal/pages/internal-mfa-page"
import { InternalTelemetryPage } from "@/internal/pages/internal-telemetry-page"
import { InternalTenantDetailPage } from "@/internal/pages/internal-tenant-detail-page"
import { InternalTenantsPage } from "@/internal/pages/internal-tenants-page"

let runtimeConfigured = false

/**
 * O runtime tem de existir **antes** do primeiro `verify()` do guard. Efeitos
 * do filho rodam antes dos do pai, então configurar num `useEffect` daqui
 * chegava tarde: o guard via `runtime === null` e caía em `error` sem rede
 * (H3 P1). A configuração é idempotente e acontece no carregamento do chunk.
 */
function ensureInternalRuntime(): void {
  if (runtimeConfigured) return
  configureOperatorRuntime(createInternalOperatorRuntime())
  runtimeConfigured = true
}

ensureInternalRuntime()

// O chunk interno não monta `SiteHeader`/`ModeToggle`: a preferência salva
// (`harness-color-mode`, mesmo critério do resto do app) precisa ser aplicada
// no carregamento, senão o modo escuro não sobrevive a F5 aqui (re-H3 F4 P3).
applyStoredColorMode()

export function InternalTree() {
  ensureInternalRuntime()
  useOperatorRevalidation()

  return (
    <Routes>
      <Route path="login" element={<InternalLoginPage />} />

      <Route
        path="mfa"
        element={
          <RequireInternalOperator allowMfaRequired>
            <InternalMfaPage />
          </RequireInternalOperator>
        }
      />

      <Route path="acesso-negado" element={<InternalDeniedPage />} />

      <Route
        element={
          <RequireInternalOperator>
            <InternalShell />
          </RequireInternalOperator>
        }
      >
        <Route index element={<InternalHomePage />} />
        <Route path="tenants" element={<InternalTenantsPage />} />
        <Route path="tenants/:tenantId" element={<InternalTenantDetailPage />} />
        <Route path="auditoria" element={<InternalAuditPage />} />
        <Route path="telemetria" element={<InternalTelemetryPage />} />
        {/* Segmento desconhecido dentro do control plane nunca fica em branco:
            cai no 404. Sem guard (não-operator), o `RequireInternalOperator`
            acima decide o redirect. */}
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  )
}

export default InternalTree
