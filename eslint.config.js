import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    { ignores: ['dist/', '.build/', 'node_modules/', 'coverage/'] },
    js.configs.recommended,
    ...tseslint.configs.strict,
    {
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'module',
            globals: { process: 'readonly', console: 'readonly', URL: 'readonly' },
        },
        rules: {
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
            '@typescript-eslint/no-non-null-assertion': 'error',
            '@typescript-eslint/no-empty-function': 'off',
            eqeqeq: ['error', 'smart'],
            'prefer-const': 'error',
            'no-var': 'error',
        },
    },
);
