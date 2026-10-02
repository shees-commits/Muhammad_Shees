// @ts-check
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

/**
 * Imports the domain layer must never see. The domain is pure TypeScript:
 * no transport (Express), persistence (Prisma), logging (pino), scheduling,
 * crypto/JWT libs or validation frameworks. Infrastructure plugs in via ports.
 */
const FORBIDDEN_IN_DOMAIN = [
  {
    group: ['express', 'express-*', '@types/express'],
    message: 'Domain must not depend on the HTTP framework.',
  },
  { group: ['@prisma/*', 'prisma'], message: 'Domain must not depend on the ORM. Use a port.' },
  { group: ['pino', 'pino-*'], message: 'Domain must not depend on the logger.' },
  {
    group: ['node-cron', 'jose', 'helmet', 'cors', 'zod', 'xss', 'supertest'],
    message: 'Domain must stay framework-free.',
  },
  {
    group: [
      '**/controllers/**',
      '**/repositories/**',
      '**/infrastructure/**',
      '**/shared/http/**',
      '**/shared/db/**',
      '**/shared/logging/**',
      '**/shared/config/**',
      '**/shared/auth/**',
      // The Actor type is a framework-free value object policies depend on.
      '!**/shared/auth/Actor.js',
      '**/container*',
    ],
    message: 'Dependency rule: domain must not import outer layers.',
  },
];

export default defineConfig(
  globalIgnores(['dist/**', 'coverage/**', 'node_modules/**', 'prisma/migrations/**']),
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        { 'ts-expect-error': 'allow-with-description' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'always'],
      'no-console': 'error',
      // Raw SQL must go through tagged templates ($queryRaw`...`) so values are parameterised.
      'no-restricted-properties': [
        'error',
        { property: '$queryRawUnsafe', message: 'Use $queryRaw tagged templates (parameterised).' },
        {
          property: '$executeRawUnsafe',
          message: 'Use $executeRaw tagged templates (parameterised).',
        },
      ],
    },
  },
  {
    files: ['src/modules/*/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: FORBIDDEN_IN_DOMAIN }],
    },
  },
  {
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  prettier,
);
