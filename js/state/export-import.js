/**
 * 配置和会话导出/导入模块
 * 处理数据的备份和恢复
 */

import { state } from '../core/state.js';
import { elements } from '../core/elements.js';
import { loadAllSessionsFromDB, saveSessionToDB, loadSessionMessages, saveSessionMessages, loadConfig as loadConfigFromDB, loadSavedConfigs as loadSavedConfigsFromDB, saveConfig as saveConfigToDB, saveSavedConfigs as saveSavedConfigsToDB, loadPreference, savePreference } from './storage.js';
import { loadSavedConfigs } from './config.js';
import { loadSessions } from './sessions.js';
import { showNotification } from '../ui/notifications.js';
import { showConfirmDialog } from '../utils/dialogs.js';
import { sanitizeMessageForExport } from '../api/format-converter.js';  // 过滤私有字段
import { categorizeFile } from '../utils/file-helpers.js';
import { SCHEMA_VERSION } from '../messages/schema.js';
import { migrateSession } from '../messages/migration.js';

/**
 * 生成导出文件名
 * @param {string} type - 导出类型
 * @returns {string} 文件名
 */
function generateExportFilename(type) {
    const date = new Date().toISOString().slice(0, 10);
    return `webchat-${type}-${date}.json`;
}

/**
 * 下载 JSON 文件
 * @param {Object} data - 要导出的数据
 * @param {string} filename - 文件名
 */
