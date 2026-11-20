import * as React from "react"
import { Button } from "@/components/shadcn/ui/button"
import { cn } from "@/lib/cn"

interface RouteErrorBoundaryProps {
  children: React.ReactNode
  className?: string
}

interface RouteErrorBoundaryState {
  error: Error | null
}

/**
 * Boundary de rota (class component — única forma de capturar erros de
 * renderização e de import de chunk lazy no React 19). Falha de chunk
 * (ex.: deploy em curso) mostra UI de erro visível com "Recarregar"
 * (location.reload() re-busca o bundle), nunca página branca.
 */
export class RouteErrorBoundary extends React.Component<
  RouteErrorBoundaryProps,
  RouteErrorBoundaryState
> {
  state: RouteErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: unknown): RouteErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  componentDidCatch(error: unknown): void {
    // Erro é exibido na UI; log para diagnóstico sem vazamento de dados.
    console.error("[RouteErrorBoundary]", error instanceof Error ? error.message : error)
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div
          role="alert"
          className={cn(
            "flex min-h-svh w-full flex-col items-center justify-center gap-4 p-6 text-center",
            this.props.className,
          )}
        >
          <h2 className="text-lg font-semibold text-foreground">
            Não foi possível carregar esta página
          </h2>
          <p className="max-w-md text-sm text-muted-foreground">
            Pode ter havido falha de conexão ou uma atualização do sistema.
            Recarregue para continuar.
          </p>
          <Button type="button" onClick={() => window.location.reload()}>
            Recarregar
          </Button>
        </div>
      )
    }
    return this.props.children
  }
}
