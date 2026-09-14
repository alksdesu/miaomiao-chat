import { state } from '../core/state.js';
import { escapeHtml } from '../utils/helpers.js';

const DEFAULT_DISPLAY_NAME = 'AI 助手';

export function getWelcomeName() {
    const name = typeof state.charName === 'string' ? state.charName.trim() : '';
    return name && name !== 'Assistant' ? name : DEFAULT_DISPLAY_NAME;
}

export function createWelcomeMessage() {
    return `<div class="welcome-message">
        <div class="welcome-kicker">
            <span class="welcome-kicker-mark" aria-hidden="true">✦</span>
            <span>WEBCHAT</span>
            <span class="welcome-kicker-line" aria-hidden="true"></span>
            <span class="welcome-kicker-state">READY</span>
        </div>
        <h2>你好，我是 ${escapeHtml(getWelcomeName())}</h2>
        <p>从一个问题开始，慢慢聊。</p>
    </div>`;
}
