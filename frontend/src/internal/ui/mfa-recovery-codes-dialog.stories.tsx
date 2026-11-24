import type { Meta, StoryObj } from "@storybook/react"
import "@/i18n"

import { MfaRecoveryCodesDialog } from "./mfa-recovery-codes-dialog"
import type { RecoveryStatus } from "@/internal/data/mfa-recovery-codes"

const ALPHABET = "abcdefghijklmnopqrstuvwxyz"
const CODES: string[] = []
for (let row = 0; row < 10; row += 1) {
  let code = ""
  for (let column = 0; column < 24; column += 1) code += ALPHABET[(row + column) % 26]
  CODES.push(code)
}

function makeStatus(remaining: number): RecoveryStatus {
  const codes: { id: string; used_at: string | null }[] = []
  for (let index = 0; index < 10; index += 1) {
    codes.push({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      used_at: index < 10 - remaining ? "2026-11-21T00:00:00Z" : null,
    })
  }
  return { total: 10, remaining, low: remaining <= 2, codes }
}

const meta: Meta<typeof MfaRecoveryCodesDialog> = {
  title: "Internal/MFA/RecoveryCodesDialog",
  component: MfaRecoveryCodesDialog,
  parameters: { layout: "centered" },
  tags: ["autodocs"],
}
export default meta
type Story = StoryObj<typeof MfaRecoveryCodesDialog>

export const Enrollment: Story = { args: { open: true, mode: "enroll", codes: CODES } }

export const EnrollmentLoading: Story = {
  args: { open: true, mode: "enroll", codes: CODES, loading: true },
}

export const EnrollmentError: Story = {
  args: {
    open: true,
    mode: "enroll",
    codes: CODES,
    error: "mfa-recovery-forbidden",
  },
}

export const ManagementHealthy: Story = {
  args: { open: true, mode: "manage", status: makeStatus(8) },
}

export const ManagementLow: Story = {
  args: { open: true, mode: "manage", status: makeStatus(2) },
}

export const ManagementLoading: Story = {
  args: { open: true, mode: "manage", status: makeStatus(2), loading: true },
}

export const ManagementError: Story = {
  args: {
    open: true,
    mode: "manage",
    status: makeStatus(2),
    error: "mfa-recovery-confirmation-required",
  },
}

export const ManagementNewCodes: Story = {
  args: { open: true, mode: "manage", status: makeStatus(2), newCodes: CODES },
}

export const Disabled: Story = {
  args: { open: true, mode: "manage", status: null, loading: true },
}
