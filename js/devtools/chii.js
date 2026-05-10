/**
 * Chii DevTools — 远程 Chrome DevTools（Web/Android 端使用）
 */

import { isElectron } from '../utils/platform.js';
import { logger } from '../utils/logger.js';

let chiiLoaded = false;
const CHII_CONTAINER = '.__chobitsu-hide__';

async function loadChii() {
    if (chiiLoaded) return;
    let chiiBase = 'libs/chii/';
    if (isElectron() && window.electronAPI?.getChiiPort) {
        try {
            const port = await window.electronAPI.getChiiPort();
            if (port) {
                chiiBase = `http://127.0.0.1:${port}/`;
                window.ChiiServerUrl = chiiBase;
            }
        } catch (e) {
            logger.error('[Chii] getChiiPort failed:', e);
        }
    }
    return new Promise((resolve) => {
        const scriptUrl = chiiBase + 'target.js';
        const script = document.createElement('script');
        script.src = scriptUrl;
        script.setAttribute('embedded', 'true');
        script.onload = () => {
            chiiLoaded = true;
            const container = document.querySelector(CHII_CONTAINER);
            if (container) {
                container.style.display = 'none';
            }
            logger.debug('[Chii] DevTools loaded');
            resolve();
        };
        script.onerror = (error) => {
            logger.error('[Chii] load failed:', error);
            resolve();
        };
        document.head.appendChild(script);
    });
}

export function toggleChii() {
    if (!chiiLoaded) return;
    const container = document.querySelector(CHII_CONTAINER);
    if (!container) return;

    const isVisible = container.style.display !== 'none';
    if (isVisible) {
        container.style.display = 'none';
        document.body.style.marginBottom = '';
        document.body.style.height = '';
        document.documentElement.style.height = '';
        const closeBtn = document.getElementById('chii-close-btn');
        if (closeBtn) closeBtn.remove();
        return;
    }

    const isMobile = window.innerWidth <= 768;
    const panelHeight = isMobile ? '70vh' : '50vh';
    container.style.display = 'block';
    container.style.position = 'fixed';
    container.style.bottom = '0';
    container.style.left = '0';
    container.style.right = '0';
    container.style.zIndex = '99999';
    container.style.height = panelHeight;
    container.style.boxShadow = '0 -2px 16px rgba(0,0,0,0.3)';

    const iframe = container.querySelector('iframe');
    if (iframe) {
        iframe.style.width = '100%';
        iframe.style.height = '100%';
        iframe.style.border = 'none';
    }

    if (!document.getElementById('chii-close-btn')) {
        const btn = document.createElement('button');
        btn.id = 'chii-close-btn';
        btn.textContent = '✕';
        btn.style.cssText =
            'position:fixed;top:calc(100vh - ' +
            panelHeight +
            ' + 4px);right:12px;z-index:100000;' +
            'width:28px;height:28px;border-radius:50%;border:none;' +
            'background:rgba(0,0,0,0.7);color:#fff;font-size:14px;cursor:pointer;' +
            'display:flex;align-items:center;justify-content:center;';
        btn.addEventListener('click', toggleChii);
        document.body.appendChild(btn);
    }
}

export async function showChii() {
    await loadChii();
    toggleChii();
}
