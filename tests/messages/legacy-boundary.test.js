import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const CANONICAL_CONSUMERS = [
    'js/api/openclaw.js',
    'js/api/request-pipeline.js',
    'js/core/state-mutations.js',
    'js/messages/editor.js',
    'js/messages/render-code.js',
    'js/messages/renderer.js',
    'js/messages/reply-selector.js',
    'js/messages/restore.js',
    'js/messages/schema.js',
    'js/messages/sync.js',
    'js/state/export-import.js',
    'js/state/session-search-index.js',
    'js/state/storage.js',
    'js/tools/message-compat.js',
    'js/ui/virtual-scroll.js',
    'js/utils/images.js',
    'js/utils/long-chat-worker-client.js',
    'js/utils/message-filter.js',
    'js/workers/long-chat-worker.js'
];
const LEGACY_ACCESS =
    /\b(?:msg|message|storedMessage|currentMessage|sourceMessage)\??\.(?:content|contentParts|thinkingContent|toolCalls|tool_calls|allReplies|selectedReplyIndex|errorHtml|isError)\b/g;

describe('legacy message boundary', () => {
    it('标准消息消费端不直接读取旧持久化字段', () => {
        const violations = [];
        for (const relativePath of CANONICAL_CONSUMERS) {
            const source = readFileSync(resolve(ROOT, relativePath), 'utf8');
            for (const match of source.matchAll(LEGACY_ACCESS)) {
                const line = source.slice(0, match.index).split('\n').length;
                violations.push(`${relativePath}:${line} ${match[0]}`);
            }
        }
        expect(violations).toEqual([]);
    });
});
