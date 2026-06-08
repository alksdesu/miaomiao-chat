// @vitest-environment jsdom
/**
 * media-cards.js jsdom DOM 集成测试
 * 在 jsdom 环境下验证生成的 HTML 能被正确解析为 DOM 树
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// mock 依赖
vi.mock('../../js/utils/media.js', () => ({
    getMediaExtension: vi.fn((_url, mime, fallback) => {
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

describe('media-cards DOM 集成 (jsdom)', () => {
    let container;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
    });

    // ========== renderDownloadIcon ==========

    describe('renderDownloadIcon DOM', () => {
        it('生成有效的 SVG DOM 节点', () => {
            container.innerHTML = renderDownloadIcon();
            const svg = container.querySelector('svg');
            expect(svg).not.toBeNull();
            expect(svg.getAttribute('width')).toBe('18');
            expect(svg.getAttribute('height')).toBe('18');
        });

        it('SVG 包含 path 子元素', () => {
            container.innerHTML = renderDownloadIcon();
            const paths = container.querySelectorAll('svg path');
            expect(paths.length).toBeGreaterThan(0);
        });
    });

    // ========== renderImageCard DOM ==========

    describe('renderImageCard DOM', () => {
        it('创建 image-wrapper 容器', () => {
            container.innerHTML = renderImageCard('https://img.com/photo.png');
            expect(container.querySelector('.image-wrapper')).not.toBeNull();
        });

        it('创建 img 元素带正确 src', () => {
            container.innerHTML = renderImageCard('https://img.com/photo.png');
            const img = container.querySelector('img');
            expect(img).not.toBeNull();
            expect(img.getAttribute('src')).toBe('https://img.com/photo.png');
        });

        it('img 有 alt 属性', () => {
            container.innerHTML = renderImageCard('https://img.com/photo.png');
            const img = container.querySelector('img');
            expect(img.getAttribute('alt')).toBe('Generated image');
        });

        it('img 有 cursor:pointer 样式', () => {
            container.innerHTML = renderImageCard('https://img.com/photo.png');
            const img = container.querySelector('img');
            expect(img.style.cursor).toBe('pointer');
        });

        it('下载按钮是 button 元素', () => {
            container.innerHTML = renderImageCard('https://img.com/photo.png');
            const btn = container.querySelector('button.download-image-btn');
            expect(btn).not.toBeNull();
            expect(btn.getAttribute('type')).toBe('button');
        });

        it('下载按钮内含 SVG 图标', () => {
            container.innerHTML = renderImageCard('https://img.com/photo.png');
            const svg = container.querySelector('.download-image-btn svg');
            expect(svg).not.toBeNull();
        });

        it('带特殊字符的 URL 被正确转义', () => {
            container.innerHTML = renderImageCard('https://img.com/photo.png?w=100&h=200');
            const img = container.querySelector('img');
            // escapeHtml 会转义 & 为 &amp;，但浏览器解析后 src 属性中仍是 &
            expect(img.getAttribute('src')).toContain('&');
        });
    });

    // ========== renderVideoCard DOM ==========

    describe('renderVideoCard DOM', () => {
        it('创建 video-wrapper 容器', () => {
            container.innerHTML = renderVideoCard('https://vid.com/clip.mp4');
            expect(container.querySelector('.video-wrapper')).not.toBeNull();
        });

        it('创建 video 元素带正确 src', () => {
            container.innerHTML = renderVideoCard('https://vid.com/clip.mp4');
            const video = container.querySelector('video');
            expect(video).not.toBeNull();
            expect(video.getAttribute('src')).toBe('https://vid.com/clip.mp4');
        });

        it('video 有 controls 属性', () => {
            container.innerHTML = renderVideoCard('https://vid.com/clip.mp4');
            const video = container.querySelector('video');
            expect(video.hasAttribute('controls')).toBe(true);
        });

        it('video 有 playsinline 和 muted 属性', () => {
            container.innerHTML = renderVideoCard('https://vid.com/clip.mp4');
            const video = container.querySelector('video');
            expect(video.hasAttribute('playsinline')).toBe(true);
            expect(video.hasAttribute('muted')).toBe(true);
        });

        it('video 有 preload=metadata', () => {
            container.innerHTML = renderVideoCard('https://vid.com/clip.mp4');
            const video = container.querySelector('video');
            expect(video.getAttribute('preload')).toBe('metadata');
        });

        it('包含下载按钮', () => {
            container.innerHTML = renderVideoCard('https://vid.com/clip.mp4');
            const btn = container.querySelector('.download-image-btn');
            expect(btn).not.toBeNull();
        });
    });

    // ========== renderAudioCard DOM ==========

    describe('renderAudioCard DOM', () => {
        it('创建 audio-wrapper 容器', () => {
            container.innerHTML = renderAudioCard('https://audio.com/song.mp3');
            expect(container.querySelector('.audio-wrapper')).not.toBeNull();
        });

        it('创建 audio 元素带正确 src', () => {
            container.innerHTML = renderAudioCard('https://audio.com/song.mp3');
            const audio = container.querySelector('audio');
            expect(audio).not.toBeNull();
            expect(audio.getAttribute('src')).toBe('https://audio.com/song.mp3');
        });

        it('audio 有 controls 属性', () => {
            container.innerHTML = renderAudioCard('https://audio.com/song.mp3');
            const audio = container.querySelector('audio');
            expect(audio.hasAttribute('controls')).toBe(true);
        });

        it('包含下载按钮', () => {
            container.innerHTML = renderAudioCard('https://audio.com/song.mp3');
            const btn = container.querySelector('.download-image-btn');
            expect(btn).not.toBeNull();
        });
    });

    // ========== renderMediaCard DOM 路由 ==========

    describe('renderMediaCard DOM 路由', () => {
        it('image 类型生成 img 元素', () => {
            container.innerHTML = renderMediaCard('https://img.png', 'image');
            expect(container.querySelector('img')).not.toBeNull();
        });

        it('video 类型生成 video 元素', () => {
            container.innerHTML = renderMediaCard('https://vid.mp4', 'video');
            expect(container.querySelector('video')).not.toBeNull();
        });

        it('audio 类型生成 audio 元素', () => {
            container.innerHTML = renderMediaCard('https://audio.mp3', 'audio');
            expect(container.querySelector('audio')).not.toBeNull();
        });

        it('空 URL 不生成任何 DOM', () => {
            container.innerHTML = renderMediaCard('', 'image');
            expect(container.children.length).toBe(0);
        });

        it('未知类型默认生成 img 元素', () => {
            container.innerHTML = renderMediaCard('https://file.dat', 'unknown');
            expect(container.querySelector('img')).not.toBeNull();
        });
    });

    // ========== 下载按钮通用 ==========

    describe('下载按钮行为', () => {
        it('图片下载按钮有 title', () => {
            container.innerHTML = renderImageCard('https://img.png');
            const btn = container.querySelector('.download-image-btn');
            expect(btn.getAttribute('title')).toBeTruthy();
        });

        it('视频下载按钮有 title', () => {
            container.innerHTML = renderVideoCard('https://vid.mp4');
            const btn = container.querySelector('.download-image-btn');
            expect(btn.getAttribute('title')).toBeTruthy();
        });

        it('音频下载按钮有 title', () => {
            container.innerHTML = renderAudioCard('https://audio.mp3');
            const btn = container.querySelector('.download-image-btn');
            expect(btn.getAttribute('title')).toBeTruthy();
        });
    });
});
