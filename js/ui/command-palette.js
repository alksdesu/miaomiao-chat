const COMMANDS = [
    {
        id: 'focus-input',
        label: '聚焦输入框',
        description: '立即开始输入消息',
        shortcut: '⌘ Enter'
    },
    { id: 'new-session', label: '新建会话', description: '创建一个空白会话', shortcut: '⌘ N' },
    { id: 'toggle-sidebar', label: '切换会话列表', description: '打开或收起侧边栏' },
    { id: 'toggle-settings', label: '打开设置', description: '查看模型和请求参数' },
    { id: 'open-providers', label: '管理提供商', description: '配置 API 地址和密钥' },
    { id: 'open-tools', label: '管理工具', description: '查看工具权限和执行历史' },
    { id: 'open-mcp', label: '管理 MCP', description: '连接 MCP 服务器' },
    { id: 'toggle-theme', label: '切换主题', description: '在亮色和暗色主题间切换' },
    { id: 'clear-chat', label: '清空当前会话', description: '删除当前会话中的消息' }
];

const TARGETS = {
    'new-session': 'new-session-btn',
    'toggle-sidebar': 'sidebar-toggle',
    'toggle-settings': 'settings-toggle',
    'open-providers': 'providers-toggle',
    'open-tools': 'tools-manager-toggle',
    'open-mcp': 'mcp-settings-toggle',
    'toggle-theme': 'theme-toggle',
    'clear-chat': 'clear-chat'
};

export function findPaletteCommands(query = '') {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return COMMANDS;
    return COMMANDS.filter((command) =>
        `${command.label} ${command.description}`.toLocaleLowerCase().includes(normalized)
    );
}

function createPalette() {
    const backdrop = document.createElement('div');
    backdrop.className = 'command-palette-backdrop';
    backdrop.id = 'command-palette';
    backdrop.hidden = true;
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');
    backdrop.setAttribute('aria-labelledby', 'command-palette-title');

    const panel = document.createElement('div');
    panel.className = 'command-palette-panel';

    const heading = document.createElement('div');
    heading.className = 'command-palette-heading';
    const title = document.createElement('strong');
    title.id = 'command-palette-title';
    title.textContent = '命令菜单';
    const hint = document.createElement('span');
    hint.textContent = 'Esc 关闭';
    heading.append(title, hint);

    const search = document.createElement('input');
    search.id = 'command-palette-search';
    search.type = 'search';
    search.placeholder = '搜索操作...';
    search.setAttribute('aria-label', '搜索命令');
    search.autocomplete = 'off';

    const list = document.createElement('div');
    list.id = 'command-palette-list';
    list.className = 'command-palette-list';
    list.setAttribute('role', 'listbox');

    panel.append(heading, search, list);
    backdrop.appendChild(panel);
    document.body.appendChild(backdrop);
    return { backdrop, search, list };
}

export function initCommandPalette() {
    const toggle = document.getElementById('command-palette-toggle');
    if (!toggle) return;

    const { backdrop, search, list } = createPalette();
    let matches = COMMANDS;
    let selectedIndex = 0;

    const close = () => {
        backdrop.hidden = true;
        toggle.setAttribute('aria-expanded', 'false');
    };

    const execute = (command) => {
        close();
        if (command.id === 'focus-input') {
            document.getElementById('user-input')?.focus();
            return;
        }
        document.getElementById(TARGETS[command.id])?.click();
    };

    const render = () => {
        list.replaceChildren();
        if (matches.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'command-palette-empty';
            empty.textContent = '没有匹配命令';
            list.appendChild(empty);
            return;
        }
        matches.forEach((command, index) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'command-palette-item';
            button.setAttribute('role', 'option');
            button.setAttribute('aria-selected', String(index === selectedIndex));

            const copy = document.createElement('span');
            copy.className = 'command-palette-item-copy';
            const label = document.createElement('strong');
            label.textContent = command.label;
            const description = document.createElement('small');
            description.textContent = command.description;
            copy.append(label, description);

            button.appendChild(copy);
            if (command.shortcut) {
                const shortcut = document.createElement('kbd');
                shortcut.textContent = command.shortcut;
                button.appendChild(shortcut);
            }
            button.addEventListener('click', () => execute(command));
            list.appendChild(button);
        });
    };

    const open = () => {
        backdrop.hidden = false;
        toggle.setAttribute('aria-expanded', 'true');
        search.value = '';
        matches = COMMANDS;
        selectedIndex = 0;
        render();
        search.focus();
    };

    toggle.addEventListener('click', open);
    backdrop.addEventListener('click', (event) => {
        if (event.target === backdrop) close();
    });
    search.addEventListener('input', () => {
        matches = findPaletteCommands(search.value);
        selectedIndex = 0;
        render();
    });
    search.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (matches.length === 0) return;
            const direction = event.key === 'ArrowDown' ? 1 : -1;
            selectedIndex = (selectedIndex + direction + matches.length) % matches.length;
            render();
        } else if ((event.key === 'Enter' || event.key === 'Tab') && matches[selectedIndex]) {
            event.preventDefault();
            execute(matches[selectedIndex]);
        } else if (event.key === 'Escape') {
            event.preventDefault();
            close();
        }
    });
    document.addEventListener('keydown', (event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
            event.preventDefault();
            if (backdrop.hidden) open();
            else close();
        } else if (event.key === 'Escape' && !backdrop.hidden) {
            close();
        }
    });
}
