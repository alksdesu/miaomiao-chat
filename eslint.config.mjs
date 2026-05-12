import js from '@eslint/js';
import prettier from 'eslint-config-prettier';

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
    IDBKeyRange: 'readonly',
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
    Request: 'readonly',
    Response: 'readonly',
    ReadableStream: 'readonly',
    WritableStream: 'readonly',
    TransformStream: 'readonly',
    AbortController: 'readonly',
    AbortSignal: 'readonly',
    Image: 'readonly',
    FileReader: 'readonly',
    File: 'readonly',
    TextDecoder: 'readonly',
    TextEncoder: 'readonly',
    CSS: 'readonly',
    WebSocket: 'readonly',
    crypto: 'readonly',
    BroadcastChannel: 'readonly',
    IntersectionObserver: 'readonly',
    MutationObserver: 'readonly',
    ResizeObserver: 'readonly',
    PerformanceObserver: 'readonly',
    performance: 'readonly',
    setTimeout: 'readonly',
    clearTimeout: 'readonly',
    requestAnimationFrame: 'readonly',
    cancelAnimationFrame: 'readonly',
    requestIdleCallback: 'readonly',
    cancelIdleCallback: 'readonly',
    setInterval: 'readonly',
    clearInterval: 'readonly',
    queueMicrotask: 'readonly',
    Capacitor: 'readonly',
    getComputedStyle: 'readonly',
    Event: 'readonly',
    CustomEvent: 'readonly',
    EventTarget: 'readonly',
    HTMLElement: 'readonly',
    HTMLCanvasElement: 'readonly',
    HTMLImageElement: 'readonly',
    HTMLInputElement: 'readonly',
    HTMLTextAreaElement: 'readonly',
    Node: 'readonly',
    Element: 'readonly',
    HTMLCollection: 'readonly',
    NodeList: 'readonly',
    DOMParser: 'readonly',
    XMLSerializer: 'readonly',
    Worker: 'readonly',
    SharedWorker: 'readonly',
    MessageChannel: 'readonly',
    MessagePort: 'readonly',
    history: 'readonly',
    location: 'readonly',
    alert: 'readonly',
    confirm: 'readonly',
    prompt: 'readonly',
    structuredClone: 'readonly'
};

const nodeGlobals = {
    require: 'readonly',
    process: 'readonly',
    __dirname: 'readonly',
    __filename: 'readonly',
    module: 'readonly',
    exports: 'readonly',
    Buffer: 'readonly',
    setImmediate: 'readonly',
    clearImmediate: 'readonly',
    global: 'readonly',
    globalThis: 'readonly'
};

const allGlobals = { ...browserGlobals, ...nodeGlobals };

const sharedRules = {
    'no-unused-vars': ['warn', {
        args: 'after-used',
        caughtErrors: 'all',
        caughtErrorsIgnorePattern: '^_',
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_'
    }],
    'no-console': 'off',
    'no-debugger': 'error',
    'no-eval': 'error',
    'no-implied-eval': 'error',
    'prefer-const': 'warn',
    'no-var': 'error',
    'no-restricted-syntax': ['error', {
        selector: 'AssignmentExpression[left.property.name="innerHTML"]',
        message: '避免裸 innerHTML 赋值，使用 escapeHtml + 模板 或 safeSetHTML 替代。已审计通过的用 // eslint-disable-next-line no-restricted-syntax 标记。'
    }]
};

export default [
    {
        ignores: [
            'node_modules/**',
            'dist/**',
            'build/**',
            'android/**',
            'ios/**',
            'www/**',
            'scripts/**',
            'coverage/**',
            'releases/**',
            '*.min.js',
            '*.config.js',
            '*.config.mjs',
            'capacitor.config.ts'
        ]
    },
    js.configs.recommended,
    prettier,
    {
        files: ['**/*.js', '**/*.mjs'],
        linterOptions: {
            reportUnusedDisableDirectives: 'off'
        },
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: allGlobals
        },
        rules: sharedRules
    },
    {
        files: ['electron/**/*.js'],
        languageOptions: {
            sourceType: 'commonjs'
        }
    }
];
