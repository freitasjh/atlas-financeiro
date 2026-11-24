// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'

afterEach(() => {
  cleanup()
  document.title = ''
})

function renderUseDocumentTitle(title: string | undefined) {
  return renderHook(() => useDocumentTitle(title), {
    wrapper: ({ children }) => <I18nextProvider i18n={i18n}>{children}</I18nextProvider>,
  })
}

describe('whenTitleIsUndefined_thenDocumentTitleIsAppName', () => {
  it('sem título, usa apenas o nome do app', () => {
    renderUseDocumentTitle(undefined)

    expect(document.title).toBe(i18n.t('shell.appName'))
  })
})

describe('whenTitleIsProvided_thenDocumentTitleUsesSeparator', () => {
  it('com título, usa o formato "título • app"', () => {
    renderUseDocumentTitle('Contas')

    expect(document.title).toBe(`Contas • ${i18n.t('shell.appName')}`)
  })
})
