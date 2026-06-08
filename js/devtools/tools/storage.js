/**
 * DevTools 存储工具 — 读写 localStorage/sessionStorage/cookie
 */

import { state } from '../../core/state.js';
import { buildToolFromLegacy } from '../../tools/build-tool.js';

// ========== devtools_read_storage ==========

export const readStorageTool = {
    name: 'devtools_read_storage',
    description: 'Read data from browser storage (localStorage, sessionStorage, or cookies).',
    parameters: {
        type: 'object',
        properties: {
            type: {
                type: 'string',
                enum: ['localStorage', 'sessionStorage', 'cookie'],
                description: 'Storage type to read from'
            },
            key: {
                type: 'string',
                description: 'Specific key to read. If omitted, returns all entries.'
            }
        },
        required: ['type']
    }
};

export async function readStorageHandler(args) {
    const sessionId = state.currentSessionId;

    let result;

    if (args.type === 'cookie') {
        const cookies = {};
        if (document.cookie) {
            for (const pair of document.cookie.split('; ')) {
                const idx = pair.indexOf('=');
                if (idx > 0) {
                    cookies[pair.slice(0, idx)] = pair.slice(idx + 1);
                }
            }
        }
        result = args.key ? { key: args.key, value: cookies[args.key] ?? null } : { data: cookies };
    } else {
        const storage = args.type === 'localStorage' ? localStorage : sessionStorage;
        if (args.key) {
            result = { key: args.key, value: storage.getItem(args.key) };
        } else {
            const data = {};
            for (let i = 0; i < storage.length; i++) {
                const k = storage.key(i);
                data[k] = storage.getItem(k);
            }
            result = { data };
        }
    }

    if (state.currentSessionId !== sessionId) {
        return { error: 'Session switched during operation' };
    }
    return result;
}

// ========== devtools_write_storage ==========

export const writeStorageTool = {
    name: 'devtools_write_storage',
    description: 'Write or delete data in browser storage (localStorage or sessionStorage).',
    parameters: {
        type: 'object',
        properties: {
            type: {
                type: 'string',
                enum: ['localStorage', 'sessionStorage'],
                description: 'Storage type to write to'
            },
            key: {
                type: 'string',
                description: 'Storage key'
            },
            value: {
                type: 'string',
                description: 'Value to set (ignored when action is delete)'
            },
            action: {
                type: 'string',
                enum: ['set', 'delete'],
                description: 'Default: set'
            }
        },
        required: ['type', 'key']
    }
};

// 禁止写入的敏感 key 模式
const BLOCKED_KEY_PATTERNS = [
    /api[_-]?key/i,
    /\bsecret\b/i,
    /\bpassword\b/i,
    /\bcredential/i,
    /^endpoints$/i,
    /^apiKeys$/i,
    /^providers$/i,
    /^toolsEnabled$/i,
    /auth.*token/i,
    /access.?token/i,
    /refresh.?token/i
];

function isBlockedKey(key) {
    return BLOCKED_KEY_PATTERNS.some((p) => p.test(key));
}

export async function writeStorageHandler(args) {
    const sessionId = state.currentSessionId;

    if (isBlockedKey(args.key)) {
        return { error: `Writing to key "${args.key}" is blocked for security reasons` };
    }

    const storage = args.type === 'localStorage' ? localStorage : sessionStorage;
    const action = args.action || 'set';

    if (action === 'delete') {
        storage.removeItem(args.key);
    } else {
        storage.setItem(args.key, args.value ?? '');
    }

    if (state.currentSessionId !== sessionId) {
        return { error: 'Session switched during operation' };
    }
    return { success: true, action, type: args.type, key: args.key };
}

// ========== 标准化工具对象 ==========

export const readStorage = buildToolFromLegacy(
    'devtools_read_storage',
    readStorageTool,
    readStorageHandler,
    {
        isReadOnly: () => true
    }
);

export const writeStorage = buildToolFromLegacy(
    'devtools_write_storage',
    writeStorageTool,
    writeStorageHandler,
    {
        isReadOnly: () => false
    }
);
