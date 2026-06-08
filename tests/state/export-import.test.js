/**
 * export-import.js 测试
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../js/core/state.js', () => ({
    state: {
        storageMode: 'indexedDB',
        sessions: [],
        messages: [],
        currentSessionId: 'sess1'
    }
}));

vi.mock('../../js/core/elements.js', () => ({
    elements: { importInput: null }
}));

vi.mock('../../js/state/storage.js', () => ({
    loadAllSessionsFromDB: vi.fn(() => Promise.resolve([])),
    saveSessionToDB: vi.fn(() => Promise.resolve()),
    loadSessionMessages: vi.fn(() => Promise.resolve(null)),
    saveSessionMessages: vi.fn(() => Promise.resolve()),
    loadConfig: vi.fn(() => Promise.resolve(null)),
    loadSavedConfigs: vi.fn(() => Promise.resolve([])),
    saveConfig: vi.fn(() => Promise.resolve()),
    saveSavedConfigs: vi.fn(() => Promise.resolve()),
    loadPreference: vi.fn(() => Promise.resolve(null)),
    savePreference: vi.fn(() => Promise.resolve()),
    loadAllFromStore: vi.fn(() => Promise.resolve([])),
    saveToStore: vi.fn(() => Promise.resolve()),
    deleteFromStore: vi.fn(() => Promise.resolve()),
    STORES: { FOLDERS: 'folders', SESSIONS: 'sessions', MESSAGES: 'messages' }
}));

vi.mock('../../js/state/config.js', () => ({
    loadSavedConfigs: vi.fn(() => Promise.resolve())
}));

vi.mock('../../js/state/sessions.js', () => ({
    loadSessions: vi.fn(() => Promise.resolve())
}));

vi.mock('../../js/ui/notifications.js', () => ({
    showNotification: vi.fn()
}));

vi.mock('../../js/utils/dialogs.js', () => ({
    showConfirmDialog: vi.fn(() => Promise.resolve(true))
}));

vi.mock('../../js/api/format-converter.js', () => ({
    sanitizeMessageForExport: vi.fn((msg) => {
        const clean = { ...msg };
        delete clean._private;
        return clean;
    })
}));

vi.mock('../../js/utils/file-helpers.js', () => ({
    categorizeFile: vi.fn((mime) => {
        if (mime.startsWith('image/')) return 'image';
        if (mime.startsWith('video/')) return 'video';
        if (mime.includes('pdf')) return 'pdf';
        return 'text';
    })
}));

vi.mock('../../js/messages/schema.js', () => ({
    SCHEMA_VERSION: 2,
    isSchemaFormatParts: vi.fn((msg) => !!msg?.parts),
    getTextContent: vi.fn((msg) => {
        if (msg?.parts) {
            const textPart = msg.parts.find((p) => p.type === 'text');
            return textPart?.text || '';
        }
        return msg?.content || '';
    }),
    getThinkingContent: vi.fn((msg) => {
        if (msg?.parts) {
            const tp = msg.parts.find((p) => p.type === 'thinking');
            return tp?.text || '';
        }
        return msg?.thinkingContent || '';
    })
}));

vi.mock('../../js/messages/migration.js', () => ({
    migrateSession: vi.fn((messages) => ({
        messages: messages.map((m) => ({ ...m, _schemaVersion: 2 })),
        errors: [],
        toolMsgCount: 0
    }))
}));

vi.mock('../../js/utils/logger.js', () => ({
    logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() }
}));

import {
    sessionToMarkdown,
    initExportImport,
    exportConfig,
    exportSessions,
    exportAllData
} from '../../js/state/export-import.js';
import { state } from '../../js/core/state.js';
import { showNotification } from '../../js/ui/notifications.js';
import { showConfirmDialog } from '../../js/utils/dialogs.js';
import { loadAllSessionsFromDB, loadSessionMessages } from '../../js/state/storage.js';

describe('export-import', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        document.body.innerHTML = '';
    });

    // ========== sessionToMarkdown ==========
    describe('sessionToMarkdown', () => {
        it('null session 返回空', () => {
            expect(sessionToMarkdown(null)).toBe('');
        });

        it('空消息返回空', () => {
            expect(sessionToMarkdown({ name: 'test', messages: [] })).toBe('');
        });

        it('基本消息转换', () => {
            const session = {
                name: 'Test Chat',
                messages: [
                    { role: 'user', content: 'Hello' },
                    { role: 'assistant', content: 'Hi there' }
                ]
            };
            const md = sessionToMarkdown(session);
            expect(md).toContain('# Test Chat');
            expect(md).toContain('## User');
            expect(md).toContain('## Assistant');
        });

        it('跳过 system 消息', () => {
            const session = {
                name: 'Chat',
                messages: [
                    { role: 'system', content: 'You are helpful' },
                    { role: 'user', content: 'Hi' }
                ]
            };
            const md = sessionToMarkdown(session);
            expect(md).not.toContain('system');
            expect(md).toContain('## User');
        });

        it('包含 thinking content', () => {
            const session = {
                name: 'Chat',
                messages: [
                    {
                        role: 'assistant',
                        parts: [
                            { type: 'thinking', text: 'Let me think...' },
                            { type: 'text', text: 'Here is my answer' }
                        ]
                    }
                ]
            };
            const md = sessionToMarkdown(session);
            expect(md).toContain('Thinking');
            expect(md).toContain('Let me think');
        });

        it('包含 tool calls', () => {
            const session = {
                name: 'Chat',
                messages: [
                    {
                        role: 'assistant',
                        parts: [
                            { type: 'tool_call', name: 'calculator', id: 'tc1', args: {} },
                            { type: 'text', text: 'Done' }
                        ]
                    }
                ]
            };
            const md = sessionToMarkdown(session);
            expect(md).toContain('Tool Calls');
            expect(md).toContain('calculator');
        });

        it('无名称使用默认', () => {
            const session = {
                messages: [{ role: 'user', content: 'Hello' }]
            };
            const md = sessionToMarkdown(session);
            expect(md).toContain('Untitled Session');
        });

        it('无内容显示占位', () => {
            const session = {
                name: 'Empty',
                messages: [{ role: 'assistant' }]
            };
            const md = sessionToMarkdown(session);
            expect(md).toContain('[无文本内容]');
        });
    });

    // ========== initExportImport ==========
    describe('initExportImport', () => {
        it('不抛错', () => {
            expect(() => initExportImport()).not.toThrow();
        });

        it('有按钮时绑定事件', () => {
            document.body.innerHTML = `
                <button id="export-config"></button>
                <button id="export-sessions"></button>
                <button id="export-all"></button>
                <button id="import-data"></button>
                <input type="file" id="import-input" />
            `;
            expect(() => initExportImport()).not.toThrow();
        });
    });

    // ========== exportConfig ==========
    describe('exportConfig', () => {
        beforeEach(() => {
            global.URL.createObjectURL = vi.fn(() => 'blob:test');
            global.URL.revokeObjectURL = vi.fn();
        });

        it('用户取消不导出', async () => {
            showConfirmDialog.mockResolvedValue(false);
            await exportConfig();
            expect(showNotification).not.toHaveBeenCalled();
        });

        it('成功导出配置', async () => {
            showConfirmDialog.mockResolvedValue(true);
            state.storageMode = 'localStorage';
            localStorage.setItem('geminiChatConfig', '{"apiKey":"test"}');

            await exportConfig();

            expect(showNotification).toHaveBeenCalledWith('配置已导出', 'success');
        });

        it('导出失败显示错误', async () => {
            showConfirmDialog.mockImplementation(() => {
                throw new Error('dialog error');
            });

            await exportConfig();

            expect(showNotification).toHaveBeenCalledWith(
                expect.stringContaining('导出配置失败'),
                'error'
            );
        });
    });

    // ========== exportSessions ==========
    describe('exportSessions', () => {
        beforeEach(() => {
            global.URL.createObjectURL = vi.fn(() => 'blob:test');
            global.URL.revokeObjectURL = vi.fn();
        });

        it('成功导出会话', async () => {
            loadAllSessionsFromDB.mockResolvedValue([
                { id: 's1', name: 'Chat 1', messages: [{ role: 'user', content: 'Hi' }] }
            ]);

            await exportSessions();

            expect(showNotification).toHaveBeenCalledWith(
                expect.stringContaining('1 个会话'),
                'success'
            );
        });

        it('空会话列表正常导出', async () => {
            loadAllSessionsFromDB.mockResolvedValue([]);

            await exportSessions();

            expect(showNotification).toHaveBeenCalledWith(
                expect.stringContaining('0 个会话'),
                'success'
            );
        });

        it('导出失败显示错误', async () => {
            loadAllSessionsFromDB.mockRejectedValue(new Error('DB error'));

            await exportSessions();

            expect(showNotification).toHaveBeenCalledWith(
                expect.stringContaining('导出会话失败'),
                'error'
            );
        });
    });

    // ========== exportAllData ==========
    describe('exportAllData', () => {
        beforeEach(() => {
            global.URL.createObjectURL = vi.fn(() => 'blob:test');
            global.URL.revokeObjectURL = vi.fn();
        });

        it('用户取消不导出', async () => {
            showConfirmDialog.mockResolvedValue(false);
            await exportAllData();
            expect(showNotification).not.toHaveBeenCalled();
        });

        it('成功导出全部数据', async () => {
            showConfirmDialog.mockResolvedValue(true);
            loadAllSessionsFromDB.mockResolvedValue([{ id: 's1', name: 'Chat', messages: [] }]);
            state.storageMode = 'localStorage';

            await exportAllData();

            expect(showNotification).toHaveBeenCalledWith(
                expect.stringContaining('已导出完整备份'),
                'success'
            );
        });
    });
});
