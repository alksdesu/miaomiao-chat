/**
 * file-helpers.js 文件处理工具测试
 */
import { describe, it, expect } from 'vitest';

import {
    FileCategory,
    categorizeFile,
    isImage,
    isVideo,
    isPDF,
    isText,
    truncateFileName,
    formatFileSize,
    parseDataURL,
    isDataURL,
    isHttpURL,
    getFileExtension,
    guessMimeType
} from '../../js/utils/file-helpers.js';

// ========== FileCategory ==========

describe('FileCategory', () => {
    it('包含所有类别', () => {
        expect(FileCategory.IMAGE).toBe('image');
        expect(FileCategory.VIDEO).toBe('video');
        expect(FileCategory.PDF).toBe('pdf');
        expect(FileCategory.TEXT).toBe('text');
        expect(FileCategory.UNKNOWN).toBe('unknown');
    });
});

// ========== categorizeFile ==========

describe('categorizeFile', () => {
    it('图片类型', () => {
        expect(categorizeFile('image/png')).toBe('image');
        expect(categorizeFile('image/jpeg')).toBe('image');
        expect(categorizeFile('image/webp')).toBe('image');
    });

    it('视频类型', () => {
        expect(categorizeFile('video/mp4')).toBe('video');
        expect(categorizeFile('video/webm')).toBe('video');
    });

    it('PDF 类型', () => {
        expect(categorizeFile('application/pdf')).toBe('pdf');
    });

    it('文本类型', () => {
        expect(categorizeFile('text/plain')).toBe('text');
        expect(categorizeFile('text/markdown')).toBe('text');
        expect(categorizeFile('text/html')).toBe('text');
        expect(categorizeFile('text/csv')).toBe('text');
    });

    it('application/{json,xml,yaml,javascript} 归 text 文本类', () => {
        expect(categorizeFile('application/json')).toBe('text');
        expect(categorizeFile('application/xml')).toBe('text');
        expect(categorizeFile('application/x-yaml')).toBe('text');
        expect(categorizeFile('application/javascript')).toBe('text');
    });

    it('未知类型', () => {
        expect(categorizeFile('application/zip')).toBe('unknown');
        expect(categorizeFile('application/octet-stream')).toBe('unknown');
    });

    it('空值返回 unknown', () => {
        expect(categorizeFile('')).toBe('unknown');
        expect(categorizeFile(null)).toBe('unknown');
        expect(categorizeFile(undefined)).toBe('unknown');
    });
});

// ========== isImage / isVideo / isPDF / isText ==========

describe('类型判断函数', () => {
    it('isImage', () => {
        expect(isImage('image/png')).toBeTruthy();
        expect(isImage('image/jpeg')).toBeTruthy();
        expect(isImage('video/mp4')).toBeFalsy();
        expect(isImage(null)).toBeFalsy();
        expect(isImage('')).toBeFalsy();
    });

    it('isVideo', () => {
        expect(isVideo('video/mp4')).toBeTruthy();
        expect(isVideo('video/webm')).toBeTruthy();
        expect(isVideo('image/png')).toBeFalsy();
        expect(isVideo(null)).toBeFalsy();
    });

    it('isPDF', () => {
        expect(isPDF('application/pdf')).toBe(true);
        expect(isPDF('text/plain')).toBe(false);
        expect(isPDF(null)).toBe(false);
    });

    it('isText', () => {
        expect(isText('text/plain')).toBeTruthy();
        expect(isText('text/markdown')).toBeTruthy();
        expect(isText('text/html')).toBeTruthy();
        expect(isText('image/png')).toBeFalsy();
        expect(isText(null)).toBeFalsy();
    });
});

// ========== truncateFileName ==========

describe('truncateFileName', () => {
    it('短文件名不截断', () => {
        expect(truncateFileName('short.txt')).toBe('short.txt');
    });

    it('null 返回空字符串', () => {
        expect(truncateFileName(null)).toBe('');
    });

    it('空字符串返回空', () => {
        expect(truncateFileName('')).toBe('');
    });

    it('长文件名截断保留扩展名', () => {
        const result = truncateFileName('very-long-filename-here.txt', 20);
        expect(result.length).toBeLessThanOrEqual(20);
        expect(result).toContain('.txt');
        expect(result).toContain('...');
    });

    it('无扩展名直接截断', () => {
        const result = truncateFileName('verylongfilenamewithoutextension', 15);
        expect(result.length).toBeLessThanOrEqual(15);
        expect(result).toContain('...');
    });

    it('自定义最大长度', () => {
        const result = truncateFileName('medium-name.js', 10);
        expect(result.length).toBeLessThanOrEqual(10);
    });

    it('扩展名太长时直接截断', () => {
        const result = truncateFileName('a.verylongext', 8);
        expect(result.length).toBeLessThanOrEqual(8);
        expect(result).toContain('...');
    });
});

// ========== formatFileSize ==========

