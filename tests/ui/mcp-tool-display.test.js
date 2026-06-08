/**
 * mcp-tool-display.js 测试
 * 测试 exportMCPConfig 和 createFromTemplate
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../js/core/state.js', () => ({
    state: { mcpServers: [] }
}));

vi.mock('../../js/tools/mcp/client.js', () => ({
    mcpClient: {
        hasConnection: vi.fn(() => false),
        disconnect: vi.fn(() => Promise.resolve())
    }
}));

vi.mock('../../js/state/storage.js', () => ({
    saveMCPServer: vi.fn(() => Promise.resolve()),
    deleteMCPServer: vi.fn(() => Promise.resolve())
}));

vi.mock('../../js/ui/notifications.js', () => ({
    showNotification: vi.fn()
}));

vi.mock('../../js/utils/icons.js', () => ({
    getIcon: vi.fn(() => '<svg></svg>')
}));

vi.mock('../../js/utils/modal-stack.js', () => ({
    applyModalLayerZIndex: vi.fn(),
    bindTopmostEscape: vi.fn(() => vi.fn()),
    MODAL_LAYER_Z_INDEX: { settingsNested: 2000 },
    setupModalFocus: vi.fn(() => vi.fn())
}));

vi.mock('../../js/tools/mcp/config-converter.js', () => ({
    standardToInternal: vi.fn(() => []),
    internalToStandard: vi.fn(() => ({ mcpServers: {} })),
    validateStandardConfig: vi.fn(() => ({ valid: true, errors: [] })),
    generateTemplate: vi.fn(() => ({ mcpServers: {} })),
    getAvailableTemplates: vi.fn(() => [])
}));

vi.mock('../../js/ui/mcp-server-list.js', () => ({
    renderServerList: vi.fn()
}));

vi.mock('../../js/utils/logger.js', () => ({
    logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() }
}));

import { state } from '../../js/core/state.js';
import { showNotification } from '../../js/ui/notifications.js';
import { saveMCPServer } from '../../js/state/storage.js';
import {
    internalToStandard,
    standardToInternal,
    generateTemplate
} from '../../js/tools/mcp/config-converter.js';
import { renderServerList } from '../../js/ui/mcp-server-list.js';
import { exportMCPConfig, createFromTemplate } from '../../js/ui/mcp-tool-display.js';

describe('mcp-tool-display', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        state.mcpServers = [];
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    describe('exportMCPConfig', () => {
        it('成功导出配置', async () => {
            state.mcpServers = [{ id: 'srv1', name: 'Test' }];
            internalToStandard.mockReturnValue({ mcpServers: { test: {} } });

            // mock URL.createObjectURL / revokeObjectURL
            const mockUrl = 'blob:test';
            global.URL.createObjectURL = vi.fn(() => mockUrl);
            global.URL.revokeObjectURL = vi.fn();

            await exportMCPConfig();

            expect(internalToStandard).toHaveBeenCalledWith(state.mcpServers);
            expect(showNotification).toHaveBeenCalledWith(
                expect.stringContaining('配置已导出'),
                'success'
            );
        });

        it('导出失败显示错误通知', async () => {
            internalToStandard.mockImplementation(() => {
                throw new Error('test error');
            });

            await exportMCPConfig();

            expect(showNotification).toHaveBeenCalledWith(
                expect.stringContaining('导出配置失败'),
                'error'
            );
        });
    });

    describe('createFromTemplate', () => {
        it('成功从模板创建', async () => {
            const modal = document.createElement('div');
            generateTemplate.mockReturnValue({ mcpServers: { test: { command: 'npx' } } });
            standardToInternal.mockReturnValue([
                { id: 'srv1', name: 'Template Server', type: 'stdio' }
            ]);

            await createFromTemplate(modal, 'test-template');

            expect(generateTemplate).toHaveBeenCalledWith('test-template');
            expect(saveMCPServer).toHaveBeenCalled();
            expect(renderServerList).toHaveBeenCalledWith(modal);
            expect(showNotification).toHaveBeenCalledWith(
                expect.stringContaining('已从模板创建'),
                'success'
            );
        });

        it('空服务器列表抛错', async () => {
            const modal = document.createElement('div');
            generateTemplate.mockReturnValue({ mcpServers: {} });
            standardToInternal.mockReturnValue([]);

            await createFromTemplate(modal, 'empty-template');

            expect(showNotification).toHaveBeenCalledWith(
                expect.stringContaining('从模板创建失败'),
                'error'
            );
        });

        it('模板生成异常处理', async () => {
            const modal = document.createElement('div');
            generateTemplate.mockImplementation(() => {
                throw new Error('bad template');
            });

            await createFromTemplate(modal, 'bad-id');

            expect(showNotification).toHaveBeenCalledWith(
                expect.stringContaining('从模板创建失败'),
                'error'
            );
        });
    });
});
