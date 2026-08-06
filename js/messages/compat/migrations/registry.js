import { legacyToV1Migration } from './legacy-to-v1.js';

const migrations = new Map([[legacyToV1Migration.from, legacyToV1Migration]]);

export function getMigration(fromVersion) {
    return migrations.get(fromVersion) || null;
}

export function listMigrations() {
    return [...migrations.values()];
}
