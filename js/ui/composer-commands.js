const COMMANDS = [
    {
        name: '总结',
        description: '提炼重点、结论和待办',
        text: '请总结下面的内容，并列出关键结论：\n'
    },
    {
        name: '解释',
        description: '用更容易理解的方式说明',
        text: '请解释下面的内容，面向初学者说明：\n'
    },
    {
        name: '改写',
        description: '调整语气、结构和表达',
        text: '请改写下面的内容，使表达更清晰自然：\n'
    },
    {
        name: '翻译',
        description: '在中英文之间自然翻译',
        text: '请将下面的内容翻译成英文，保留原有语气：\n'
    },
    {
        name: '代码',
        description: '检查、优化或补充代码',
        text: '请分析下面的代码，指出问题并给出改进方案：\n'
    }
];

export function findCommandMatches(query) {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return COMMANDS;
    return COMMANDS.filter(
        (command) =>
            command.name.toLocaleLowerCase().includes(normalizedQuery) ||
            command.description.toLocaleLowerCase().includes(normalizedQuery)
    );
}

function getCommandQuery(value) {
    const match = value.match(/^\/([^\s/]*)$/u);
    return match ? match[1] : null;
}

export function initComposerCommands({ textarea, menu, onResize } = {}) {
    if (!textarea || !menu) return;

    let selectedIndex = 0;
    let matches = [];
    textarea.setAttribute('aria-expanded', 'false');

    const hide = () => {
        menu.hidden = true;
        textarea.setAttribute('aria-expanded', 'false');
        matches = [];
        selectedIndex = 0;
    };

    const select = (command) => {
        textarea.value = command.text;
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
        onResize?.();
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        hide();
    };

    const render = (query) => {
        matches = findCommandMatches(query);
        selectedIndex = Math.min(selectedIndex, Math.max(matches.length - 1, 0));
        menu.replaceChildren();

        matches.forEach((command, index) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'composer-command-item';
            button.setAttribute('role', 'option');
            button.setAttribute('aria-selected', String(index === selectedIndex));

            const name = document.createElement('strong');
            name.textContent = `/${command.name}`;
            const description = document.createElement('span');
            description.textContent = command.description;
            button.append(name, description);
            button.addEventListener('mousedown', (event) => event.preventDefault());
            button.addEventListener('click', () => select(command));
            menu.appendChild(button);
        });

        menu.hidden = matches.length === 0;
        textarea.setAttribute('aria-expanded', String(!menu.hidden));
    };

    textarea.addEventListener('input', () => {
        const query = getCommandQuery(textarea.value.trim());
        if (query === null) {
            hide();
            return;
        }
        render(query);
    });

    textarea.addEventListener('keydown', (event) => {
        if (menu.hidden || matches.length === 0) return;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const direction = event.key === 'ArrowDown' ? 1 : -1;
            selectedIndex = (selectedIndex + direction + matches.length) % matches.length;
            render(getCommandQuery(textarea.value.trim()) || '');
            return;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
            event.preventDefault();
            select(matches[selectedIndex]);
            return;
        }
        if (event.key === 'Escape') {
            event.preventDefault();
            hide();
        }
    });

    textarea.addEventListener('blur', () => {
        window.setTimeout(hide, 120);
    });
}
