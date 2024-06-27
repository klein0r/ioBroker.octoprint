const globals = require('globals');
const js = require('@eslint/js');

const { FlatCompat } = require('@eslint/eslintrc');

const compat = new FlatCompat({
    baseDirectory: __dirname,
    recommendedConfig: js.configs.recommended,
    allConfig: js.configs.all,
});

module.exports = [
    {
        ignores: ['.dev-server/**'],
    },
    ...compat.extends('eslint:recommended', 'plugin:prettier/recommended'),
    {
        languageOptions: {
            globals: {
                ...globals.node,
                ...globals.mocha,
            },

            ecmaVersion: 2022,
            sourceType: 'commonjs',

            parserOptions: {
                ecmaFeatures: {
                    jsx: true,
                },
            },
        },

        rules: {
            'no-console': 'off',
            'no-var': 'error',
            'prefer-const': 'error',
        },
    },
];
