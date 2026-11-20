import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import enUS from './messages/en-US'
import ptBR from './messages/pt-BR'

/**
 * `html[lang]` é responsabilidade do módulo i18n (nunca de `useEffect` de tela).
 * `index.html` nasce com `lang="pt-BR"`; a troca de idioma acompanha o i18next.
 */
function syncDocumentLang(lng: string) {
  if (typeof document !== 'undefined') {
    document.documentElement.lang = lng
  }
}

void i18n.use(initReactI18next).init({
  resources: {
    'pt-BR': { translation: ptBR },
    'en-US': { translation: enUS },
  },
  lng: 'pt-BR',
  fallbackLng: 'pt-BR',
  interpolation: { escapeValue: true },
})

i18n.on('languageChanged', syncDocumentLang)

syncDocumentLang('pt-BR')

export default i18n
