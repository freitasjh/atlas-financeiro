import type { Meta, StoryObj } from "@storybook/react"
import { useState } from "react"
import "@/i18n"

import { MfaRecoveryChallenge, type RecoveryConsumeOutcome } from "./mfa-recovery-challenge"

const meta: Meta<typeof MfaRecoveryChallenge> = {
  title: "Internal/MFA/RecoveryChallenge",
  component: MfaRecoveryChallenge,
  parameters: { layout: "centered" },
  tags: ["autodocs"],
}
export default meta
type Story = StoryObj<typeof MfaRecoveryChallenge>

function Frame({ outcome, disabled = false }: { outcome?: RecoveryConsumeOutcome; disabled?: boolean }) {
  const [done, setDone] = useState(false)
  return (
    <div className="w-[380px] rounded-lg border border-border/70 bg-card p-4">
      <MfaRecoveryChallenge
        disabled={disabled}
        onConsume={async () => outcome ?? { ok: true, remaining: 9 }}
        onSuccess={() => setDone(true)}
      />
      {done ? <p className="mt-2 text-xs text-emerald-600">aal2</p> : null}
    </div>
  )
}

export const Default: Story = { render: () => <Frame /> }

export const Disabled: Story = { render: () => <Frame disabled /> }

export const InvalidWithAttempts: Story = {
  render: () => (
    <Frame outcome={{ ok: false, error: "mfa-recovery-code-invalid", attempts_remaining: 1 }} />
  ),
}

export const Locked: Story = {
  render: () => (
    <Frame outcome={{ ok: false, error: "mfa-recovery-locked", retry_after_seconds: 900 }} />
  ),
}

export const PromotionFailed: Story = {
  render: () => <Frame outcome={{ ok: false, error: "mfa-recovery-aal-promotion-failed" }} />,
}

export const Success: Story = { render: () => <Frame /> }
