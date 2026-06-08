/**
 * media-cards.js 测试
 * 测试渲染函数输出的 HTML 结构
 */
import { describe, it, expect, vi } from 'vitest';

// mock 依赖
vi.mock('../../js/utils/media.js', () => ({
    getMediaExtension: vi.fn((url, mime, fallback) => {
        if (mime) {
            const ext = mime.split('/').pop();
            return ext || fallback;
        }
        return fallback;
    })
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

import {
    renderImageCard,
    renderVideoCard,
    renderAudioCard,
    renderMediaCard,
    renderDownloadIcon
} from '../../js/ui/media-cards.js';

// ========== renderDownloadIcon ==========

describe('renderDownloadIcon', () => {
    it('返回 SVG 字符串', () => {
        const svg = renderDownloadIcon();
        expect(svg).toContain('<svg');
        expect(svg).toContain('</svg>');
        expect(svg).toContain('width="18"');
    });
});

// ========== renderImageCard ==========

describe('renderImageCard', () => {
    it('包含 image-wrapper 容器', () => {
        const html = renderImageCard('https://example.com/img.png');
        expect(html).toContain('class="image-wrapper"');
    });

    it('包含 img 标签', () => {
        const html = renderImageCard('https://example.com/img.png');
        expect(html).toContain('<img');
        expect(html).toContain('src="https://example.com/img.png"');
    });

    it('包含下载按钮（data-action download-media + media-kind image）', () => {
        const html = renderImageCard('https://example.com/img.png');
        expect(html).toContain('class="download-image-btn"');
        expect(html).toContain('data-action="download-media"');
        expect(html).toContain('data-media-kind="image"');
    });

    it('包含点击查看大图功能（data-action open-viewer）', () => {
        const html = renderImageCard('https://example.com/img.png');
        expect(html).toContain('data-action="open-viewer"');
        expect(html).toContain('cursor:pointer');
    });

    it('URL 被 escapeHtml 处理', () => {
        const html = renderImageCard('https://example.com/img.png?a=1&b=2');
        // escapeHtml mock 会转义 &
        expect(html).toContain('&amp;');
    });

    it('不再使用 inline onclick / decodeURIComponent（CSP 收紧后改用 data-action 事件委托）', () => {
        const html = renderImageCard('https://example.com/img.png');
        expect(html).not.toContain('onclick=');
        expect(html).not.toContain('decodeURIComponent');
    });
});

// ========== renderVideoCard ==========

describe('renderVideoCard', () => {
    it('包含 video-wrapper 容器', () => {
        const html = renderVideoCard('https://example.com/vid.mp4');
        expect(html).toContain('video-wrapper');
    });

    it('包含 video 标签', () => {
        const html = renderVideoCard('https://example.com/vid.mp4');
        expect(html).toContain('<video');
        expect(html).toContain('controls');
        expect(html).toContain('playsinline');
        expect(html).toContain('muted');
    });

    it('包含下载按钮（data-action download-media + media-kind video）', () => {
        const html = renderVideoCard('https://example.com/vid.mp4');
        expect(html).toContain('data-action="download-media"');
        expect(html).toContain('data-media-kind="video"');
    });

    it('URL 被正确处理', () => {
        const html = renderVideoCard('https://example.com/vid.mp4');
        expect(html).toContain('src="https://example.com/vid.mp4"');
    });
});

// ========== renderAudioCard ==========

describe('renderAudioCard', () => {
    it('包含 audio-wrapper 容器', () => {
        const html = renderAudioCard('https://example.com/audio.mp3');
        expect(html).toContain('class="audio-wrapper"');
    });

    it('包含 audio 标签', () => {
        const html = renderAudioCard('https://example.com/audio.mp3');
        expect(html).toContain('<audio');
        expect(html).toContain('controls');
        expect(html).toContain('preload="metadata"');
    });

    it('包含下载按钮（data-action download-media + media-kind audio）', () => {
        const html = renderAudioCard('https://example.com/audio.mp3');
        expect(html).toContain('data-action="download-media"');
        expect(html).toContain('data-media-kind="audio"');
    });
});

// ========== renderMediaCard ==========

describe('renderMediaCard', () => {
    it('空 URL 返回空字符串', () => {
        expect(renderMediaCard('', 'image')).toBe('');
        expect(renderMediaCard(null, 'image')).toBe('');
    });

    it('image 类型调用 renderImageCard', () => {
        const html = renderMediaCard('https://img.png', 'image');
        expect(html).toContain('image-wrapper');
        expect(html).toContain('<img');
    });

    it('video 类型调用 renderVideoCard', () => {
        const html = renderMediaCard('https://vid.mp4', 'video');
        expect(html).toContain('video-wrapper');
        expect(html).toContain('<video');
    });

    it('audio 类型调用 renderAudioCard', () => {
        const html = renderMediaCard('https://audio.mp3', 'audio');
        expect(html).toContain('audio-wrapper');
        expect(html).toContain('<audio');
    });

    it('未知类型默认渲染为图片', () => {
        const html = renderMediaCard('https://file.bin', 'unknown');
        expect(html).toContain('<img');
    });

    it('mimeType 参数传递给视频', () => {
        const html = renderMediaCard('https://vid.mp4', 'video', 'video/mp4');
        expect(html).toContain('<video');
    });
});
