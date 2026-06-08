/**
 * sidebar.js 测试
 * 侧边栏：toggleSidebar, updateBackgroundTasksIndicator, updateSessionList, cleanup
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../js/core/state.js', () => ({
    state: {
        sessions: [],
        currentSessionId: 'session-1',
        backgroundTasks: new Map(),
        messages: [],
        storageMode: 'indexedDB',
        isSwitchingSession: false,
        folders: [],
        activeFolderId: null,
        folderViewMode: 'flat'
    },
    elements: {
        sidebar: null,
        sidebarToggle: null,
        sessionList: null,
        newSessionBtn: null,
        closeSidebar: null,
        backgroundTasksIndicator: null
    }
}));

vi.mock('../../js/core/events.js', () => {
    const handlers = {};
    return {
        eventBus: {
            on: vi.fn((event, handler) => {
                handlers[event] = handler;
                return () => {
                    delete handlers[event];
                };
            }),
            emit: vi.fn(),
            _handlers: handlers
        }
    };
});

vi.mock('../../js/state/sessions.js', () => ({
    switchToSession: vi.fn(),
    deleteSession: vi.fn(),
    renameSession: vi.fn(),
    createNewSession: vi.fn()
}));

vi.mock('../../js/utils/helpers.js', () => ({
    escapeHtml: vi.fn((text) =>
        String(text || '')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
    )
}));

vi.mock('../../js/ui/session-search.js', () => ({
    getSessionSearchState: vi.fn(() => ({ query: '', isActive: false, results: [] })),
    highlightMatch: vi.fn((text) => text)
}));

vi.mock('../../js/state/export-import.js', () => ({
    sessionToMarkdown: vi.fn(() => '# Markdown')
}));

vi.mock('../../js/utils/icons.js', () => ({
    getIcon: vi.fn((name) => `<svg class="icon-${name}"></svg>`)
}));

vi.mock('../../js/ui/notifications.js', () => ({
    showNotification: vi.fn()
}));

vi.mock('../../js/ui/message-location.js', () => ({
    locateMessageByReference: vi.fn()
}));

vi.mock('../../js/state/storage.js', () => ({
    savePreference: vi.fn(),
    loadSessionMessages: vi.fn()
}));

vi.mock('../../js/utils/dialogs.js', () => ({
    showInputDialog: vi.fn(),
    showConfirmDialog: vi.fn()
}));

import { state, elements } from '../../js/core/state.js';
import {
    toggleSidebar,
    updateBackgroundTasksIndicator,
    updateSessionList,
    cleanupSidebar
} from '../../js/ui/sidebar.js';

beforeEach(() => {
    vi.clearAllMocks();
    state.sessions = [];
    state.currentSessionId = 'session-1';
    state.backgroundTasks = new Map();

    elements.sidebar = document.createElement('div');
    elements.sidebarToggle = document.createElement('button');
    elements.sidebarToggle.focus = vi.fn();
    elements.sessionList = document.createElement('div');
    elements.backgroundTasksIndicator = document.createElement('div');
    elements.newSessionBtn = document.createElement('button');
    elements.closeSidebar = document.createElement('button');
});

describe('toggleSidebar', () => {
    it('切换 open class', async () => {
        await toggleSidebar(true);
        expect(elements.sidebar.classList.contains('open')).toBe(true);

        await toggleSidebar(true);
        expect(elements.sidebar.classList.contains('open')).toBe(false);
    });

    it('sidebar 为 null 时不报错', async () => {
        elements.sidebar = null;
        await expect(toggleSidebar()).resolves.toBeUndefined();
    });

    it('设置 inert 属性', async () => {
        const appContainer = document.createElement('div');
        appContainer.className = 'app-container';
        document.body.appendChild(appContainer);

        await toggleSidebar(true);
        expect(appContainer.getAttribute('inert')).toBe('');

        await toggleSidebar(true);
        expect(appContainer.hasAttribute('inert')).toBe(false);

        document.body.removeChild(appContainer);
    });
});

describe('updateBackgroundTasksIndicator', () => {
    it('无后台任务时隐藏指示器', () => {
        state.backgroundTasks = new Map();
        updateBackgroundTasksIndicator();
        expect(elements.backgroundTasksIndicator.style.display).toBe('none');
    });

    it('有后台任务时显示', () => {
        state.backgroundTasks = new Map([['task-1', {}]]);
        updateBackgroundTasksIndicator();
        expect(elements.backgroundTasksIndicator.style.display).toBe('flex');
        expect(elements.backgroundTasksIndicator.textContent).toContain('1');
    });

    it('多个任务显示正确数量', () => {
        state.backgroundTasks = new Map([
            ['task-1', {}],
            ['task-2', {}],
            ['task-3', {}]
        ]);
        updateBackgroundTasksIndicator();
        expect(elements.backgroundTasksIndicator.textContent).toContain('3');
    });

    it('指示器为 null 时不报错', () => {
        elements.backgroundTasksIndicator = null;
        expect(() => updateBackgroundTasksIndicator()).not.toThrow();
    });
});

describe('updateSessionList', () => {
    it('无会话时显示空提示', () => {
        state.sessions = [];
        updateSessionList();
        expect(elements.sessionList.innerHTML).toContain('还没有会话');
    });

    it('有会话时渲染会话项', () => {
        state.sessions = [
            { id: 'session-1', name: '测试会话' },
            { id: 'session-2', name: '第二个会话' }
        ];
        updateSessionList();
        const items = elements.sessionList.querySelectorAll('.session-item');
        expect(items.length).toBe(2);
    });

    it('当前会话添加 active class', () => {
        state.sessions = [{ id: 'session-1', name: '测试' }];
        state.currentSessionId = 'session-1';
        updateSessionList();
        const item = elements.sessionList.querySelector('.session-item');
        expect(item.classList.contains('active')).toBe(true);
    });

    it('sessionList 为 null 时不报错', () => {
        elements.sessionList = null;
        expect(() => updateSessionList()).not.toThrow();
    });

    it('包含重命名和删除按钮', () => {
        state.sessions = [{ id: 'session-1', name: '测试' }];
        updateSessionList();
        expect(elements.sessionList.querySelector('.rename-session-btn')).not.toBeNull();
        expect(elements.sessionList.querySelector('.delete-session-btn')).not.toBeNull();
    });

    it('包含导出按钮', () => {
        state.sessions = [{ id: 'session-1', name: '测试' }];
        updateSessionList();
        expect(elements.sessionList.querySelector('.export-session-btn')).not.toBeNull();
    });
});

describe('cleanupSidebar', () => {
    it('清理后不报错', () => {
        expect(() => cleanupSidebar()).not.toThrow();
    });
});
