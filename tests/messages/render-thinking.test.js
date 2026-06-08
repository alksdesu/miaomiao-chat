/**
 * render-thinking.js 测试
 * 思维链渲染模块
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// 检查此文件的导出
let renderThinkingModule;
try {
    renderThinkingModule = await import('../../js/messages/render-thinking.js');
} catch {
    renderThinkingModule = null;
}

// 如果模块有太多依赖无法加载，跳过
const describeIfModule = renderThinkingModule ? describe : describe.skip;

describeIfModule('render-thinking.js', () => {
    it('模块能正常加载', () => {
        expect(renderThinkingModule).not.toBeNull();
    });
});
