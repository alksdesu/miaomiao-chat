/**
 * 全局状态管理
 *
 * 使用单层 Proxy 拦截顶层属性写入，自动通过 eventBus 发射变更事件
 * 所有 state.xxx = value 赋值无需修改即可获得事件通知能力
 *
 * 设计决策：
 * - 单层 Proxy（非递归），避免 Map/Set/Array 内部操作误触发
 * - 事件名与 state-mutations.js 一致：state:{key} + state:property-changed
 * - batch() 支持批量更新合并事件
 */

import { eventBus } from './events.js';

// ========== 内部原始状态对象 ==========

const _rawState = {
    // 消息存储
    messages: [], // OpenAI 格式消息

    // 消息 ID 映射（解决索引不一致问题）
    // messageId -> 数组索引，用于快速查找和防止删除错位
    messageIdMap: new Map(), // Map<messageId, number>

    // 会话脏标记（消息变更追踪，避免无变更时冗余保存）
    sessionDirty: false,

    // UI 状态
    isLoading: false,
    currentAssistantMessage: null,
    currentAbortController: null, // 用于取消当前请求
    requestTimeout: 300000, // 请求超时时间（毫秒），默认 5 分钟

    // 图片处理
    imageBuffers: new Map(), // 存储正在接收的图片分块数据
    imageIdCounter: 0,
    imageTimeoutMs: 60000,
    maxImageBufferSize: 100 * 1024 * 1024, // 100MB
    uploadedImages: [],
    imageSize: '2K', // '2K' | '4K'
    fastImageCompression: false, // 高速压缩模式（512px 超级压缩）
    pdfMode: 'standard', // PDF 处理模式: 'standard' | 'compat' | 'render'

    // 消息编辑
    lastUserMessage: null,
    messageHistory: [],
    maxHistorySize: 10,
    editingIndex: null,
    editingElement: null,

    // API 配置
    apiFormat: 'openai', // 'openai' | 'gemini' | 'claude'
    endpoints: {
        openai: '',
        gemini: '',
        claude: ''
    },
    apiKeys: {
        openai: '',
        gemini: '',
        claude: ''
    },
    customModels: {
        openai: '',
        gemini: '',
        claude: ''
    },
    customHeaders: [],

    // 提供商管理
    providers: [],                    // 提供商列表
    currentProviderId: null,          // 当前使用的提供商 ID
    selectedModel: '',                // 当前选中的模型ID（从下拉列表）

    // 模型参数
    modelParams: {
        openai: {
            temperature: null,
            max_tokens: null,
            top_p: null,
            frequency_penalty: null,
            presence_penalty: null
        },
        gemini: {
            temperature: null,
            maxOutputTokens: null,
            topP: null,
            topK: null,
        },
        claude: {
            temperature: null,
            max_tokens: null,
            top_p: null,
            top_k: null
        }
    },

    // 功能开关
    streamEnabled: true,
    thinkingEnabled: false,
    thinkingStrength: 'high', // 'low' | 'medium' | 'high' | 'custom'
    thinkingBudget: 32768,
    thinkingNoneMode: false,  // 关闭时是否发送 none（Responses API 模式）
    claudeAdaptiveThinking: false, // Claude 4.6 adaptive thinking 模式
    claudeEffortLevel: 'high', // Claude adaptive effort: 'low' | 'medium' | 'high'
    webSearchEnabled: false,
    geminiApiKeyInHeader: false,
    prefillEnabled: true,

    // 输出详细度配置
    verbosityEnabled: false,  // 是否启用输出详细度控制
    outputVerbosity: 'medium',  // 'low' | 'medium' | 'high'

    // Code Execution 开关
    codeExecutionEnabled: false,  // 代码执行功能（支持 Gemini、OpenAI、Claude）

    // Computer Use 开关和配置（仅 Electron 环境）
    computerUseEnabled: false,  // 计算机控制功能（仅 Claude + Electron）
    computerUsePermissions: {
        mouse: true,        // 允许鼠标控制
        keyboard: true,     // 允许键盘控制
        screenshot: true,   // 允许屏幕截图
        bash: true,         // 允许执行 Bash 命令
        textEditor: true    // 允许编辑文件
    },
    bashConfig: {
        workingDirectory: '',  // 默认工作目录（空表示应用根目录）
        timeout: 30,           // 超时时间（秒）
        requireConfirmation: true   // 是否需要用户确认
    },

    // 工具调用兜底
    xmlToolCallingEnabled: false,  // XML 工具调用兜底（兼容不支持原生 tools 的后端）

    // 配置管理
    savedConfigs: [],
    currentConfigName: '',
    pendingModelSelection: null,

    // 会话管理
    sessions: [],
    currentSessionId: null,
    isSwitchingSession: false, // 防止会话切换竞态条件
    backgroundTasks: new Map(),

    // 多回复生成
    replyCount: 1,
    currentReplies: [],
    selectedReplyIndex: 0,

    // 工具调用历史
    toolCallHistory: [],           // 工具调用历史记录
    maxToolHistorySize: 100,       // 最大历史记录数
    toolHistoryEnabled: true,      // 是否启用历史记录

    // 工具调用权限
    toolPermissions: {
        enabled: false,            // 是否启用权限系统
        mode: 'whitelist',         // 'whitelist' | 'blacklist'
        whitelist: [],             // 白名单（仅允许列表中的工具）
        blacklist: [],             // 黑名单（禁止列表中的工具）
        requireConfirmation: false // 是否需要用户确认
    },

    // 流统计
    streamStats: {
        requestStartTime: 0,
        firstTokenTime: 0,
        endTime: 0,
        tokenCount: 0,
        isFirstToken: true
    },

    // 预填充消息（在用户最新输入之后插入）
    systemPrompt: '',
    prefillMessages: [],
    charName: 'Assistant',
    userName: 'User',
    savedPrefillPresets: [],
    currentPrefillPresetName: '',

    // System 预填充消息（在 System Prompt 之后、对话历史之前插入）
    systemPrefillMessages: [],
    savedSystemPrefillPresets: [],
    currentSystemPrefillPresetName: '',

    // Gemini System Parts
    geminiSystemPartsEnabled: false,
    geminiSystemParts: [],
    savedGeminiPartsPresets: [],
    currentGeminiPartsPresetName: '',

    // 防抖控制
    isSending: false,
    sendLockTimeout: null,

    // 快捷消息
    quickMessages: [],
    quickMessagesCategories: ['常用', '问候', '告别'],

    // MCP 配置（Model Context Protocol）
    mcpServers: [],      // MCP 服务器列表
    tools: []            // 工具列表（内置 + MCP + 自定义）
};

