import type { Preview } from '@storybook/react'
import '@/i18n'
import '@/index.css'

const preview: Preview = {
  parameters: {
    layout: 'fullscreen',
    controls: { expanded: false },
  },
  globalTypes: {
    theme: {
      description: 'Tema do design system (classe .dark)',
      defaultValue: 'light',
      toolbar: {
        title: 'Tema',
        icon: 'circlehollow',
        items: [
          { value: 'light', title: 'Claro' },
          { value: 'dark', title: 'Escuro' },
        ],
        dynamicTitle: true,
      },
    },
  },
  decorators: [
    (Story, context) => {
      const theme = (context.globals?.theme as string | undefined) ?? 'light'
      if (typeof document !== 'undefined') {
        document.documentElement.classList.toggle('dark', theme === 'dark')
      }
      return Story()
    },
  ],
}

export default preview
