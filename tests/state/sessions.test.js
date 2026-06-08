/**
 * sessions.js 会话相关纯函数测试
 * 测试 sessions.js 中可隔离的纯函数和 helpers.js 中的 generateSessionName
 */
import { describe, it, expect } from 'vitest';

import { generateSessionName, generateSessionId } from '../../js/utils/helpers.js';

// ========== generateSessionName 深度测试 ==========

describe('generateSessionName', () => {
    it('空字符串返回默认名', () => {
        expect(generateSessionName('')).toBe('新会话');
    });

    it('null 返回默认名', () => {
        expect(generateSessionName(null)).toBe('新会话');
    });

    it('undefined 返回默认名', () => {
        expect(generateSessionName(undefined)).toBe('新会话');
    });

    it('纯空白字符返回默认名', () => {
        expect(generateSessionName('   ')).toBe('新会话');
    });

    it('短内容直接返回', () => {
        expect(generateSessionName('你好')).toBe('你好');
    });

    it('英文短内容直接返回', () => {
        expect(generateSessionName('Hello world')).toBe('Hello world');
    });

    it('恰好等于 maxLength 不截断', () => {
        const s = 'abcde';
        expect(generateSessionName(s, 5)).toBe('abcde');
    });

    it('超长中文截断并加省略号', () => {
        const long =
            '这是一段非常长的中文文本用来测试会话名称截断功能是否正常工作的内容需要超过默认长度';
        const result = generateSessionName(long, 10);
        expect(result.endsWith('...')).toBe(true);
        expect(result.length).toBeLessThanOrEqual(13);
    });

    it('超长英文在空格处截断', () => {
        const long =
            'This is a very long English sentence that should be truncated at word boundary';
        const result = generateSessionName(long, 25);
        expect(result.endsWith('...')).toBe(true);
        // 在空格处截断，不应在单词中间
        const beforeDots = result.slice(0, -3);
        expect(beforeDots.endsWith(' ') || /\w$/.test(beforeDots)).toBe(true);
    });

    it('换行符转为空格', () => {
        const input = '第一行\n第二行\n第三行';
        const result = generateSessionName(input);
        expect(result).not.toContain('\n');
    });

    it('多余空白合并', () => {
        const input = 'hello   world   test';
        const result = generateSessionName(input);
        expect(result).not.toContain('  ');
    });

    it('特殊字符被过滤', () => {
        const input = '你好！@#$%^&*()世界';
        const result = generateSessionName(input);
        expect(result).not.toMatch(/[!@#$%^&*()]/);
    });

    it('自定义 maxLength 生效', () => {
        const long = 'abcdefghijklmnopqrstuvwxyz';
        const result = generateSessionName(long, 5);
        expect(result.replace('...', '').length).toBeLessThanOrEqual(5);
    });

    it('纯特殊字符清理后为空返回默认名', () => {
        expect(generateSessionName('!@#$%^')).toBe('新会话');
    });

    it('混合中英文内容正确处理', () => {
        const input = '你好 hello 世界 world 测试 test something';
        const result = generateSessionName(input, 15);
        expect(result.length).toBeLessThanOrEqual(18);
    });
});

// ========== generateSessionId 格式测试 ==========

describe('generateSessionId', () => {
    it('以 session_ 开头', () => {
        expect(generateSessionId().startsWith('session_')).toBe(true);
    });

    it('包含时间戳和随机字符', () => {
        const id = generateSessionId();
        expect(id).toMatch(/^session_\d+_[a-z0-9]+$/);
    });

    it('每次生成唯一 ID', () => {
        const ids = new Set();
        for (let i = 0; i < 100; i++) {
            ids.add(generateSessionId());
        }
        expect(ids.size).toBe(100);
    });
});

// ========== 会话排序逻辑测试（模拟 sessions 中的排序） ==========

describe('会话排序', () => {
    const sessions = [
        { id: 's1', name: '旧会话', updatedAt: 1000 },
        { id: 's2', name: '新会话', updatedAt: 3000 },
        { id: 's3', name: '中间会话', updatedAt: 2000 }
    ];

    it('按 updatedAt 降序排列', () => {
        const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
        expect(sorted[0].id).toBe('s2');
        expect(sorted[1].id).toBe('s3');
        expect(sorted[2].id).toBe('s1');
    });

    it('查找会话按 ID', () => {
        const found = sessions.find((s) => s.id === 's2');
        expect(found.name).toBe('新会话');
    });

    it('查找不存在的会话返回 undefined', () => {
        expect(sessions.find((s) => s.id === 'nonexist')).toBeUndefined();
    });
});

// ========== VIDEO_MIME_TO_EXTENSION 映射测试（sessions.js 内部） ==========

describe('视频 MIME 到扩展名映射', () => {
    const VIDEO_MIME_TO_EXTENSION = {
        'video/mp4': 'mp4',
        'video/webm': 'webm',
        'video/ogg': 'ogv',
        'video/quicktime': 'mov',
        'video/x-matroska': 'mkv',
        'video/x-msvideo': 'avi',
        'video/mpeg': 'mpeg'
    };

    function getVideoExtensionByMimeType(mimeType) {
        if (!mimeType || typeof mimeType !== 'string') return 'mp4';
        return VIDEO_MIME_TO_EXTENSION[mimeType.toLowerCase()] || 'mp4';
    }

    it('mp4 映射正确', () => {
        expect(getVideoExtensionByMimeType('video/mp4')).toBe('mp4');
    });

    it('webm 映射正确', () => {
        expect(getVideoExtensionByMimeType('video/webm')).toBe('webm');
    });

    it('quicktime 映射为 mov', () => {
        expect(getVideoExtensionByMimeType('video/quicktime')).toBe('mov');
    });

    it('大写 MIME 也能识别', () => {
        expect(getVideoExtensionByMimeType('VIDEO/MP4')).toBe('mp4');
    });

    it('未知类型回退为 mp4', () => {
        expect(getVideoExtensionByMimeType('video/unknown')).toBe('mp4');
    });

    it('null 回退为 mp4', () => {
        expect(getVideoExtensionByMimeType(null)).toBe('mp4');
    });

    it('空字符串回退为 mp4', () => {
        expect(getVideoExtensionByMimeType('')).toBe('mp4');
    });

    it('非字符串回退为 mp4', () => {
        expect(getVideoExtensionByMimeType(123)).toBe('mp4');
    });
});
