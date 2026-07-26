// @vitest-environment jsdom
/**
 * sidebar.js jsdom 测试
 * 测试侧边栏的 DOM 交互、焦点陷阱、overlay 控制
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// mock 所有外部依赖
vi.mock('../../js/core/state.js', () => ({
    state: {
        sessions: [],
        currentSessionId: 'session-1',
        messages: [],
        backgroundTasks: new Map(),
        storageMode: 'localStorage',
        isSwitchingSession: false,
        folders: [],
        activeFolderId: null,
        folderViewMode: 'flat'
    },
    elements: {
        sidebar: null,
        sidebarToggle: null,
        newSessionBtn: null,
        closeSidebar: null,
        sessionList: null,
        backgroundTasksIndicator: null
    }
}));

vi.mock('../../js/core/events.js', () => {
    const handlers = new Map();
    return {
        eventBus: {
            on: vi.fn((event, cb) => {
                if (!handlers.has(event)) handlers.set(event, new Set());
                handlers.get(event).add(cb);
                return () => handlers.get(event)?.delete(cb);
            }),
            emit: vi.fn((event, data) => {
                handlers.get(event)?.forEach((cb) => cb(data));
            }),
            off: vi.fn()
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
    escapeHtml: vi.fn((text) => {
        if (text == null) return '';
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    })
}));

vi.mock('../../js/ui/session-search.js', () => ({
    getSessionSearchState: vi.fn(() => ({
        query: '',
        isActive: false,
        results: []
    })),
    highlightMatch: vi.fn((text) => text)
}));

vi.mock('../../js/state/export-import.js', () => ({
    sessionToMarkdown: vi.fn(() => '# markdown')
}));

vi.mock('../../js/utils/icons.js', () => ({
    getIcon: vi.fn((name) => `<svg data-icon="${name}"></svg>`)
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
    updateSessionList,
    updateBackgroundTasksIndicator,
    initSidebar,
    cleanupSidebar
} from '../../js/ui/sidebar.js';

describe('toggleSidebar (jsdom)', () => {
    beforeEach(() => {
        document.body.innerHTML = `
            <div class="sidebar" id="sidebar">
                <button id="close-sidebar">close</button>
            </div>
            <div class="sidebar-overlay"></div>
            <div class="app-container">main content</div>
            <button id="sidebar-toggle">toggle</button>
        `;
        elements.sidebar = document.getElementById('sidebar');
        elements.sidebarToggle = document.getElementById('sidebar-toggle');
        elements.closeSidebar = document.getElementById('close-sidebar');
    });

    afterEach(async () => {
        // inert 引用计数是模块级状态，必须成对释放避免跨用例泄漏
        if (elements.sidebar?.classList.contains('open')) {
            await toggleSidebar(true);
        }
        document.body.innerHTML = '';
        elements.sidebar = null;
        elements.sidebarToggle = null;
        elements.closeSidebar = null;
    });

    it('切换侧边栏 open 类', async () => {
        await toggleSidebar();
        expect(elements.sidebar.classList.contains('open')).toBe(true);

        await toggleSidebar();
        expect(elements.sidebar.classList.contains('open')).toBe(false);
    });

    it('打开时 overlay 可见', async () => {
        await toggleSidebar();
        const overlay = document.querySelector('.sidebar-overlay');
        expect(overlay.style.visibility).toBe('visible');
        expect(overlay.style.opacity).toBe('1');
        expect(overlay.style.pointerEvents).toBe('auto');
    });

    it('关闭时 overlay 隐藏', async () => {
        await toggleSidebar(); // 打开
        await toggleSidebar(); // 关闭
        const overlay = document.querySelector('.sidebar-overlay');
        expect(overlay.style.visibility).toBe('hidden');
        expect(overlay.style.opacity).toBe('0');
        expect(overlay.style.pointerEvents).toBe('none');
    });

    it('打开时设置 app-container inert', async () => {
        await toggleSidebar();
        const app = document.querySelector('.app-container');
        expect(app.hasAttribute('inert')).toBe(true);
    });

    it('关闭时移除 app-container inert', async () => {
        await toggleSidebar(); // 打开
        await toggleSidebar(); // 关闭
        const app = document.querySelector('.app-container');
        expect(app.hasAttribute('inert')).toBe(false);
    });

    it('sidebar 为 null 时不报错', async () => {
        elements.sidebar = null;
        await expect(toggleSidebar()).resolves.toBeUndefined();
    });

    it('skipSave=true 不保存状态', async () => {
        const { savePreference } = await import('../../js/state/storage.js');
        await toggleSidebar(true);
        expect(savePreference).not.toHaveBeenCalled();
    });
});

describe('updateBackgroundTasksIndicator (jsdom)', () => {
    beforeEach(() => {
        document.body.innerHTML = '<div id="bg-tasks"></div>';
        elements.backgroundTasksIndicator = document.getElementById('bg-tasks');
    });

    afterEach(() => {
        document.body.innerHTML = '';
        elements.backgroundTasksIndicator = null;
    });

    it('有后台任务时显示数量', () => {
        state.backgroundTasks = new Map([
            ['s1', true],
            ['s2', true]
        ]);
        updateBackgroundTasksIndicator();
        expect(elements.backgroundTasksIndicator.style.display).toBe('flex');
        expect(elements.backgroundTasksIndicator.textContent).toContain('2');
    });

    it('无后台任务时隐藏', () => {
        state.backgroundTasks = new Map();
        updateBackgroundTasksIndicator();
        expect(elements.backgroundTasksIndicator.style.display).toBe('none');
    });

    it('元素为 null 时不报错', () => {
        elements.backgroundTasksIndicator = null;
        state.backgroundTasks = new Map([['s1', true]]);
        expect(() => updateBackgroundTasksIndicator()).not.toThrow();
    });
});

describe('updateSessionList (jsdom)', () => {
    beforeEach(() => {
        document.body.innerHTML = '<div id="session-list"></div>';
        elements.sessionList = document.getElementById('session-list');
        state.sessions = [];
        state.currentSessionId = 'session-1';
        state.backgroundTasks = new Map();
    });

    afterEach(() => {
        document.body.innerHTML = '';
        elements.sessionList = null;
    });

    it('空会话列表显示占位提示', () => {
        state.sessions = [];
        updateSessionList();
        expect(elements.sessionList.querySelector('.session-list-empty')).not.toBeNull();
        expect(elements.sessionList.textContent).toContain('还没有会话');
    });

    it('有会话时渲染 session-item', () => {
        state.sessions = [
            { id: 'session-1', name: '会话一' },
            { id: 'session-2', name: '会话二' }
        ];
        updateSessionList();
        const items = elements.sessionList.querySelectorAll('.session-item');
        expect(items.length).toBe(2);
    });

    it('当前会话标记 active 类', () => {
        state.currentSessionId = 'session-1';
        state.sessions = [
            { id: 'session-1', name: '会话一' },
            { id: 'session-2', name: '会话二' }
        ];
        updateSessionList();
        const items = elements.sessionList.querySelectorAll('.session-item');
        expect(items[0].classList.contains('active')).toBe(true);
        expect(items[1].classList.contains('active')).toBe(false);
    });

    it('session-item 有正确的 data-session-id', () => {
        state.sessions = [{ id: 'abc-123', name: '测试' }];
        updateSessionList();
        const item = elements.sessionList.querySelector('.session-item');
        expect(item.dataset.sessionId).toBe('abc-123');
    });

    it('session-item 有 role=button 和 tabindex', () => {
        state.sessions = [{ id: 's1', name: '测试' }];
        updateSessionList();
        const item = elements.sessionList.querySelector('.session-item');
        expect(item.getAttribute('role')).toBe('button');
        expect(item.getAttribute('tabindex')).toBe('0');
    });

    it('session-item 有 aria-label', () => {
        state.sessions = [{ id: 's1', name: '我的会话' }];
        updateSessionList();
        const item = elements.sessionList.querySelector('.session-item');
        expect(item.getAttribute('aria-label')).toContain('我的会话');
    });

    it('session-item 包含操作按钮', () => {
        state.sessions = [{ id: 's1', name: '测试' }];
        updateSessionList();
        expect(elements.sessionList.querySelector('.rename-session-btn')).not.toBeNull();
        expect(elements.sessionList.querySelector('.delete-session-btn')).not.toBeNull();
        expect(elements.sessionList.querySelector('.export-session-btn')).not.toBeNull();
    });

    it('sessionList 为 null 时不报错', () => {
        elements.sessionList = null;
        state.sessions = [{ id: 's1', name: '测试' }];
        expect(() => updateSessionList()).not.toThrow();
    });

    it('后台任务会话显示生成中标记', () => {
        state.sessions = [{ id: 'bg-1', name: '后台任务' }];
        state.backgroundTasks = new Map([['bg-1', true]]);
        updateSessionList();
        expect(elements.sessionList.querySelector('.session-generating')).not.toBeNull();
        expect(elements.sessionList.textContent).toContain('生成中');
    });
});

describe('initSidebar / cleanupSidebar (jsdom)', () => {
    beforeEach(() => {
        document.body.innerHTML = `
            <div class="sidebar" id="sidebar">
                <button id="close-sidebar">close</button>
            </div>
            <div class="sidebar-overlay"></div>
            <div class="app-container">main</div>
            <button id="sidebar-toggle">toggle</button>
            <button id="new-session-btn">new</button>
            <div id="session-list"></div>
        `;
        elements.sidebar = document.getElementById('sidebar');
        elements.sidebarToggle = document.getElementById('sidebar-toggle');
        elements.closeSidebar = document.getElementById('close-sidebar');
        elements.newSessionBtn = document.getElementById('new-session-btn');
        elements.sessionList = document.getElementById('session-list');
        state.sessions = [];
        state.backgroundTasks = new Map();
    });

    afterEach(() => {
        cleanupSidebar();
        document.body.innerHTML = '';
        Object.keys(elements).forEach((k) => {
            elements[k] = null;
        });
    });

    it('initSidebar 初始化 overlay 样式', async () => {
        await initSidebar();
        const overlay = document.querySelector('.sidebar-overlay');
        expect(overlay.style.visibility).toBe('hidden');
        expect(overlay.style.opacity).toBe('0');
    });

    it('cleanupSidebar 后可重新初始化', async () => {
        await initSidebar();
        cleanupSidebar();
        // 不应抛出
        await expect(initSidebar()).resolves.not.toThrow();
        cleanupSidebar();
    });

    it('重复初始化被忽略', async () => {
        const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        await initSidebar();
        await initSidebar(); // 第二次应该 warn
        expect(spy).toHaveBeenCalledWith('[WARN]', 'Sidebar already initialized');
        spy.mockRestore();
        cleanupSidebar();
    });
});
