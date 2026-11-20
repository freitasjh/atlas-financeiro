// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import { act } from 'react'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import { useCardForm } from '../CardFormFields'

// Batch 2 — limite 0 rejeitado no form ("maior que zero"), alinhado ao
// zod positive() do model.

function renderForm() {
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <I18nextProvider i18n={i18n}>{children}</I18nextProvider>
  )
  return renderHook(
    () =>
      useCardForm({
        nickname: 'Nubank Final 1234',
        accountId: 'acc-1',
        limitCents: null,
        closingDay: 10,
        dueDay: 20,
      }),
    { wrapper },
  )
}

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('pt-BR')
})

describe('whenLimitIsZero_thenFormRejectsLikeZodPositive', () => {
  it('limite 0,00 bloqueia submit com mensagem "maior que zero"', () => {
    const { result } = renderForm()
    act(() => result.current.setLimitText('0,00'))

    let validated: unknown = 'not-called'
    act(() => {
      validated = result.current.validate()
    })

    expect(validated).toBeNull()
    expect(result.current.errors.limit).toBe(i18n.t('cards.limitError'))
    expect(i18n.t('cards.limitError')).toMatch(/maior que zero/)
  })

  it('limite positivo passa na validação', () => {
    const { result } = renderForm()
    act(() => result.current.setLimitText('150,00'))

    let validated: unknown = null
    act(() => {
      validated = result.current.validate()
    })

    expect(validated).not.toBeNull()
    expect(result.current.errors.limit).toBeUndefined()
  })
})
