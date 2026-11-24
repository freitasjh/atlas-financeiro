// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Prova com o cliente **real** (sem rede): o método é chamado no objeto, então
 * o `this` interno do supabase-js continua ligado. Com o método destacado
 * (`const rpc = supabase.rpc`) este teste lançava `TypeError` antes do fetch.
 */
import { supabase } from "@/lib/supabase"
import { readInternalRpc, writeInternalRpc } from "./internal-client"
import {
  configureOperatorRuntime,
  useInternalOperator,
} from "@/internal/guard/use-internal-operator"

let spy: ReturnType<typeof vi.spyOn> | null = null

beforeEach(() => {
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

afterEach(() => {
  spy?.mockRestore()
  spy = null
})

describe("whenRealClientIsUsed_thenRpcRunsWithoutTypeError", () => {
  it("leitura no cliente real resolve o payload", async () => {
    spy = vi
      .spyOn(supabase, "rpc")
      .mockResolvedValue({ data: { mrr_cents: 1000 }, error: null } as never)

    await expect(readInternalRpc("admin_mrr_summary")).resolves.toEqual({ mrr_cents: 1000 })
    expect(spy).toHaveBeenCalledWith("admin_mrr_summary", {})
  })

  it("escrita no cliente real resolve o payload", async () => {
    spy = vi.spyOn(supabase, "rpc").mockResolvedValue({ data: true, error: null } as never)

    await expect(
      writeInternalRpc("admin_cancel_invite", { p_invite: "i-1" }),
    ).resolves.toBe(true)
    expect(spy).toHaveBeenCalledWith("admin_cancel_invite", { p_invite: "i-1" })
  })
})
