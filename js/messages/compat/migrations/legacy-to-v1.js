import { migrateSession } from '../../migration.js';

export const legacyToV1Migration = Object.freeze({
    from: 0,
    to: 1,
    scope: 'session',
    migrate(record) {
        return migrateSession(
            record.messages || [],
            record.geminiContents || [],
            record.claudeContents || []
        );
    }
});
