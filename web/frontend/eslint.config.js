import globals from 'globals';

const commonRules = {
    'no-undef': 'error',
    'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }],
    'no-redeclare': 'error',
    'no-unreachable': 'error',
    'no-dupe-keys': 'error',
    'no-dupe-args': 'error',
    'no-cond-assign': 'error',
    'no-constant-condition': ['error', { checkLoops: false }],
    'no-empty': ['error', { allowEmptyCatch: true }],
    eqeqeq: ['error', 'smart']
};

export default [
    {
        ignores: [
            'node_modules/**',
            'vendor/**',
            '.auth/**',
            '.e2e-data/**',
            'playwright-report/**',
            'test-results/**'
        ]
    },
    {
        files: ['src/**/*.js'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: globals.browser
        },
        rules: commonRules
    },
    {
        files: ['src/**/*.test.js'],
        languageOptions: {
            globals: { ...globals.browser, ...globals.node }
        }
    },
    {
        files: ['e2e/**/*.js', '*.config.js'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: { ...globals.node, ...globals.browser }
        },
        rules: commonRules
    }
];
