// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import { CategoryDialog } from '../CategoryDialog'
import type { CategoryFormValues } from '../../model/category-diff'

function renderDialog(props?: Partial<React.ComponentProps<typeof CategoryDialog>>) {
  return render(
    <I18nextProvider i18n={i18n}>
      <CategoryDialog
        open
        mode="create"
        isSaving={false}
        serverError={null}
        onOpenChange={() => {}}
        onSubmit={async () => {}}
        {...props}
      />
    </I18nextProvider>,
  )
}

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('pt-BR')
})

describe('whenCategoryDialogOpens_thenFirstFieldIsFocused', () => {
  it('foca o nome ao abrir', () => {
    renderDialog()
    expect(document.activeElement?.getAttribute('name')).toBe('name')
  })

  it('renderiza segmentado de tipo e swatch de cores 44px', () => {
    renderDialog()
    expect(screen.getByRole('radiogroup', { name: i18n.t('categories.type') })).toBeTruthy()
    expect(screen.getByRole('radiogroup', { name: i18n.t('categories.colorLabel') })).toBeTruthy()
    for (const option of screen.getAllByRole('radio')) {
      expect(option.className).toMatch(/min-h-11|min-h-\[44px\]|h-11|size-11/)
    }
  })
})

describe('whenCategoryNameIsInvalid_thenInlineErrorAndFocus', () => {
  it('nome vazio mostra erro inline e foca o campo', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn(async () => {})
    renderDialog({ onSubmit })
    await user.clear(screen.getByLabelText(/nome/i))
    await user.click(screen.getByRole('button', { name: i18n.t('categories.create') }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(onSubmit).not.toHaveBeenCalled()
    expect(document.activeElement?.getAttribute('name')).toBe('name')
  })
})

describe('whenCategoryDialogSubmits_thenPayloadHasNameTypeColor', () => {
  it('criar chama onSubmit com os valores do formulário', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn(async () => {})
    renderDialog({ onSubmit })
    await user.type(screen.getByLabelText(/nome/i), 'Mercado')
    await user.click(screen.getByRole('radio', { name: i18n.t('categories.typeExpense') }))
    await user.click(screen.getByRole('button', { name: i18n.t('categories.create') }))
    const calls = onSubmit.mock.calls as unknown as Array<[CategoryFormValues]>
    expect(calls).toHaveLength(1)
    expect(calls[0]?.[0]).toMatchObject({ name: 'Mercado', type: 'expense' })
  })

  it('modo edição pré-preenche e usa rótulo de salvar', () => {
    renderDialog({
      mode: 'edit',
      initial: { name: 'Salário', type: 'income', color: '#0ea5e9' },
    })
    expect((screen.getByLabelText(/nome/i) as HTMLInputElement).value).toBe('Salário')
    expect(screen.getByRole('button', { name: i18n.t('categories.update') })).toBeTruthy()
  })
})
