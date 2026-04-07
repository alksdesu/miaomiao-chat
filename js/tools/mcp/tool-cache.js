/**
 * MCP 工具定义缓存
 * 启动时先加载缓存的工具列表，后台更新。避免每次刷新都等 tools/list
 */

const CACHE_PREFIX = 'mcp-tools-';
const DEFAULT_MAX_AGE = 24 * 3600 * 1000; // 24 小时

/**
 * 缓存工具列表到 localStorage
 */
export function cacheTools(serverId, tools) {
    try {
        localStorage.setItem(`${CACHE_PREFIX}${serverId}`, JSON.stringify({
            tools,
            timestamp: Date.now()
        }));
    } catch (e) {
        // localStorage 满了就跳过，不影响功能
        console.warn('[ToolCache] 缓存写入失败:', e.message);
    }
}

/**
 * 获取缓存的工具列表
 * @returns {Array|null} 缓存的工具列表，过期或不存在返回 null
 */
export function getCachedTools(serverId, maxAge = DEFAULT_MAX_AGE) {
    try {
        const raw = localStorage.getItem(`${CACHE_PREFIX}${serverId}`);
        if (!raw) return null;
        const { tools, timestamp } = JSON.parse(raw);
        if (Date.now() - timestamp > maxAge) {
            localStorage.removeItem(`${CACHE_PREFIX}${serverId}`);
            return null;
        }
        return tools;
    } catch {
        return null;
    }
}

/**
 * 清除指定服务器的工具缓存
 */
export function clearToolCache(serverId) {
    try {
        localStorage.removeItem(`${CACHE_PREFIX}${serverId}`);
    } catch { /* ignore */ }
}

/**
 * 清除所有 MCP 工具缓存
 */
export function clearAllToolCaches() {
    try {
        const keysToRemove = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith(CACHE_PREFIX)) {
                keysToRemove.push(key);
            }
        }
        keysToRemove.forEach(k => localStorage.removeItem(k));
    } catch { /* ignore */ }
}
