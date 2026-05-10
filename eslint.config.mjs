import js from '@eslint/js';
import prettier from 'eslint-config-prettier';

const sharedRules = {
    'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_'
    }],
    'no-console': 'off',
    'no-debugger': 'error',
    'no-eval': 'error',
    'no-implied-eval': 'error',
    'prefer-const': 'warn',
    'no-var': 'error',
    // innerHTML 安全审计：未审计的裸 innerHTML 赋值视为错误
    'no-restricted-syntax': ['error', {
        selector: 'AssignmentExpression[left.property.name="innerHTML"]',
        message: '避免裸 innerHTML 赋值，使用 escapeHtml + 模板 或 safeSetHTML 替代。已审计通过的用 // eslint-disable-next-line no-restricted-syntax 标记。'
    }]
};

const browserGlobals = {
    window: 'readonly',
    document: 'readonly',
    navigator: 'readonly',
    console: 'readonly',
    fetch: 'readonly',
    FormData: 'readonly',
    localStorage: 'readonly',
    sessionStorage: 'readonly',
    indexedDB: 'readonly',
    IndexedDB: 'readonly',
    DOMPurify: 'readonly',
    marked: 'readonly',
    hljs: 'readonly',
    Prism: 'readonly',
    katex: 'readonly',
    atob: 'readonly',
    btoa: 'readonly',
    Blob: 'readonly',
    URL: 'readonly',
    URLSearchParams: 'readonly',
    Headers: 'readonly',
    Response: 'readonly',
    ReadableStream: 'readonly',
    AbortController: 'readonly',
    Image: 'readonly',
    FileReader: 'readonly',
    TextDecoder: 'readonly',
    TextEncoder: 'readonly',
    CSS: 'readonly',
    WebSocket: 'readonly',
    crypto: 'readonly',
    BroadcastChannel: 'readonly',
    IntersectionObserver: 'readonly',
    performance: 'readonly',
    setTimeout: 'readonly',
    clearTimeout: 'readonly',
    requestAnimationFrame: 'readonly',
    cancelAnimationFrame: 'readonly',
    requestIdleCallback: 'readonly',
    cancelIdleCallback: 'readonly',
    setInterval: 'readonly',
    clearInterval: 'readonly',
    Capacitor: 'readonly',
    getComputedStyle: 'readonly',
    Event: 'readonly',
    CustomEvent: 'readonly'
};

const electronGlobals = {
    console: 'readonly',
    require: 'readonly',
    process: 'readonly',
    __dirname: 'readonly',
    __filename: 'readonly',
    module: 'readonly',
    exports: 'readonly',
    Buffer: 'readonly',
    URL: 'readonly',
    setTimeout: 'readonly',
    clearTimeout: 'readonly',
    setInterval: 'readonly',
    clearInterval: 'readonly',
    setImmediate: 'readonly',
    clearImmediate: 'readonly'
};

export default [
    js.configs.recommended,
    prettier,
    {
        ignores: [
            'node_modules/',
            'dist/',
            'build/',
            'android/',
            'ios/',
            'www/',
            'scripts/',
            '*.min.js',
            '*.config.js',
            '*.config.mjs',
            'capacitor.config.ts'
        ]
    },
    {
        linterOptions: {
            reportUnusedDisableDirectives: 'off'
        },
        languageOptions: {
            globals: { ...browserGlobals, ...electronGlobals }
        }
    },
    {
        files: ['js/**/*.js'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: browserGlobals
        },
        rules: sharedRules
    },
    {
        files: ['electron/**/*.js'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'commonjs',
            globals: electronGlobals
        },
        rules: sharedRules
    }
];
