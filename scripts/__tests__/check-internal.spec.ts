import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { main, runChecks, selfTest } from "../../scripts/check-internal.mjs"

const fixtures: string[] = []

const BASELINE = {
  "src/router.tsx": [
    'import { lazy } from "react"',
    "const InternalTree = lazy(() =>",
    '  import("@/internal/internal-tree").then((m) => ({ default: m.InternalTree })),',
    ")",
    "export { InternalTree }",
    "",
  ].join("\n"),
  "src/main.tsx": "import './router'\n",
}

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "check-internal-spec-"))
  fixtures.push(root)
  for (const [path, content] of Object.entries({ ...BASELINE, ...files })) {
    const absolute = join(root, path)
    mkdirSync(join(absolute, ".."), { recursive: true })
    writeFileSync(absolute, content)
  }
  return root
}

function gatesOf(report: { violations: Array<{ gate: string }> }): string[] {
  return report.violations.map((violation) => violation.gate)
}

afterEach(() => {
  while (fixtures.length > 0) {
    const root = fixtures.pop()
    if (root) rmSync(root, { recursive: true, force: true })
  }
})

describe("whenInternalTreeUsesPostgrest_thenG01Rejects", () => {
  it("fixture negativa com .from('tenants') sai com exit 1 em G-01", () => {
    const root = fixture({
      "src/internal/pages/evil.ts": "export const tenants = supabase.from('tenants').select('*')\n",
    })

    const report = runChecks({ root })

    expect(report.exitCode).toBe(1)
    expect(gatesOf(report)).toContain("G-01")
    expect(main(["--root", root])).toBe(1)
  })
})

describe("whenRpcOrSupabaseLeavesTheDataLayer_thenG02Rejects", () => {
  it(".rpc( fora de src/internal/data sai com exit 1 em G-02", () => {
    const root = fixture({
      "src/internal/pages/evil.ts": 'export const rows = supabase.rpc("admin_count_tenants")\n',
    })

    expect(gatesOf(runChecks({ root }))).toContain("G-02")
  })

  it("@/lib/supabase fora de src/internal/data sai com exit 1 em G-02", () => {
    const root = fixture({
      "src/internal/pages/evil.ts": 'import { supabase } from "@/lib/supabase"\n',
    })

    expect(gatesOf(runChecks({ root }))).toContain("G-02")
  })
})

describe("whenTheTreeIsNotLazy_thenG03Rejects", () => {
  it("main.tsx importando src/internal sai com exit 1 em G-03", () => {
    const root = fixture({ "src/main.tsx": 'import "@/internal/internal-tree"\n' })

    expect(gatesOf(runChecks({ root }))).toContain("G-03")
  })

  it("router sem lazy() para internal-tree sai com exit 1 em G-03", () => {
    const root = fixture({
      "src/router.tsx": 'import { InternalTree } from "@/internal/internal-tree"\nexport { InternalTree }\n',
    })

    expect(gatesOf(runChecks({ root }))).toContain("G-03")
  })
})

describe("whenTheGuardPersistsTheVerdict_thenG04Rejects", () => {
  it("localStorage em src/internal/guard sai com exit 1 em G-04", () => {
    const root = fixture({
      "src/internal/guard/evil.ts": 'export const verdict = localStorage.getItem("verdict")\n',
    })

    expect(gatesOf(runChecks({ root }))).toContain("G-04")
  })
})

describe("whenTheOperatorKnowsATenant_thenG05Rejects", () => {
  it("switch_tenant em src/internal sai com exit 1 em G-05", () => {
    const root = fixture({
      "src/internal/pages/evil.ts": 'export const fn = "switch_tenant"\n',
    })

    expect(gatesOf(runChecks({ root }))).toContain("G-05")
  })
})

describe("whenTheMockReturnsToSrc_thenG06Rejects", () => {
  it("mockViews.admin em src/ sai com exit 1 em G-06", () => {
    const root = fixture({ "src/pages/evil.ts": 'export const view = "mockViews.admin"\n' })

    expect(gatesOf(runChecks({ root }))).toContain("G-06")
  })
})

describe("whenTelemetryUsesAnInventedNumber_thenG07Rejects", () => {
  it("app/dashboard/data.json em src/internal sai com exit 1 em G-07", () => {
    const root = fixture({
      "src/internal/pages/evil.ts": 'export const src = "app/dashboard/data.json"\n',
    })

    expect(gatesOf(runChecks({ root }))).toContain("G-07")
  })
})

describe("whenOnboardingIsDuplicated_thenG08Rejects", () => {
  it("pendingPasswordSetup fora da allowlist sai com exit 1 em G-08", () => {
    const root = fixture({
      "src/internal/pages/evil.ts": "export const flag = pendingPasswordSetup\n",
    })

    expect(gatesOf(runChecks({ root }))).toContain("G-08")
  })

  it("pendingPasswordSetup dentro da allowlist não viola G-08", () => {
    const root = fixture({
      "src/lib/pending-password-setup.ts": "export const flag = pendingPasswordSetup\n",
    })

    expect(gatesOf(runChecks({ root }))).not.toContain("G-08")
  })
})

describe("whenServiceRoleLeaksToTheClient_thenG09Rejects", () => {
  it("service_role em src/ sai com exit 1 em G-09", () => {
    const root = fixture({ "src/lib/evil.ts": 'export const key = "service_role"\n' })

    expect(gatesOf(runChecks({ root }))).toContain("G-09")
  })
})

describe("whenTheArtifactKeepsTheMock_thenG10Rejects", () => {
  it("dist/assets com mockViews.admin sai com exit 1 em G-10", () => {
    const root = fixture({
      "dist/assets/internal-tree-evil.js": 'export const view = "mockViews.admin"\n',
    })

    const report = runChecks({ root, requireDist: true })
    expect(report.exitCode).toBe(1)
    expect(gatesOf(report)).toContain("G-10")
  })

  it("--dist sem chunk interno sai com exit 1 em G-10", () => {
    const root = fixture({ "dist/assets/app.js": "export const x = 1\n" })

    expect(gatesOf(runChecks({ root, requireDist: true }))).toContain("G-10")
  })
})

describe("whenOnlyAllowedInternalFilesExist_thenGatePasses", () => {
  it("cliente de dados com @/lib/supabase e .rpc é permitido", () => {
    const root = fixture({
      "src/internal/data/internal-client.ts":
        'import { supabase } from "@/lib/supabase"\nexport const run = () => supabase.rpc("admin_count_tenants")\n',
      "src/internal/pages/home.ts": "export const title = 'Visão geral'\n",
      "src/lib/pending-password-setup.ts": "export const flag = pendingPasswordSetup\n",
    })

    expect(runChecks({ root }).exitCode).toBe(0)
    expect(main(["--root", root])).toBe(0)
  })
})

describe("whenSelfTestRuns_thenEveryGateRejectsItsFixture", () => {
  it("--self-test prova 10 fixtures negativas (uma por gate)", () => {
    expect(selfTest()).toBe(0)
  })
})
