function normalizeText(text) {
    return typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
}

function extractMessageText(message) {
    if (!Array.isArray(message?.parts)) return '';
    return normalizeText(
        message.parts
            .filter((part) => part?.type === 'text' && typeof part.text === 'string')
            .map((part) => part.text)
            .join(' ')
    );
}

function buildSearchIndex(messages) {
    const source = Array.isArray(messages) ? messages : [];
    const entries = [];
    source.forEach((message, index) => {
        const text = extractMessageText(message);
        if (!text) return;
        entries.push({
            id: message?.id || `msg_${index}`,
            index,
            role: typeof message?.role === 'string' ? message.role.toLowerCase() : 'unknown',
            text
        });
    });
    return { version: 1, updatedAt: Date.now(), messageCount: source.length, entries };
}

function estimateTokens(text) {
    if (!text) return 0;
    const chinese = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    const other = text.replace(/[\u4e00-\u9fff]/g, ' ').trim();
    return chinese + (other ? Math.ceil(other.length / 4) : 0);
}

function segmentText(text, maxLength) {
    const source = String(text || '');
    const size = Math.max(1, Number(maxLength) || 16000);
    const segments = [];
    for (let start = 0; start < source.length; start += size) {
        segments.push(source.slice(start, start + size));
    }
    return segments;
}

globalThis.onmessage = ({ data }) => {
    const { id, type, payload } = data || {};
    try {
        let result;
        if (type === 'build-search-index') result = buildSearchIndex(payload?.messages);
        else if (type === 'estimate-tokens') result = estimateTokens(payload?.text);
        else if (type === 'segment-text') result = segmentText(payload?.text, payload?.maxLength);
        else throw new Error(`未知 Worker 任务: ${type}`);
        globalThis.postMessage({ id, result });
    } catch (error) {
        globalThis.postMessage({ id, error: error?.message || String(error) });
    }
};
