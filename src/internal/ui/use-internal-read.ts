/**
 * Leitura de RPC do painel com estados explícitos (REQ-36).
 *
 * Único caminho de leitura das telas: `readInternalRpc` (allowlist fechada).
 * `args` é serializado para chave — evita laço por identidade de objeto — e o
 * efeito descarta resposta de montagem anterior.
 */

import { useCallback, useEffect, useState } from "react"

import { readInternalRpc, type InternalReadRpc } from "@/internal/data/internal-client"

export interface InternalReadResult<T> {
  loading: boolean
  data: T | null
  failed: boolean
  reload: () => void
}

interface ReadState<T> {
  loading: boolean
  data: T | null
  failed: boolean
}

export function useInternalRead<T>(
  name: InternalReadRpc,
  args: Record<string, unknown> = {},
  options: { enabled?: boolean } = {},
): InternalReadResult<T> {
  const enabled = options.enabled ?? true
  const argsKey = JSON.stringify(args)
  const [nonce, setNonce] = useState(0)
  const [state, setState] = useState<ReadState<T>>({
    loading: enabled,
    data: null,
    failed: false,
  })

  useEffect(() => {
    if (!enabled) {
      setState({ loading: false, data: null, failed: false })
      return
    }

    let active = true
    setState({ loading: true, data: null, failed: false })

    readInternalRpc<T>(name, JSON.parse(argsKey) as Record<string, unknown>)
      .then((data) => {
        if (active) setState({ loading: false, data, failed: false })
      })
      .catch(() => {
        if (active) setState({ loading: false, data: null, failed: true })
      })

    return () => {
      active = false
    }
  }, [name, argsKey, nonce, enabled])

  const reload = useCallback(() => {
    setNonce((current) => current + 1)
  }, [])

  return { loading: state.loading, data: state.data, failed: state.failed, reload }
}
