import { eventBus } from '../core/events.js';

const LONG_PRESS_DELAY = 550;
const MOVE_THRESHOLD = 12;

const ACTIONS = [
    { id: 'edit', label: '编辑消息' },
    { id: 'quote', label: '引用消息' },
    { id: 'copy', label: '复制全文' },
    { id: 'branch', label: '从此处创建分支' },
    { id: 'delete', label: '删除消息' }
];

let initialized = false;
let pressTimer = null;
let pressStart = null;
let activeMessage = null;
let menu = null;

function clearPress() {
    if (pressTimer) window.clearTimeout(pressTimer);
    pressTimer = null;
    pressStart = null;
}

function closeMenu() {
    menu?.remove();
    menu = null;
    activeMessage = null;
}

function emitAction(actionId) {
    if (!activeMessage) return;
    const eventMap = {
        edit: 'message:edit-requested',
        quote: 'message:quote-requested',
        copy: 'message:copy-requested',
        branch: 'message:branch-requested',
        delete: 'message:delete-requested'
    };
    const event = eventMap[actionId];
    if (event) eventBus.emit(event, { messageEl: activeMessage });
    closeMenu();
}

function openMenu(messageEl) {
    closeMenu();
    activeMessage = messageEl;

    menu = document.createElement('div');
    menu.className = 'message-touch-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', '消息操作');

    const handle = document.createElement('span');
    handle.className = 'message-touch-menu-handle';
    handle.setAttribute('aria-hidden', 'true');
    menu.appendChild(handle);

    ACTIONS.forEach((action) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `message-touch-menu-item ${action.id}-action`;
        button.setAttribute('role', 'menuitem');
        button.textContent = action.label;
        button.addEventListener('click', () => emitAction(action.id));
        menu.appendChild(button);
    });

    document.body.appendChild(menu);
    menu.querySelector('button')?.focus();
}

export function initMessageTouchActions() {
    if (initialized) return;
    const messages = document.getElementById('messages');
    if (!messages) return;
    initialized = true;

    messages.addEventListener('pointerdown', (event) => {
        if (event.pointerType === 'mouse' || event.target.closest('button, a, input, textarea')) {
            return;
        }
        const messageEl = event.target.closest('.message');
        if (!messageEl) return;

        clearPress();
        pressStart = { x: event.clientX, y: event.clientY };
        pressTimer = window.setTimeout(() => {
            pressTimer = null;
            openMenu(messageEl);
        }, LONG_PRESS_DELAY);
    });

    messages.addEventListener('pointermove', (event) => {
        if (!pressStart) return;
        if (
            Math.abs(event.clientX - pressStart.x) > MOVE_THRESHOLD ||
            Math.abs(event.clientY - pressStart.y) > MOVE_THRESHOLD
        ) {
            clearPress();
        }
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach((eventName) => {
        messages.addEventListener(eventName, clearPress);
    });
    document.addEventListener('pointerdown', (event) => {
        if (menu && !menu.contains(event.target)) closeMenu();
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && menu) {
            event.preventDefault();
            closeMenu();
        }
    });
}
