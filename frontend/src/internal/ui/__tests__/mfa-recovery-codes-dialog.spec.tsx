// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"

import "@/i18n"
import i18n from "@/i18n"
import { MfaRecoveryCodesDialog } from "../mfa-recovery-codes-dialog"
import type { RecoveryStatus } from "@/internal/data/mfa-recovery-codes"

const ALPHABET = "abcdefghijklmnopqrstuvwxyz"
const CODES = Array.from(
  { length: 10 },
  (_, row) => Array.from({ length: 24 }, (_, column) => ALPHABET[(row + column) % 26]).join(""),
)

const FORMATTED_FIRST = "abcd-efgh-ijkl-mnop-qrst-uvwx"

function status(remaining: number): RecoveryStatus {
  return {
    total: 10,
    remaining,
    low: remaining <= 2,
    codes: Array.from({ length: 10 }, (_, index) => ({
      id: `code-${index + 1}`,
      used_at: index < 10 - remaining ? "2026-11-21T00:00:00Z" : null,
    })),
  }
}

const clipboardWrite = vi.fn(async (_text: string) => undefined)
const createObjectURL = vi.fn((_blob: Blob) => "blob:mfa-recovery")
const revokeObjectURL = vi.fn(() => undefined)
let anchorClick: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  clipboardWrite.mockClear()
  createObjectURL.mockClear()
  revokeObjectURL.mockClear()
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: { writeText: clipboardWrite },
  })
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL })
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL })
  anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined)
})

afterEach(async () => {
  cleanup()
  anchorClick.mockRestore()
  await i18n.changeLanguage("pt-BR")
})