// ========== Proxy 响应式包装 ==========

let _batchDepth = 0;
let _batchedChanges = [];

/**
 * 发射属性变更事件
 * 事件名与 state-mutations.js 的 setState() 一致
 */
function _emitChange(key, oldValue, newValue) {
    eventBus.emit(`state:${String(key)}`, { oldValue, newValue });
    eventBus.emit('state:property-changed', { key: String(key), oldValue, newValue });
}

/**
 * 全局状态对象（Proxy 包装）
 * 拦截顶层属性写入，自动发射 eventBus 事件
 * 所有现有的 state.xxx = value 写法无需修改即可获得事件通知
 */
export const state = new Proxy(_rawState, {
    set(target, prop, value) {
        const old = target[prop];

        // 同值跳过（先检查再赋值，避免冗余写入）
        if (Object.is(old, value)) return true;

        target[prop] = value;

        if (_batchDepth > 0) {
            _batchedChanges.push({ key: prop, oldValue: old, newValue: value });
        } else {
            _emitChange(prop, old, value);
        }

        return true;
    },

    get(target, prop) {
        return target[prop];
    },

    deleteProperty(target, prop) {
        const old = target[prop];
        delete target[prop];
        if (_batchDepth === 0) {
            _emitChange(prop, old, undefined);
        }
        return true;
    }
});

// ========== 公共 API ==========

// 重新导出 elements（便于其他模块导入）
export { elements } from './elements.js';

// 获取当前状态
export const getState = () => state;

/**
 * 订阅特定属性变更
 * @param {string} path - 属性名（如 'isLoading', 'apiFormat'）
 * @param {Function} callback - ({ oldValue, newValue }) => void
 * @returns {Function} 取消订阅函数
 */
export const subscribe = (path, callback) => {
    return eventBus.on(`state:${path}`, callback);
};

/**
 * 批量更新状态，合并事件到批量结束后统一发射
 * 避免高频连续赋值时产生过多中间事件
 * @param {Function} fn - 批量更新函数
 */
export const batch = (fn) => {
    _batchDepth++;
    try {
        fn();
    } finally {
        _batchDepth--;
        if (_batchDepth === 0 && _batchedChanges.length > 0) {
            const changes = _batchedChanges;
            _batchedChanges = [];
            for (const change of changes) {
                _emitChange(change.key, change.oldValue, change.newValue);
            }
        }
    }
};