function downloadJSON(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

/**
 * 过滤运行时状态字段（不应该导出的字段）
 * @param {Object} config - 配置对象
 * @returns {Object} 过滤后的配置对象
 */
function filterRuntimeState(config) {
    if (!config) return null;

    const { selectedModel, ...filteredConfig } = config;
    return filteredConfig;
}

/**
 * 为导出的会话列表加载消息数据（v4 架构适配）
 * v3 未迁移的会话可能有 _pendingMessages，v4 从 messages store 加载
 */
async function loadMessagesForSessions(sessions) {
    const results = [];
    for (const session of sessions) {
        const merged = { ...session };
        // v3 未迁移数据：从 _pending 字段获取
        if (merged._pendingMessages) {
            merged.messages = merged._pendingMessages;
            delete merged._pendingMessages;
            delete merged._pendingGemini;
            delete merged._pendingClaude;
        }
        // v4：从 messages store 加载
        else if (!merged.messages && merged.id) {
            try {
                const msgData = await loadSessionMessages(merged.id);
                if (msgData) {
                    merged.messages = msgData.messages || [];
                }
            } catch (e) {
                console.warn(`[Export] 加载会话 ${merged.id} 消息失败:`, e);
            }
        }
        results.push(merged);
    }
    return results;
}

/**
 * 清理会话中的私有字段
 * @param {Object} session - 会话对象
 * @returns {Object} 清理后的会话对象
 */
function sanitizeSession(session) {
    if (!session) return null;

    // 深拷贝会话对象
    const cleaned = { ...session };

    // 清理 messages 数组
    if (Array.isArray(cleaned.messages)) {
        cleaned.messages = cleaned.messages.map(msg => sanitizeMessageForExport(msg));
    }

    return cleaned;
}

/**
 * 导出配置
 * 注意：导出数据包含 API 密钥（apiKey、apiKeys），用户需妥善保管导出文件
 */
export async function exportConfig() {
    try {
        // 导出前提醒用户数据包含敏感信息
        const confirmed = await showConfirmDialog(
            '导出的配置文件包含 API 密钥等敏感信息，请妥善保管导出文件，避免泄露。是否继续？',
            '导出配置'
        );
        if (!confirmed) return;

        // 从 IndexedDB 读取配置
        let currentConfig = null;
        let savedConfigs = [];

        if (state.storageMode !== 'localStorage') {
            currentConfig = await loadConfigFromDB();
            savedConfigs = await loadSavedConfigsFromDB() || [];
        }

        // 降级：从 localStorage 读取
        if (!currentConfig) {
            const configData = localStorage.getItem('geminiChatConfig');
            currentConfig = configData ? JSON.parse(configData) : null;
        }
        if (savedConfigs.length === 0) {
            const configs = localStorage.getItem('geminiChatConfigs');
            savedConfigs = configs ? JSON.parse(configs) : [];
        }

        // 过滤掉运行时状态（selectedModel）
        const filteredCurrentConfig = currentConfig ? filterRuntimeState(currentConfig) : null;
        const filteredSavedConfigs = savedConfigs.map(filterRuntimeState);

        // 导出工具启用状态
        let toolsEnabled = null;
        try {
            const toolsEnabledJson = await loadPreference('toolsEnabled');
            if (toolsEnabledJson) {
                toolsEnabled = JSON.parse(toolsEnabledJson);
            }
        } catch (error) {
            console.warn('[Export] 读取工具状态失败:', error);
        }

        const exportData = {
            type: 'config',
            version: 1,
            exportDate: new Date().toISOString(),
            data: {
                currentConfig: filteredCurrentConfig,
                savedConfigs: filteredSavedConfigs,
                toolsEnabled: toolsEnabled  // 包含工具状态
            }
        };

        downloadJSON(exportData, generateExportFilename('config'));
        showNotification('配置已导出', 'success');
    } catch (error) {
        console.error('导出配置失败:', error);
        showNotification('导出配置失败: ' + error.message, 'error');
    }
}

/**
 * 导出会话记录
 */
export async function exportSessions() {
    try {
        const sessions = await loadAllSessionsFromDB();

        // v4: 从 messages store 加载每个会话的消息
        const sessionsWithMessages = await loadMessagesForSessions(sessions);

        // 清理会话中的私有字段
        const cleanedSessions = sessionsWithMessages.map(session => sanitizeSession(session));

        const exportData = {
            type: 'sessions',
            version: 1,
            exportDate: new Date().toISOString(),
            totalSessions: cleanedSessions.length,
            sessions: cleanedSessions
        };

        downloadJSON(exportData, generateExportFilename('sessions'));
        showNotification(`已导出 ${cleanedSessions.length} 个会话`, 'success');
    } catch (error) {
        console.error('导出会话失败:', error);
        showNotification('导出会话失败: ' + error.message, 'error');
    }
}

/**
 * 导出全部数据（配置 + 会话）
 * 注意：导出数据包含 API 密钥（apiKey、apiKeys），用户需妥善保管导出文件
 */
export async function exportAllData() {
    try {
        // 导出前提醒用户数据包含敏感信息
        const confirmed = await showConfirmDialog(
            '导出的备份文件包含 API 密钥等敏感信息，请妥善保管导出文件，避免泄露。是否继续？',
            '导出全部数据'
        );
        if (!confirmed) return;

        // 从 IndexedDB 读取数据
        let currentConfig = null;
        let savedConfigs = [];
        const sessions = await loadAllSessionsFromDB();

        if (state.storageMode !== 'localStorage') {
            currentConfig = await loadConfigFromDB();
            savedConfigs = await loadSavedConfigsFromDB() || [];
        }

        // 降级：从 localStorage 读取
        if (!currentConfig) {
            const configData = localStorage.getItem('geminiChatConfig');
            currentConfig = configData ? JSON.parse(configData) : null;
        }
        if (savedConfigs.length === 0) {
            const configs = localStorage.getItem('geminiChatConfigs');
            savedConfigs = configs ? JSON.parse(configs) : [];
        }

        // 过滤掉运行时状态（selectedModel）
        const filteredCurrentConfig = currentConfig ? filterRuntimeState(currentConfig) : null;
        const filteredSavedConfigs = savedConfigs.map(filterRuntimeState);

        // 清理会话中的私有字段
        const sessionsWithMessages = await loadMessagesForSessions(sessions);
        const cleanedSessions = sessionsWithMessages.map(session => sanitizeSession(session));

        const exportData = {
            type: 'full-backup',
            version: 1,
            exportDate: new Date().toISOString(),
            metadata: {
                totalConfigs: filteredSavedConfigs.length,
                totalSessions: cleanedSessions.length
            },
            config: {
                currentConfig: filteredCurrentConfig,
                savedConfigs: filteredSavedConfigs
            },
            sessions: cleanedSessions
        };

        downloadJSON(exportData, generateExportFilename('backup'));
        showNotification(`已导出完整备份（${cleanedSessions.length} 个会话）`, 'success');
    } catch (error) {
        console.error('导出失败:', error);
        showNotification('导出失败: ' + error.message, 'error');
    }
}

/**
 * 导入配置
 * @param {Object} data - 导入的数据
 */
async function importConfig(data) {
    if (!data.data) {
        throw new Error('配置数据格式错误');
    }

    try {
        // 导入当前配置（过滤掉运行时状态）
        if (data.data.currentConfig) {
            const filtered = filterRuntimeState(data.data.currentConfig);
            if (state.storageMode !== 'localStorage') {
                await saveConfigToDB(filtered);
            } else {
                localStorage.setItem('geminiChatConfig', JSON.stringify(filtered));
            }
        }

        // 导入保存的配置（过滤掉运行时状态）
        if (data.data.savedConfigs) {
            const filtered = data.data.savedConfigs.map(filterRuntimeState);
            if (state.storageMode !== 'localStorage') {
                await saveSavedConfigsToDB(filtered);
            } else {
                localStorage.setItem('geminiChatConfigs', JSON.stringify(filtered));
            }
        }

        // 导入工具启用状态
        if (data.data.toolsEnabled) {
            try {
                await savePreference('toolsEnabled', JSON.stringify(data.data.toolsEnabled));
                console.log('[Import] 工具状态已导入');
            } catch (error) {
                console.warn('[Import] 导入工具状态失败:', error);
            }
        }

        // 重新加载配置列表
        loadSavedConfigs();

        // 新增：触发模型列表刷新
        import('../ui/models.js').then(({ populateModelSelect }) => {
            populateModelSelect();
        }).catch(err => console.warn('Failed to refresh model list:', err));

        showNotification('配置已导入，请刷新页面应用更改', 'success');
    } catch (error) {
        console.error('导入配置失败:', error);
        // 降级处理
        if (data.data.currentConfig) {
            const filtered = filterRuntimeState(data.data.currentConfig);
            localStorage.setItem('geminiChatConfig', JSON.stringify(filtered));
        }
        if (data.data.savedConfigs) {
            const filtered = data.data.savedConfigs.map(filterRuntimeState);
            localStorage.setItem('geminiChatConfigs', JSON.stringify(filtered));
        }
        throw error;
    }
}

/**
 * 导入会话
 * @param {Object} data - 导入的数据
 */
async function importSessions(data) {
    if (!data.sessions || !Array.isArray(data.sessions)) {
        throw new Error('会话数据格式错误');
    }

    let importCount = 0;
    const errors = [];

    for (const session of data.sessions) {
        try {
            // 检查会话是否已存在
            const existing = state.sessions.find(s => s.id === session.id);
            if (existing) {
                // 询问是否覆盖
                const overwrite = await showConfirmDialog(
                    `会话 "${session.name}" 已存在，是否覆盖？`,
                    '确认覆盖'
                );
                if (!overwrite) continue;
            }

            // 分离消息数据，写入 messages store
            const { messages, geminiContents: _gc, claudeContents: _cc, ...sessionMeta } = session;
            await saveSessionToDB(sessionMeta);
            if (messages && messages.length > 0) {
                // 检查是否需要迁移旧格式消息
                const needsMigration = !messages[0]?._schemaVersion || messages[0]._schemaVersion < SCHEMA_VERSION;
                let finalMessages = messages;
                if (needsMigration) {
                    try {
                        const migrated = migrateSession(messages);
                        if (migrated.messages.length > 0) {
                            finalMessages = migrated.messages;
                            console.log(`[Import] 迁移会话 ${session.id}: ${messages.length} → ${finalMessages.length} 条消息`);
                        }
                    } catch (e) {
                        console.warn(`[Import] 迁移失败，使用原始格式:`, e);
                    }
                }
                await saveSessionMessages(session.id, {
                    messages: finalMessages,
                });
            }
            importCount++;
        } catch (error) {
            console.error(`导入会话 ${session.id} 失败:`, error);
            errors.push(session.name);
        }
    }

    // 重新加载会话列表
    await loadSessions();

    if (errors.length > 0) {
        showNotification(`已导入 ${importCount} 个会话，${errors.length} 个失败`, 'warning');
    } else {
        showNotification(`已导入 ${importCount} 个会话`, 'success');
    }
}

/**
 * 导入完整备份
 * @param {Object} data - 导入的数据
 */
async function importFullBackup(data) {
    if (!data.config || !data.sessions) {
        throw new Error('备份数据格式错误');
    }

    try {
        // 导入配置（过滤掉运行时状态）
        if (data.config.currentConfig) {
            const filtered = filterRuntimeState(data.config.currentConfig);
            if (state.storageMode !== 'localStorage') {
                await saveConfigToDB(filtered);
            } else {
                localStorage.setItem('geminiChatConfig', JSON.stringify(filtered));
            }
        }
        if (data.config.savedConfigs) {
            const filtered = data.config.savedConfigs.map(filterRuntimeState);
            if (state.storageMode !== 'localStorage') {
                await saveSavedConfigsToDB(filtered);
            } else {
                localStorage.setItem('geminiChatConfigs', JSON.stringify(filtered));
            }
        }

        // 导入会话
        let importCount = 0;
        for (const session of data.sessions) {
            try {
                const { messages, geminiContents: _gc, claudeContents: _cc, ...sessionMeta } = session;
                await saveSessionToDB(sessionMeta);
                if (messages && messages.length > 0) {
                    // 检查是否需要迁移旧格式消息
                    const needsMigration = !messages[0]?._schemaVersion || messages[0]._schemaVersion < SCHEMA_VERSION;
                    let finalMessages = messages;
                    if (needsMigration) {
                        try {
                            const migrated = migrateSession(messages);
                            if (migrated.messages.length > 0) {
                                finalMessages = migrated.messages;
                            }
                        } catch (e) {
                            console.warn(`[Import] 迁移失败，使用原始格式:`, e);
                        }
                    }
                    await saveSessionMessages(session.id, {
                        messages: finalMessages,
                    });
                }
                importCount++;
            } catch (error) {
                console.error(`导入会话 ${session.id} 失败:`, error);
            }
        }

        // 重新加载配置和会话列表
        loadSavedConfigs();
        await loadSessions();

        // 新增：触发模型列表刷新
        import('../ui/models.js').then(({ populateModelSelect }) => {
            populateModelSelect();
        }).catch(err => console.warn('Failed to refresh model list:', err));

        showNotification(`已导入完整备份（${importCount} 个会话），请刷新页面应用配置更改`, 'success');
    } catch (error) {
        console.error('导入完整备份失败:', error);
        // 降级处理
        if (data.config.currentConfig) {
            const filtered = filterRuntimeState(data.config.currentConfig);
            localStorage.setItem('geminiChatConfig', JSON.stringify(filtered));
        }
        if (data.config.savedConfigs) {
            const filtered = data.config.savedConfigs.map(filterRuntimeState);
            localStorage.setItem('geminiChatConfigs', JSON.stringify(filtered));
        }
        throw error;
    }
}

/**
 * 触发导入文件选择
 */
export function triggerImport() {
    elements.importFileInput.click();
}

/**
 * 处理导入文件
 * @param {Event} event - 文件输入事件
 */
export async function handleImportFile(event) {
    const file = event.target.files[0];
    if (!file) return;

    try {
        const text = await file.text();
        const data = JSON.parse(text);

        if (!data.type || !data.version) {
            throw new Error('无效的备份文件格式');
        }

        switch (data.type) {
            case 'config':
                await importConfig(data);
                break;
            case 'sessions':
                await importSessions(data);
                break;
            case 'full-backup':
                await importFullBackup(data);
                break;
            default:
                throw new Error(`不支持的备份类型: ${data.type}`);
        }

    } catch (error) {
        console.error('导入失败:', error);
        showNotification('导入失败: ' + error.message, 'error');
    } finally {
        // 清空文件输入
        event.target.value = '';
    }
}

/**
 * 初始化导出/导入功能
 */
export function initExportImport() {
    // 绑定导出按钮（使用正确的ID）
    const exportConfigBtn = document.getElementById('export-config');
    if (exportConfigBtn) {
        exportConfigBtn.addEventListener('click', exportConfig);
    }

    const exportSessionsBtn = document.getElementById('export-sessions');
    if (exportSessionsBtn) {
        exportSessionsBtn.addEventListener('click', exportSessions);
    }

    const exportAllBtn = document.getElementById('export-all');
    if (exportAllBtn) {
        exportAllBtn.addEventListener('click', exportAllData);
    }

    // 绑定导入按钮
    const importBtn = document.getElementById('import-data');
    if (importBtn) {
        importBtn.addEventListener('click', triggerImport);
    }

    // 绑定文件输入
    if (elements.importFileInput) {
        elements.importFileInput.addEventListener('change', handleImportFile);
    }

    // 将函数暴露到全局作用域供 HTML onclick 使用
    window.exportConfig = exportConfig;
    window.exportSessions = exportSessions;
    window.exportAllData = exportAllData;
    window.triggerImport = triggerImport;

    console.log('Export/Import initialized');
}

// ========== 会话 Markdown 导出 ==========

function getExportMessages(session) {
    if (Array.isArray(session?.messages) && session.messages.length > 0) {
        return session.messages;
    }
    return [];
}

function getSelectedReply(msg) {
    const repliesAll = msg?.replies?.all || msg?.allReplies;
    if (!Array.isArray(repliesAll) || repliesAll.length === 0) {
        return null;
    }
    const selectedIndex = msg?.replies?.selected ?? (Number.isInteger(msg?.selectedReplyIndex) ? msg.selectedReplyIndex : 0);
    return repliesAll[selectedIndex] || repliesAll[0] || null;
}

function getAttachmentMarker(part) {
    if (!part || typeof part !== 'object') return '';

    // 新格式 parts: type=media/file
    if (part.type === 'media') {
        if (part.media === 'video') return '[视频]';
        if (part.media === 'audio') return '[音频]';
        return '[图片]';
    }
    if (part.type === 'file') return '[文档]';

    // 旧格式
    if (part.type === 'image_url' || part.type === 'image') return '[图片]';
    if (part.type === 'video_url') return '[视频]';
    if (part.type === 'document') return '[文档]';

    const inlineData = part.inlineData || part.inline_data;
    if (inlineData) {
        const mimeType = inlineData.mimeType || inlineData.mime_type || '';
        const category = categorizeFile(mimeType);
        if (category === 'image') return '[图片]';
        if (category === 'video') return '[视频]';
        if (category === 'pdf' || category === 'text') return '[文档]';
        return '[附件]';
    }

    return '';
}

function extractTextFromParts(parts = []) {
    return parts
        .map((part) => {
            if (!part || typeof part !== 'object') return '';
            if (part.thought || part.type === 'thinking') return '';
            if (typeof part.text === 'string') return part.text;
            return getAttachmentMarker(part);
        })
        .filter(Boolean)
        .join('\n')
        .trim();
}

function extractThinkingContent(msg) {
    const selectedReply = getSelectedReply(msg);

    if (Array.isArray(msg?.parts)) {
        const thinking = msg.parts
            .filter(part => (part?.type === 'thinking' || part?.thought) && typeof part.text === 'string')
            .map(part => part.text)
            .join('\n\n')
            .trim();
        if (thinking) return thinking;
    }
    if (selectedReply?.thinkingContent) {
        return selectedReply.thinkingContent;
    }
    if (msg?.thinkingContent) {
        return msg.thinkingContent;
    }
    if (msg?.thought) {
        return msg.thought;
    }
    if (Array.isArray(msg?.contentParts)) {
        const thinking = msg.contentParts
            .filter(part => part?.type === 'thinking' && typeof part.text === 'string')
            .map(part => part.text)
            .join('\n\n')
            .trim();
        if (thinking) return thinking;
    }
    return '';
}

function extractMessageBody(msg) {
    const selectedReply = getSelectedReply(msg);

    if (selectedReply) {
        if (Array.isArray(selectedReply.parts) && selectedReply.parts.length > 0) {
            return extractTextFromParts(selectedReply.parts);
        }
        if (typeof selectedReply.content === 'string' && selectedReply.content.trim()) {
            return selectedReply.content.trim();
        }
        if (Array.isArray(selectedReply.contentParts) && selectedReply.contentParts.length > 0) {
            return extractTextFromParts(selectedReply.contentParts);
        }
        if (Array.isArray(selectedReply.claudeContent) && selectedReply.claudeContent.length > 0) {
            return extractTextFromParts(selectedReply.claudeContent);
        }
    }

    if (Array.isArray(msg?.parts) && msg.parts.length > 0) {
        return extractTextFromParts(msg.parts);
    }
    if (typeof msg?.content === 'string') {
        return msg.content.trim();
    }
    if (Array.isArray(msg?.content)) {
        return extractTextFromParts(msg.content);
    }
    if (Array.isArray(msg?.contentParts)) {
        return extractTextFromParts(msg.contentParts);
    }
    return '';
}

function extractToolCalls(msg) {
    // 新格式：从 parts 提取
    if (Array.isArray(msg?.parts)) {
        const tcNames = msg.parts
            .filter(p => p.type === 'tool_call' && p.name)
            .map(p => p.name);
        if (tcNames.length > 0) return tcNames.map(n => `- ${n}`).join('\n');
    }
    // 旧格式回退
    const toolCalls = msg?.toolCalls;
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
        return '';
    }
    const lines = toolCalls
        .map(toolCall => toolCall?.name || toolCall?.function?.name || toolCall?.id || '')
        .filter(Boolean);
    if (lines.length === 0) return '';
    return lines.map(name => `- ${name}`).join('\n');
}

/**
 * 将整个会话转换为 Markdown 字符串
 * @param {Object} session - 会话对象
 * @returns {string} Markdown 字符串
 */
export function sessionToMarkdown(session) {
    if (!session) return '';

    const messages = getExportMessages(session);
    if (messages.length === 0) return '';

    let markdown = `# ${session.name || 'Untitled Session'}\n\n`;

    messages.forEach((msg) => {
        if (msg.role === 'system') return;

        const roleName = msg.role === 'user' ? 'User' : 'Assistant';
        markdown += `## ${roleName}\n\n`;

        const thinkingContent = extractThinkingContent(msg);
        if (thinkingContent) {
            markdown += `> **Thinking:**\n> ${thinkingContent.replace(/\n/g, '\n> ')}\n\n`;
        }

        const toolCalls = extractToolCalls(msg);
        if (toolCalls) {
            markdown += `> **Tool Calls:**\n> ${toolCalls.replace(/\n/g, '\n> ')}\n\n`;
        }

        const content = extractMessageBody(msg);
        markdown += `${content || '[无文本内容]'}\n\n`;

        markdown += `---\n\n`;
    });

    return markdown.trim();
}
