// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Regressão do H3 (P0): `readInternalRpc`/`writeInternalRpc` devem invocar
 * `.rpc` **no objeto** do cliente. Destacar o método (`const rpc = client.rpc`)
 * perde o `this` e lança `TypeError` antes de qualquer fetch.
 *
 * O cliente fake abaixo só funciona se o `this` estiver ligado ao objeto.
 */
const { restRpc } = vi.hoisted(() => ({ restRpc: vi.fn() }))

vi.mock("@/lib/supabase", () => ({
  supabase: {
    rest: { rpc: restRpc },
    rpc(
      this: { rest: { rpc: typeof restRpc } },
      name: string,
      args?: Record<string, unknown>,
    ) {
      return this.rest.rpc(name, args)
    },
  },
}))

import { readInternalRpc, writeInternalRpc } from "./internal-client"
import {
  configureOperatorRuntime,
  useInternalOperator,
} from "@/internal/guard/use-internal-operator"

describe("whenRpcIsInvoked_thenThisStaysBoundToTheClientObject", () => {
  beforeEach(() => {
    restRpc.mockReset()
    useInternalOperator.getState().reset()
    configureOperatorRuntime({
      sessionKey: async () => ({ userId: "u-1", aalKey: "aal2" }),
      verify: async () => ({
        status: 200,
        body: { is_operator: true, aal: "aal2", user_id: "u-1" },
        failure: null,
      }),
    })
  })

  it("leitura executa .rpc sem perder o this", async () => {
    restRpc.mockResolvedValue({ data: { mrr_cents: 1000 }, error: null })

    await expect(readInternalRpc("admin_mrr_summary")).resolves.toEqual({ mrr_cents: 1000 })
    expect(restRpc).toHaveBeenCalledWith("admin_mrr_summary", {})
  })

  it("escrita executa .rpc sem perder o this", async () => {
    restRpc.mockResolvedValue({ data: true, error: null })

    await expect(
      writeInternalRpc("admin_cancel_invite", { p_invite: "i-1" }),
    ).resolves.toBe(true)
    expect(restRpc).toHaveBeenCalledWith("admin_cancel_invite", { p_invite: "i-1" })
  })
})
