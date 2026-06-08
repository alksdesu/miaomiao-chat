import js from '@eslint/js';
import prettier from 'eslint-config-prettier';

const sharedRules = {
    'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_'
    }],
    'no-console': 'off',
    'no-debugger': 'error',
    'no-eval': 'error',
    'no-implied-eval': 'error',
    'prefer-const': 'warn',
    'no-var': 'error',
    // innerHTML 安全审计：未审计的裸 innerHTML 赋值视为错误
    'no-restricted-syntax': [
        'error',
        {
            selector: 'AssignmentExpression[left.property.name="innerHTML"]',
            message: '避免裸 innerHTML 赋值，使用 escapeHtml + 模板 或 safeSetHTML 替代。已审计通过的用 // eslint-disable-next-line no-restricted-syntax 标记。'
        },
        {
            selector: 'AssignmentExpression[left.property.name="outerHTML"]',
            message: '避免裸 outerHTML 赋值（XSS + 节点替换风险）。已审计通过的用 // eslint-disable-next-line no-restricted-syntax 标记。'
        },
        {
            selector: 'CallExpression[callee.property.name="insertAdjacentHTML"]',
            message: '避免裸 insertAdjacentHTML 调用，第二参数必须为静态字符串或已 escapeHtml/safeMarkedParse 处理的内容。已审计通过的用 // eslint-disable-next-line no-restricted-syntax 标记。'
        },
        {
            selector: 'CallExpression[callee.object.name="document"][callee.property.name=/^writel?n?$/]',
            message: '禁止 document.write/writeln（同步阻塞解析 + XSS 风险）。如有必要请改用 DOM 节点 API。'
        }
    ]
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
    DOMException: 'readonly',
    Image: 'readonly',
    FileReader: 'readonly',
    TextDecoder: 'readonly',
    TextEncoder: 'readonly',
    CSS: 'readonly',
    WebSocket: 'readonly',
    crypto: 'readonly',
    structuredClone: 'readonly',
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
            'js/vendor/',
            '*.min.js',
            '*.config.js',
            '*.config.mjs',
            'capacitor.config.ts'
        ]
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
    },
    {
        files: ['tests/**/*.js'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: {
                ...browserGlobals,
                // Vitest globals（vi/describe/it/expect 通过 import 拿，无需声明；但部分文件用 globalThis）
                globalThis: 'readonly',
                global: 'readonly',
                process: 'readonly',
                Buffer: 'readonly',
                __dirname: 'readonly',
                __filename: 'readonly',
                queueMicrotask: 'readonly',
                MessageChannel: 'readonly',
                MessagePort: 'readonly',
                Storage: 'readonly',
                Node: 'readonly',
                Element: 'readonly',
                HTMLElement: 'readonly',
                HTMLInputElement: 'readonly',
                HTMLTextAreaElement: 'readonly',
                HTMLDivElement: 'readonly',
                HTMLButtonElement: 'readonly',
                HTMLAnchorElement: 'readonly',
                HTMLImageElement: 'readonly',
                HTMLCanvasElement: 'readonly',
                HTMLScriptElement: 'readonly',
                MutationObserver: 'readonly',
                ResizeObserver: 'readonly',
                KeyboardEvent: 'readonly',
                MouseEvent: 'readonly',
                InputEvent: 'readonly',
                FocusEvent: 'readonly',
                DragEvent: 'readonly',
                ClipboardEvent: 'readonly',
                DataTransfer: 'readonly',
                File: 'readonly',
                FileList: 'readonly',
                AbortSignal: 'readonly',
                EventTarget: 'readonly',
                Worker: 'readonly',
                Request: 'readonly',
                CSSStyleSheet: 'readonly',
                NodeFilter: 'readonly',
                XMLHttpRequest: 'readonly',
                location: 'readonly',
                history: 'readonly'
            }
        },
        rules: {
            ...sharedRules,
            // 测试里允许直接赋 innerHTML 构造 fixture
            'no-restricted-syntax': 'off',
            'no-unused-vars': 'off'
        }
    }
];
