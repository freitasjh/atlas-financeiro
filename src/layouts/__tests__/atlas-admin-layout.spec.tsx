// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { RouterProvider, createMemoryRouter } from 'react-router-dom'
import i18n from '@/i18n'
import { AtlasAdminLayout } from '@/layouts/AtlasAdminLayout'

afterEach(async () => {
  cleanup()
  document.title = ''
  await i18n.changeLanguage('pt-BR')
})

function renderLayoutAt(initialEntry: string) {
  const router = createMemoryRouter([
    {
      element: <AtlasAdminLayout />,
      children: [
        { index: true, handle: { title: 'dashboard.title' }, element: <p>página inicial</p> },
        { path: 'contas', handle: { title: 'accounts.title' }, element: <p>contas</p> },
      ],
    },
  ], { initialEntries: [initialEntry] })

  return render(
    <I18nextProvider i18n={i18n}>
      <RouterProvider router={router} />
    </I18nextProvider>,
  )
}

describe('whenLayoutRenders_thenSingleMainLandmarkExists', () => {
  it('SidebarInset segue como main único (sem main aninhado)', () => {
    const router = createMemoryRouter([
      {
        element: (
          <AtlasAdminLayout>
            <p>conteúdo</p>
          </AtlasAdminLayout>
        ),
        children: [{ index: true, element: <p>conteúdo</p> }],
      },
    ])
    render(
      <I18nextProvider i18n={i18n}>
        <RouterProvider router={router} />
      </I18nextProvider>,
    )

    expect(document.querySelectorAll('main').length).toBe(1)
  })
})

describe('whenLayoutReceivesChildren_thenContentIsRenderedInsideMain', () => {
  it('renderiza children obrigatório dentro do main', () => {
    const router = createMemoryRouter([
      {
        element: (
          <AtlasAdminLayout>
            <p>conteúdo-do-children</p>
          </AtlasAdminLayout>
        ),
        children: [{ index: true, element: <p>rota-filha</p> }],
      },
    ])
    render(
      <I18nextProvider i18n={i18n}>
        <RouterProvider router={router} />
      </I18nextProvider>,
    )

    expect(document.querySelector('main')?.textContent).toContain('conteúdo-do-children')
  })
})

describe('whenLayoutRendersWithRouteTitle_thenDocumentTitleReflectsRoute', () => {
  it('título da aba contém o título i18n da rota e o nome do app', () => {
    renderLayoutAt('/contas')

    expect(document.title).toBe(`${i18n.t('accounts.title')} • ${i18n.t('shell.appName')}`)
    expect(document.title).toContain(i18n.t('shell.appName'))
  })
})

describe('whenRouteChanges_thenDocumentTitleUpdates', () => {
  it('navegar de / para /contas troca o título da aba', async () => {
    const router = createMemoryRouter([
      {
        element: <AtlasAdminLayout />,
        children: [
          { index: true, handle: { title: 'dashboard.title' }, element: <p>início</p> },
          { path: 'contas', handle: { title: 'accounts.title' }, element: <p>contas</p> },
        ],
      },
    ], { initialEntries: ['/'] })
    render(
      <I18nextProvider i18n={i18n}>
        <RouterProvider router={router} />
      </I18nextProvider>,
    )
    expect(document.title).toContain(i18n.t('dashboard.title'))

    await act(async () => {
      await router.navigate('/contas')
    })

    expect(document.title).toContain(i18n.t('accounts.title'))
    expect(document.title).not.toContain(i18n.t('dashboard.title'))
  })
})

describe('whenLocaleChanges_thenDocumentTitleUsesTranslatedTitle', () => {
  it('trocar PT-BR → en-US atualiza o título da aba', async () => {
    renderLayoutAt('/')
    expect(document.title).toContain('Visão geral')

    await act(async () => {
      await i18n.changeLanguage('en-US')
    })

    expect(document.title).toContain('Overview')
    expect(document.title).toContain(i18n.t('shell.appName'))
  })
})

describe('whenLayoutUnmounts_thenDocumentTitleRestoresBase', () => {
  it('desmontar volta ao título base do app', () => {
    const { unmount } = renderLayoutAt('/contas')
    expect(document.title).toContain(i18n.t('accounts.title'))

    unmount()

    expect(document.title).toBe(i18n.t('shell.appName'))
  })
})
