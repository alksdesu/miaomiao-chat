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

/**
 * 等待会话写入队列中已排入的写入全部结束（失败也算结束，不抛错）
 * @param {string} sessionId
 * @returns {Promise<void>}
 */
export async function waitForSessionWriteQueue(sessionId) {
    let tail = sessionId ? sessionWriteTails.get(sessionId) : null;
    // 等待期间可能又排入新的写入，追到队列清空为止
    while (tail) {
        await tail.catch(() => {});
        const next = sessionWriteTails.get(sessionId);
        tail = next && next !== tail ? next : null;
    }
}

export function clearSessionWriteQueueForTests() {
    sessionWriteTails.clear();
}
