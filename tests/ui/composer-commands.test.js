import { describe, expect, it } from 'vitest';
import { findCommandMatches } from '../../js/ui/composer-commands.js';

describe('composer commands', () => {
    it('空查询返回全部快捷指令', () => {
        expect(findCommandMatches('')).toHaveLength(5);
    });

    it('按名称和描述筛选快捷指令', () => {
        expect(findCommandMatches('代码').map((command) => command.name)).toEqual(['代码']);
        expect(findCommandMatches('重点').map((command) => command.name)).toEqual(['总结']);
    });

    it('忽略查询首尾空白和大小写', () => {
        expect(findCommandMatches('  解释  ')[0].name).toBe('解释');
    });
});