describe('formatFileSize', () => {
    it('0 字节', () => {
        expect(formatFileSize(0)).toBe('0 B');
    });

    it('字节', () => {
        expect(formatFileSize(500)).toBe('500 B');
    });

    it('KB', () => {
        expect(formatFileSize(1024)).toBe('1.0 KB');
    });

    it('MB', () => {
        expect(formatFileSize(1024 * 1024)).toBe('1.0 MB');
    });

    it('GB', () => {
        expect(formatFileSize(1024 * 1024 * 1024)).toBe('1.0 GB');
    });

    it('小数', () => {
        expect(formatFileSize(1536)).toBe('1.5 KB');
    });
});

// ========== parseDataURL ==========

describe('parseDataURL', () => {
    it('有效 data URL', () => {
        const result = parseDataURL('data:image/png;base64,abc123');
        expect(result.mimeType).toBe('image/png');
        expect(result.base64).toBe('abc123');
    });

    it('null 返回 null', () => {
        expect(parseDataURL(null)).toBeNull();
    });

    it('非 data URL 返回 null', () => {
        expect(parseDataURL('https://example.com')).toBeNull();
    });

    it('空字符串返回 null', () => {
        expect(parseDataURL('')).toBeNull();
    });

    it('数字返回 null', () => {
        expect(parseDataURL(123)).toBeNull();
    });

    it('video data URL', () => {
        const result = parseDataURL('data:video/mp4;base64,xyz');
        expect(result.mimeType).toBe('video/mp4');
        expect(result.base64).toBe('xyz');
    });
});

// ========== isDataURL ==========

describe('isDataURL', () => {
    it('data URL 返回 true', () => {
        expect(isDataURL('data:image/png;base64,abc')).toBe(true);
    });

    it('http URL 返回 false', () => {
        expect(isDataURL('https://example.com')).toBe(false);
    });

    it('null 返回 false', () => {
        expect(isDataURL(null)).toBe(false);
    });

    it('数字返回 false', () => {
        expect(isDataURL(123)).toBe(false);
    });
});

// ========== isHttpURL ==========

describe('isHttpURL', () => {
    it('https URL', () => {
        expect(isHttpURL('https://example.com')).toBe(true);
    });

    it('http URL', () => {
        expect(isHttpURL('http://example.com')).toBe(true);
    });

    it('data URL 返回 false', () => {
        expect(isHttpURL('data:image/png;base64,abc')).toBe(false);
    });

    it('null 返回 false', () => {
        expect(isHttpURL(null)).toBe(false);
    });
});

// ========== getFileExtension ==========

describe('getFileExtension', () => {
    it('正常文件名', () => {
        expect(getFileExtension('photo.png')).toBe('png');
    });

    it('多点文件名', () => {
        expect(getFileExtension('file.name.tar.gz')).toBe('gz');
    });

    it('无扩展名', () => {
        expect(getFileExtension('noext')).toBe('');
    });

    it('null 返回空', () => {
        expect(getFileExtension(null)).toBe('');
    });

    it('空字符串返回空', () => {
        expect(getFileExtension('')).toBe('');
    });

    it('大写扩展名转小写', () => {
        expect(getFileExtension('image.PNG')).toBe('png');
    });

    it('数字返回空', () => {
        expect(getFileExtension(123)).toBe('');
    });
});

// ========== guessMimeType ==========

describe('guessMimeType', () => {
    it('jpg', () => {
        expect(guessMimeType('photo.jpg')).toBe('image/jpeg');
    });

    it('jpeg', () => {
        expect(guessMimeType('photo.jpeg')).toBe('image/jpeg');
    });

    it('png', () => {
        expect(guessMimeType('photo.png')).toBe('image/png');
    });

    it('gif', () => {
        expect(guessMimeType('anim.gif')).toBe('image/gif');
    });

    it('webp', () => {
        expect(guessMimeType('img.webp')).toBe('image/webp');
    });

    it('mp4', () => {
        expect(guessMimeType('video.mp4')).toBe('video/mp4');
    });

    it('webm', () => {
        expect(guessMimeType('video.webm')).toBe('video/webm');
    });

    it('pdf', () => {
        expect(guessMimeType('doc.pdf')).toBe('application/pdf');
    });

    it('txt', () => {
        expect(guessMimeType('readme.txt')).toBe('text/plain');
    });

    it('md', () => {
        expect(guessMimeType('readme.md')).toBe('text/markdown');
    });

    it('html', () => {
        expect(guessMimeType('index.html')).toBe('text/html');
    });

    it('js', () => {
        expect(guessMimeType('app.js')).toBe('text/javascript');
    });

    it('json', () => {
        expect(guessMimeType('data.json')).toBe('application/json');
    });

    it('css', () => {
        expect(guessMimeType('style.css')).toBe('text/css');
    });

    it('未知扩展名', () => {
        expect(guessMimeType('file.xyz')).toBe('application/octet-stream');
    });

    it('无扩展名', () => {
        expect(guessMimeType('noext')).toBe('application/octet-stream');
    });

    it('svg', () => {
        expect(guessMimeType('icon.svg')).toBe('image/svg+xml');
    });

    it('csv', () => {
        expect(guessMimeType('data.csv')).toBe('text/csv');
    });

    it('mov', () => {
        expect(guessMimeType('clip.mov')).toBe('video/quicktime');
    });
});
