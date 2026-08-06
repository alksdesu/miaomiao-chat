const sessionWriteTails = new Map();

export async function withSessionWriteLock(sessionId, operation) {
    if (!sessionId) return await operation();

    const previous = sessionWriteTails.get(sessionId) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    sessionWriteTails.set(sessionId, current);

    try {
        return await current;
    } finally {
        if (sessionWriteTails.get(sessionId) === current) {
            sessionWriteTails.delete(sessionId);
        }
    }
}

export function clearSessionWriteQueueForTests() {
    sessionWriteTails.clear();
}
