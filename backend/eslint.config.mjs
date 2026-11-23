import tsParser from '@typescript-eslint/parser';

/**
 * G2 — complementar ao G1. Cobre somente imports estáticos (limitação
 * documentada: https://eslint.org/docs/latest/rules/no-restricted-imports,
 * consultado 2026-11-22). G1 continua autoritativo no test:gate.
 */
const restricted = (otherContext) => [
  {
    patterns: [
      {
        regex:
          otherContext === 'cliente'
            ? '(^|/)cliente(/|$)'
            : '(^|/)control-plane(/|$)',
        allowTypeImports: false,
        message: `import cruzado para apps/${otherContext}: use somente libs/shared-contracts/src/v1`,
      },
    ],
  },
];

/** libs/ e arquivos soltos na raiz não podem importar nenhum dos dois apps. */
const appPatterns = [
  {
    regex: '(^|/)apps/(cliente|control-plane)(/|$)',
    allowTypeImports: false,
    message: 'libs/ e raiz não podem importar apps/*: use somente contratos v1',
  },
  {
    regex: '^@(app/)?(cliente|control-plane)(/|$)',
    allowTypeImports: false,
    message: 'alias de app proibido em libs/ e raiz',
  },
  {
    regex: '(^|/)(cliente|control-plane)/src(/|$)',
    allowTypeImports: false,
    message: 'caminho relativo para apps/* proibido em libs/ e raiz',
  },
];

export default [
  { ignores: ['**/node_modules/**', '**/dist/**'] },
  {
    files: ['apps/cliente/**/*.ts'],
    languageOptions: { parser: tsParser, ecmaVersion: 2022, sourceType: 'module' },
    rules: { 'no-restricted-imports': ['error', ...restricted('control-plane')] },
  },
  {
    files: ['apps/control-plane/**/*.ts'],
    languageOptions: { parser: tsParser, ecmaVersion: 2022, sourceType: 'module' },
    rules: { 'no-restricted-imports': ['error', ...restricted('cliente')] },
  },
  {
    files: ['libs/shared-contracts/**/*.ts'],
    languageOptions: { parser: tsParser, ecmaVersion: 2022, sourceType: 'module' },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@nestjs/drizzle',
              message: 'shared-contracts só transporta formas de dados',
            },
          ],
          patterns: appPatterns,
        },
      ],
    },
  },
  {
    files: ['*.ts', '*.js', '*.mjs', '*.cjs'],
    languageOptions: { parser: tsParser, ecmaVersion: 2022, sourceType: 'module' },
    rules: { 'no-restricted-imports': ['error', { patterns: appPatterns }] },
  },
];