describe("whenEnrollmentStepShowsTheOnlyCopy_thenCopyDownloadAndCheckboxAreEnforced", () => {
  it("exibe exatamente 10 códigos agrupados de 4 em 4", () => {
    render(<MfaRecoveryCodesDialog open mode="enroll" codes={CODES} />)

    expect(screen.getByText(FORMATTED_FIRST)).toBeTruthy()
    expect(screen.getAllByText(/^[a-z2-7]{4}(?:-[a-z2-7]{4}){5}$/)).toHaveLength(10)
  })

  it("copiar grava 10 linhas preformatadas, sem metadados do operador", async () => {
    render(<MfaRecoveryCodesDialog open mode="enroll" codes={CODES} />)

    fireEvent.click(screen.getByRole("button", { name: /copiar códigos/i }))
    await vi.waitFor(() => expect(clipboardWrite).toHaveBeenCalledTimes(1))

    const text = clipboardWrite.mock.calls[0][0]
    expect(text.split("\n").filter((line) => /^[a-z2-7]{4}(?:-[a-z2-7]{4}){5}$/.test(line))).toHaveLength(10)
    expect(text).not.toMatch(/@|uuid|user_id/i)
  })

  it("baixar gera um .txt com cabeçalho e 10 linhas", async () => {
    render(<MfaRecoveryCodesDialog open mode="enroll" codes={CODES} />)

    fireEvent.click(screen.getByRole("button", { name: /baixar arquivo/i }))
    await vi.waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1))

    const blob = createObjectURL.mock.calls[0][0] as Blob
    const text = await blob.text()
    expect(text.split("\n").filter((line) => /^[a-z2-7]{4}(?:-[a-z2-7]{4}){5}$/.test(line))).toHaveLength(10)
    expect(anchorClick).toHaveBeenCalled()
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:mfa-recovery")
  })

  it("concluir permanece desabilitado até o checkbox exato ser marcado", async () => {
    const onConfirm = vi.fn()
    render(<MfaRecoveryCodesDialog open mode="enroll" codes={CODES} onConfirm={onConfirm} />)

    const checkbox = screen.getByRole("checkbox", {
      name: /confirmo que copiei ou baixei meus 10 códigos de recuperação em um local seguro/i,
    })
    const finish = screen.getByRole("button", { name: /concluir/i }) as HTMLButtonElement
    expect(finish.disabled).toBe(true)

    fireEvent.click(checkbox)
    expect(checkbox.getAttribute("data-state")).toBe("checked")
    expect(finish.disabled).toBe(false)

    fireEvent.click(finish)
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it("checkbox acompanha en-US e nenhum código vai para o console", async () => {
    await i18n.changeLanguage("en-US")
    const spies = (["log", "info", "warn", "error"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    )
    try {
      render(<MfaRecoveryCodesDialog open mode="enroll" codes={CODES} />)
      expect(
        screen.getByRole("checkbox", {
          name: /i confirm that i copied or downloaded my 10 recovery codes to a secure location/i,
        }),
      ).toBeTruthy()
      for (const spy of spies) {
        for (const args of spy.mock.calls) {
          expect(args.map(String).join(" ")).not.toContain(CODES[0])
        }
      }
    } finally {
      spies.forEach((spy) => spy.mockRestore())
    }
  })
})

describe("whenManagementOpens_thenRemainingUsedLowBannerAndRegenerationAreHonest", () => {
  it("mostra X de 10 restantes, (Usado) tachado e banner quando restam 2", () => {
    render(<MfaRecoveryCodesDialog open mode="manage" status={status(2)} />)

    expect(screen.getByText(/2 de 10 códigos restantes/i)).toBeTruthy()
    expect(screen.getByRole("status").textContent).toMatch(/poucos códigos|restam 2/i)
    expect(screen.getAllByText("(Usado)")).toHaveLength(8)
    const used = screen.getAllByText("(Usado)")[0]
    expect(used.parentElement?.className).toMatch(/line-through/)
  })

  it("rótulo do código usado aparece uma única vez, sem duplicata", () => {
    render(<MfaRecoveryCodesDialog open mode="manage" status={status(2)} />)

    const usedRows = screen.getAllByText("(Usado)").map((node) => node.closest("li"))
    expect(usedRows).toHaveLength(8)
    for (const row of usedRows) {
      expect(row).not.toBeNull()
      expect(within(row!).getAllByText(/^Código \d{2}$/)).toHaveLength(1)
    }
  })

  it("sem banner quando restam 3 códigos", () => {
    render(<MfaRecoveryCodesDialog open mode="manage" status={status(3)} />)

    expect(screen.getByText(/3 de 10 códigos restantes/i)).toBeTruthy()
    expect(screen.queryByRole("status")).toBeNull()
    expect(screen.getAllByText("(Usado)")).toHaveLength(7)
  })

  it("regeneração exige a confirmação textual exata", async () => {
    const onRegenerate = vi.fn(async (_confirmation: string) => undefined)
    render(
      <MfaRecoveryCodesDialog open mode="manage" status={status(2)} onRegenerate={onRegenerate} />,
    )

    fireEvent.click(screen.getByRole("button", { name: /gerar novos códigos/i }))

    const input = screen.getByLabelText(/digite revogar_codigos_atuais/i) as HTMLInputElement
    const confirm = screen.getByRole("button", { name: /revogar e gerar/i }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    fireEvent.change(input, { target: { value: "ERRADO" } })
    expect(confirm.disabled).toBe(true)
    fireEvent.change(input, { target: { value: "REVOGAR_CODIGOS_ATUAIS" } })
    expect(confirm.disabled).toBe(false)

    fireEvent.click(confirm)
    await vi.waitFor(() => expect(onRegenerate).toHaveBeenCalledWith("REVOGAR_CODIGOS_ATUAIS"))
  })

  it("nova lista aparece uma única vez após regeneração", () => {
    render(
      <MfaRecoveryCodesDialog
        open
        mode="manage"
        status={status(2)}
        newCodes={CODES}
        onDone={vi.fn()}
      />,
    )

    expect(screen.getByText(FORMATTED_FIRST)).toBeTruthy()
    expect(screen.queryByText(/2 de 10 códigos restantes/i)).toBeNull()
    expect(screen.getByRole("button", { name: /concluir/i })).toBeTruthy()
  })

  it("estado de carregamento desabilita ações e erro é não bloqueante", () => {
    render(
      <MfaRecoveryCodesDialog
        open
        mode="manage"
        status={status(2)}
        loading
        error="mfa-recovery-confirmation-required"
      />,
    )

    expect((screen.getByRole("button", { name: /gerar novos códigos/i }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    const alert = screen.getByRole("alert")
    expect(alert.textContent).toMatch(/não foi possível|confirmação/i)
    expect(screen.queryByRole("alertdialog")).toBeNull()
  })

  it("alcance acessível: diálogo com título e alvos de 44px", () => {
    render(<MfaRecoveryCodesDialog open mode="manage" status={status(2)} />)

    const dialog = screen.getByRole("dialog")
    expect(within(dialog).getByText(/códigos de recuperação/i)).toBeTruthy()
    expect(screen.getByRole("button", { name: /gerar novos códigos/i }).className).toMatch(/min-h-11/)
  })
})
