// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'

import { TransactionDialog } from '../TransactionDialog'
import type { TransactionDialogSaveData } from '../TransactionDialog'

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('pt-BR')
})

const toastMocks = vi.hoisted(() => ({ success: vi.fn(), info: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toastMocks }))

const ACCOUNTS = [{ id: 'acc-1', name: 'Conta principal' }]
const CATEGORIES = [
  { id: 'cat-mercado', name: 'Mercado', type: 'expense' as const },
  { id: 'cat-salario', name: 'Salário', type: 'income' as const },
  { id: 'cat-lazer', name: 'Lazer', type: 'expense' as const },
]

function renderDialog(overrides?: {
  onSave?: (data: TransactionDialogSaveData) => void | Promise<void>
  transactionToEdit?: any
  categories?: Array<{ id: string; name: string; type?: string }>
}) {
  const onSave = overrides?.onSave ?? vi.fn().mockResolvedValue(undefined)
  const onOpenChange = vi.fn()
  render(
    <I18nextProvider i18n={i18n}>
      <TransactionDialog
        open
        onOpenChange={onOpenChange}
        onSave={onSave}
        transactionToEdit={overrides?.transactionToEdit}
        accounts={ACCOUNTS}
        categories={overrides?.categories ?? CATEGORIES}
      />
    </I18nextProvider>,
  )
  return { onSave: onSave as ReturnType<typeof vi.fn>, onOpenChange }
}

async function openCategoryListbox() {
  const user = userEvent.setup()
  await user.click(screen.getByLabelText(/Categoria/))
  return user
}

describe('whenRealCategoriesProvided_thenListsThemInCombobox', () => {
  it('exibe as categorias reais além de "Sem categoria"', async () => {
    const user = userEvent.setup()
    renderDialog()
    await openCategoryListbox()
    // tipo padrão do formulário é receita: só categorias de receita + "Sem categoria"
    expect(await screen.findByRole('option', { name: 'Salário' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Sem categoria' })).toBeTruthy()
    expect(screen.queryByRole('option', { name: 'Mercado' })).toBeNull()
    // fecha com Escape e troca para despesa
    await user.keyboard('{Escape}')
    await user.click(screen.getByRole('button', { name: /Despesa/ }))
    await openCategoryListbox()
    expect(await screen.findByRole('option', { name: 'Mercado' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Lazer' })).toBeTruthy()
  })
})

describe('whenSearchQueryTyped_thenFiltersCategoryList', () => {
  it('filtra por texto digitado na busca', async () => {
    const user = userEvent.setup()
    renderDialog()
    await user.click(screen.getByRole('button', { name: /Despesa/ }))
    await openCategoryListbox()
    const search = await screen.findByPlaceholderText(/Buscar categoria/i)
    await user.type(search, 'laz')
    await waitFor(() => expect(screen.getByRole('option', { name: 'Lazer' })).toBeTruthy())
    expect(screen.queryByRole('option', { name: 'Mercado' })).toBeNull()
  })
})

describe('whenTypeIsSelected_thenOnlyMatchingCategoriesListed', () => {
  it('tipo receita lista só categorias de receita', async () => {
    renderDialog()
    await openCategoryListbox()
    // tipo padrão do formulário é receita
    expect(screen.queryByRole('option', { name: 'Salário' })).toBeTruthy()
    expect(screen.queryByRole('option', { name: 'Mercado' })).toBeNull()
  })

  it('trocar para despesa lista só categorias de despesa', async () => {
    const user = userEvent.setup()
    renderDialog()
    await user.click(screen.getByRole('button', { name: /Despesa/ }))
    await openCategoryListbox()
    expect(screen.queryByRole('option', { name: 'Mercado' })).toBeTruthy()
    expect(screen.queryByRole('option', { name: 'Lazer' })).toBeTruthy()
    expect(screen.queryByRole('option', { name: 'Salário' })).toBeNull()
  })
})

describe('whenCategorySelected_thenPersistsCategoryId', () => {
  it('create envia o category_id escolhido', async () => {
    const user = userEvent.setup()
    const { onSave } = renderDialog()
    await user.click(screen.getByRole('button', { name: /Despesa/ }))
    await user.type(screen.getByLabelText(/Descrição/), 'Compra mercado')
    await user.type(screen.getByLabelText(/Valor/), '150,00')
    await user.click(screen.getByLabelText(/Categoria/))
    await user.click(await screen.findByRole('option', { name: 'Mercado' }))
    await user.click(screen.getByRole('button', { name: /Cadastrar|Salvar|Criar/ }))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    const payload = onSave.mock.calls[0][0] as TransactionDialogSaveData
    expect(payload.categoryId).toBe('cat-mercado')
    expect(payload.category_id).toBe('cat-mercado')
  })
})

describe('whenEditHasCategory_thenPreselectsCurrent', () => {
  it('pré-seleciona a categoria atual e permite trocar', async () => {
    const user = userEvent.setup()
    const { onSave } = renderDialog({
      transactionToEdit: {
        id: 't1',
        accountId: 'acc-1',
        categoryId: 'cat-mercado',
        date: '2026-05-10',
        amountCents: 20000,
        description: 'Edit me',
        type: 'expense',
        status: 'posted',
        reconciled: false,
      },
    })
    expect(screen.getByLabelText(/Categoria/).textContent).toContain('Mercado')
    await user.click(screen.getByLabelText(/Categoria/))
    await user.click(await screen.findByRole('option', { name: 'Lazer' }))
    await user.click(screen.getByRole('button', { name: /Cadastrar|Salvar|Criar/ }))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect((onSave.mock.calls[0][0] as TransactionDialogSaveData).categoryId).toBe('cat-lazer')
  })
})

describe('whenNoCategoryChosen_thenSendsNull', () => {
  it('"Sem categoria" persiste category_id null', async () => {
    const user = userEvent.setup()
    const { onSave } = renderDialog()
    await user.type(screen.getByLabelText(/Descrição/), 'Sem categoria aqui')
    await user.type(screen.getByLabelText(/Valor/), '10,00')
    await user.click(screen.getByRole('button', { name: /Cadastrar|Salvar|Criar/ }))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    const payload = onSave.mock.calls[0][0] as TransactionDialogSaveData
    expect(payload.categoryId).toBeNull()
    expect(payload.category_id).toBeNull()
  })
})
