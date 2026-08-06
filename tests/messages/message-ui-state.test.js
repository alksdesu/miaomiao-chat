import { beforeEach, describe, expect, it } from 'vitest';
import {
    clearMessageUiStates,
    getMessageUiState,
    getMessageUiStateCount,
    peekMessageUiState,
    removeMessageUiState,
    retainMessageUiStates,
    updateMessageUiState
} from '../../js/messages/message-ui-state.js';

describe('message-ui-state', () => {
    beforeEach(() => clearMessageUiStates());

    it('按 messageId 创建并更新状态', () => {
        expect(getMessageUiState('m1')).toMatchObject({ editing: false, measuredHeight: 0 });
        expect(updateMessageUiState('m1', { editing: true, measuredHeight: 120 })).toMatchObject({
            editing: true,
            measuredHeight: 120
        });
        expect(peekMessageUiState('m1').editing).toBe(true);
    });

    it('清理已删除消息但保留指定状态', () => {
        getMessageUiState('m1');
        getMessageUiState('m2');
        getMessageUiState('m3');
        retainMessageUiStates(['m2']);

        expect(getMessageUiStateCount()).toBe(1);
        expect(peekMessageUiState('m2')).not.toBeNull();
        expect(peekMessageUiState('m1')).toBeNull();
        expect(removeMessageUiState('m2')).toBe(true);
    });
});
