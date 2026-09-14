import { describe, expect, it } from 'vitest';
import { findPaletteCommands } from '../../js/ui/command-palette.js';

describe('command palette', () => {
    it('空查询返回所有命令', () => {
        expect(findPaletteCommands()).toHaveLength(9);
    });

    it('按名称或说明筛选命令', () => {
        expect(findPaletteCommands('提供商')[0].id).toBe('open-providers');
        expect(findPaletteCommands('密钥')[0].id).toBe('open-providers');
    });

    it('查询会忽略首尾空白', () => {
        expect(findPaletteCommands('  输入  ')[0].id).toBe('focus-input');
    });
});
