import { describe, expect, it } from 'vitest';
import { getBranchName } from '../../js/messages/branching.js';

describe('message branching', () => {
    it('生成可识别且有限长度的分支名称', () => {
        expect(getBranchName('项目讨论')).toBe('项目讨论 · 分支');
        expect(getBranchName('')).toBe('未命名会话 · 分支');
        expect(getBranchName('a'.repeat(100)).length).toBe(48);
    });
});
