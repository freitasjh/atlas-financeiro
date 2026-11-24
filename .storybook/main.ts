import path from 'node:path'
import type { StorybookConfig } from '@storybook/react-vite'
import tailwindcss from '@tailwindcss/vite'

/**
 * Storybook mínimo para evidência visual da vitrine (`frontend/src/components/shadcn/**`).
 * Reaproveita plugins/alias do `vite.config.ts` do app — nada de configuração
 * duplicada de build.
 */
const config: StorybookConfig = {
  stories: ['../frontend/src/components/shadcn/**/*.stories.@(ts|tsx)'],
  addons: [],
  framework: {
    name: '@storybook/react-vite',
    options: {},
  },
  viteFinal: async (viteConfig) => {
    viteConfig.plugins = [...(viteConfig.plugins ?? []), tailwindcss()]
    viteConfig.resolve = viteConfig.resolve ?? {}
    viteConfig.resolve.alias = {
      ...(viteConfig.resolve.alias ?? {}),
      '@': path.resolve(import.meta.dirname, '../src'),
    }
    return viteConfig
  },
}

export default config
