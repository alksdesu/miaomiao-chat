export const CompatibilityStatus = Object.freeze({
    UNCHANGED: 'unchanged',
    UPGRADED: 'upgraded',
    SALVAGED: 'salvaged',
    FAILED: 'failed'
});

export function createCompatibilityResult(overrides = {}) {
    return {
        messages: [],
        sourceVersion: null,
        targetVersion: null,
        status: CompatibilityStatus.UNCHANGED,
        changed: false,
        toolMessageCount: 0,
        warnings: [],
        errors: [],
        writeBackRequired: false,
        ...overrides
    };
}
