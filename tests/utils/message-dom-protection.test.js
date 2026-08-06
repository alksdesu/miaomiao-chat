// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { isMessageElementInteractionProtected } from '../../js/utils/message-dom-protection.js';

describe('message-dom-protection', () => {
    afterEach(() => {
        document.body.replaceChildren();
        window.getSelection()?.removeAllRanges();
    });

    it('查看器打开期间保护媒体来源消息', () => {
        document.body.innerHTML = `
            <div class="message"><img data-src="blob:stored-media"></div>
            <div id="image-viewer-modal" class="open"><img id="image-viewer-img" src="blob:stored-media"></div>
        `;

        expect(isMessageElementInteractionProtected(document.querySelector('.message'))).toBe(true);
    });

    it('查看器关闭后允许回收消息', () => {
        document.body.innerHTML = `
            <div class="message"><img data-src="blob:stored-media"></div>
            <div id="image-viewer-modal"><img id="image-viewer-img" src="blob:stored-media"></div>
        `;

        expect(isMessageElementInteractionProtected(document.querySelector('.message'))).toBe(
            false
        );
    });

    it('只保护实际文本选区，不因折叠光标长期固定消息', () => {
        const message = document.createElement('div');
        message.className = 'message';
        message.textContent = 'selectable text';
        document.body.appendChild(message);
        const selection = window.getSelection();
        const range = document.createRange();
        range.setStart(message.firstChild, 0);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);

        expect(isMessageElementInteractionProtected(message)).toBe(false);

        range.setEnd(message.firstChild, 5);
        selection.removeAllRanges();
        selection.addRange(range);
        expect(isMessageElementInteractionProtected(message)).toBe(true);
    });
});
