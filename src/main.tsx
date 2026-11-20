import React from 'react'
import ReactDOM from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import './i18n'
import './index.css'
import { bootstrapAuthFromHash } from './boot/auth-hash-bootstrap'

const rootElement = document.getElementById('root')

if (!rootElement) {
  throw new Error('Elemento root não encontrado no documento HTML')
}

// A ponte do fragmento precisa rodar antes de `createHashRouter`: o router lê
// `window.location.hash` na criação e o payload de convite/recovery precisa
// sair da URL (e virar sessão) antes disso. Por isso o router é importado
// dinamicamente depois do boot. Falha de rede/troca de sessão não pode deixar
// a tela branca: o render acontece de qualquer forma e o guard de sessão
// apresenta o estado retryable.
async function start(): Promise<void> {
  try {
    await bootstrapAuthFromHash(window.location.hash)
  } catch (error) {
    console.error('Falha ao consumir a ponte de auth do fragmento', error)
  } finally {
    const { router } = await import('./router')

    ReactDOM.createRoot(rootElement as HTMLElement).render(
      <React.StrictMode>
        <RouterProvider router={router} future={{ v7_startTransition: true }} />
      </React.StrictMode>,
    )
  }
}

void start()
