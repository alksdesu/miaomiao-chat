/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
    loadEmergencySessionSnapshot,
    saveEmergencySessionSnapshot
} from '../../js/state/storage.js';
import { SCHEMA_VERSION } from '../../js/messages/schema.js';

const EMERGENCY_SESSION_KEY = 'webchatEmergencySession';

describe('emergency session compatibility', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it('保存前统一迁移旧消息并写入 schema 版本', () => {
        const saved = saveEmergencySessionSnapshot({ id: 'session-1', name: 'Legacy' }, [
            { role: 'user', content: 'hello', timestamp: 10 }
        ]);
        const raw = JSON.parse(localStorage.getItem(EMERGENCY_SESSION_KEY));

        expect(saved).toBe(true);
        expect(raw.messageSchemaVersion).toBe(SCHEMA_VERSION);
        expect(raw.messages[0]).toMatchObject({
            role: 'user',
            ts: 10,
            _schemaVersion: SCHEMA_VERSION
        });
        expect(raw.messages[0].parts[0]).toMatchObject({ type: 'text', text: 'hello' });
        expect(raw.messages[0].content).toBeUndefined();
    });

    it('读取旧应急快照时通过 gateway 迁移', () => {
        localStorage.setItem(
            EMERGENCY_SESSION_KEY,
            JSON.stringify({
                savedAt: 1,
                session: { id: 'session-2' },
                messages: [{ role: 'assistant', content: 'legacy answer' }]
            })
        );

        const snapshot = loadEmergencySessionSnapshot();

        expect(snapshot.compatibility.status).toBe('upgraded');
        expect(snapshot.messages[0].parts[0].text).toBe('legacy answer');
        expect(snapshot.messages[0]._schemaVersion).toBe(SCHEMA_VERSION);
    });

    it('损坏快照不删除唯一原始副本', () => {
        const raw = '{broken-json';
        localStorage.setItem(EMERGENCY_SESSION_KEY, raw);

        expect(loadEmergencySessionSnapshot()).toBeNull();
        expect(localStorage.getItem(EMERGENCY_SESSION_KEY)).toBe(raw);
    });
});
