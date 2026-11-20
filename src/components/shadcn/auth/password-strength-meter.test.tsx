// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import { I18nextProvider } from "react-i18next"

import i18n from "@/i18n"
import {
  PasswordStrengthMeter,
  passwordStrengthScore,
} from "@/components/shadcn/auth/password-strength-meter"

afterEach(() => cleanup())

describe("passwordStrengthScore", () => {
  it("whenPasswordIsEmpty_thenScoreIsZero", () => {
    expect(passwordStrengthScore("")).toBe(0)
  })

  it("whenPasswordIsShort_thenScoreIsWeak", () => {
    expect(passwordStrengthScore("abc")).toBe(1)
    expect(passwordStrengthScore("abcdef")).toBe(1)
  })

  it("whenPasswordHasTenChars_thenScoreIsFair", () => {
    expect(passwordStrengthScore("abcdefghij")).toBe(2)
  })

  it("whenPasswordMixesCase_thenScoreIsGood", () => {
    expect(passwordStrengthScore("Abcdefghij")).toBe(3)
  })

  it("whenPasswordMixesCaseDigitAndSymbol_thenScoreIsStrong", () => {
    expect(passwordStrengthScore("Abcdefgh1!")).toBe(4)
  })
})

describe("PasswordStrengthMeter", () => {
  function renderMeter(password: string) {
    return render(
      <I18nextProvider i18n={i18n}>
        <PasswordStrengthMeter password={password} />
      </I18nextProvider>,
    )
  }

  it("whenEmpty_thenFourMutedSegmentsAndNoLabel", () => {
    const { container } = renderMeter("")
    expect(container.querySelectorAll("[data-strength-segment]")).toHaveLength(4)
    expect(container.querySelectorAll('[data-strength-segment][data-filled="true"]')).toHaveLength(0)
    const label = container.querySelector('[data-strength-label]')
    expect(label).not.toBeNull()
    expect(label?.textContent?.trim()).toBe("")
  })

  it("whenWeak_thenOneFilledSegmentAndVisibleLabel", () => {
    const { container } = renderMeter("abc")
    expect(container.querySelectorAll('[data-strength-segment][data-filled="true"]')).toHaveLength(1)
    const label = container.querySelector('[data-strength-label]')
    expect(label?.getAttribute("aria-live")).toBe("polite")
    expect(label?.textContent).toContain(i18n.t("auth.setPassword.strength.weak"))
  })

  it("whenStrong_thenFourFilledSegmentsAndStrongLabel", () => {
    const { container } = renderMeter("Abcdefgh1!")
    expect(container.querySelectorAll('[data-strength-segment][data-filled="true"]')).toHaveLength(4)
    expect(screen.getByText(i18n.t("auth.setPassword.strength.strong"))).toBeTruthy()
  })
})
