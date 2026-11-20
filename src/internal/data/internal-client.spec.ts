// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest"

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }))

vi.mock("@/lib/supabase", () => ({ supabase: { rpc } }))

import {
  INTERNAL_READ_RPCS,
  INTERNAL_WRITE_RPCS,
  InternalGateDeniedError,
  InternalRpcNotAllowedError,
  mapInternalGateError,
  readInternalRpc,
  writeInternalRpc,
} from "./internal-client"
import {
  configureOperatorRuntime,
  setOperatorClock,
  useInternalOperator,
  type OperatorWireResult,
} from "@/internal/guard/use-internal-operator"

const OPERATOR_WIRE: OperatorWireResult = {
  status: 200,
  body: { is_operator: true, aal: "aal2", user_id: "u-1" },
  failure: null,
}

const DENIED_WIRE: OperatorWireResult = {
  status: 403,
  body: { is_operator: false },
  failure: null,
}

function configureOperator(wire: OperatorWireResult, verifySpy = vi.fn(async () => wire)) {
  configureOperatorRuntime({
    sessionKey: async () => ({ userId: "u-1", aalKey: "aal2" }),
    verify: verifySpy,
  })
  return verifySpy
}

describe("whenRpcNameIsChecked_thenAllowlistIsClosed", () => {
  beforeEach(() => {
    rpc.mockReset()
  })

  it("listas fechadas de leitura e escrita", () => {
    expect(INTERNAL_READ_RPCS).toContain("admin_list_tenants")
    expect(INTERNAL_READ_RPCS).toContain("admin_mrr_summary")
    expect(INTERNAL_READ_RPCS).not.toContain("admin_grant_super_admin")
    expect(INTERNAL_WRITE_RPCS).toContain("admin_override_subscription")
    expect(INTERNAL_WRITE_RPCS).not.toContain("admin_grant_super_admin")
  })

  it("leitura allowlisted chama .rpc com os args", async () => {
    rpc.mockResolvedValue({ data: [{ id: "t-1" }], error: null })
    const data = await readInternalRpc("admin_list_tenants", { p_limit: 20 })
    expect(rpc).toHaveBeenCalledWith("admin_list_tenants", { p_limit: 20 })
    expect(data).toEqual([{ id: "t-1" }])
  })

  it("nome fora da allowlist ⇒ erro de tipo e de runtime, sem chamar .rpc", async () => {
    await expect(
      // @ts-expect-error nomes fora da allowlist de leitura não compilam
      readInternalRpc("admin_grant_super_admin"),
    ).rejects.toBeInstanceOf(InternalRpcNotAllowedError)

    await expect(
      writeInternalRpc("admin_grant_super_admin" as never),
    ).rejects.toBeInstanceOf(InternalRpcNotAllowedError)

    expect(rpc).not.toHaveBeenCalled()
  })
})

describe("whenWriteRuns_thenItRequiresOperatorVerdict", () => {
  beforeEach(() => {
    rpc.mockReset()
    useInternalOperator.getState().reset()
    setOperatorClock(() => 1_000)
    configureOperatorRuntime(null)
  })

  it("veredito ≠ operator ⇒ throw e .rpc nunca é chamado", async () => {
    configureOperator(DENIED_WIRE)
    await expect(
      writeInternalRpc("admin_cancel_invite", { p_target: "convite-1" }),
    ).rejects.toBeInstanceOf(InternalGateDeniedError)
    expect(rpc).not.toHaveBeenCalled()
    expect(useInternalOperator.getState().state).toBe("denied")
  })

  it("veredito operator ⇒ escrita chega ao banco", async () => {
    configureOperator(OPERATOR_WIRE)
    rpc.mockResolvedValue({ data: true, error: null })
    const result = await writeInternalRpc("admin_override_subscription", { p_tenant: "t-1" })
    expect(result).toBe(true)
    expect(rpc).toHaveBeenCalledWith("admin_override_subscription", { p_tenant: "t-1" })
  })

  it("escrita sempre revalida, mesmo com cache quente", async () => {
    const verifySpy = configureOperator(OPERATOR_WIRE)
    rpc.mockResolvedValue({ data: null, error: null })

    await writeInternalRpc("admin_repair_tenant_onboarding", { p_tenant: "t-1" })
    await writeInternalRpc("admin_repair_tenant_onboarding", { p_tenant: "t-1" })
    expect(verifySpy).toHaveBeenCalledTimes(2)
  })
})

describe("whenRpcReturnsGateError_thenLabelIsMapped", () => {
  beforeEach(() => {
    rpc.mockReset()
    useInternalOperator.getState().reset()
    configureOperatorRuntime(null)
  })

  it("rótulos do banco mapeiam para estados", () => {
    expect(mapInternalGateError({ message: "first-access-password-change-required" })).toBe("first-access")
    expect(mapInternalGateError({ message: "mfa-required" })).toBe("mfa-required")
    expect(mapInternalGateError({ message: "operator-inactive" })).toBe("denied")
    expect(mapInternalGateError({ code: "42501" })).toBe("denied")
    expect(mapInternalGateError({ message: "duplicate key" })).toBeNull()
    expect(mapInternalGateError(null)).toBeNull()
  })

  it("leitura com rótulo de gate ⇒ erro tipado e store invalidado", async () => {
    configureOperator(OPERATOR_WIRE)
    rpc.mockResolvedValue({ data: null, error: { message: "mfa-required" } })
    const failure = await readInternalRpc("admin_count_tenants").catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(InternalGateDeniedError)
    expect((failure as InternalGateDeniedError).state).toBe("mfa-required")
  })

  it("erro de negócio continua sendo o erro original", async () => {
    configureOperator(OPERATOR_WIRE)
    const original = new Error("tenant-sort-invalid")
    rpc.mockResolvedValue({ data: null, error: original })
    await expect(readInternalRpc("admin_list_tenants")).rejects.toBe(original)
  })
})
