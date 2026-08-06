/**
 * 全局状态管理
 *
 * 使用单层 Proxy 拦截顶层属性写入，自动通过 eventBus 发射变更事件
 * 所有 state.xxx = value 赋值无需修改即可获得事件通知能力
 *
 * 设计决策：
 * - 单层 Proxy（非递归），避免 Map/Set/Array 内部操作误触发
 * - 事件名：state:{key}（如 state:isLoading）
 * - batch() 支持批量更新合并事件
 *
 * Map/Set 字段的响应式语义：
 *   下方 _rawState 中 backgroundTasks/imageBuffers/_imageCompressionRetriedSessions/
 *   _lastKnownSessionUpdatedAt 等 Map/Set 实例的 .set/.add/.delete/.clear **不会**触发
 *   state:xxx 事件（Proxy 仅拦截顶层赋值，未代理内部集合方法）。
 *   依赖订阅这些集合变更的消费方必须由业务侧显式 emit 关联事件（如 sessions:updated）。
 */

import { eventBus } from './events.js';
import { MessageStore } from './message-store.js';

// ========== 内部原始状态对象 ==========

const _rawState = {
    // 消息存储（由 messageStore 持有同一引用 + 维护 idMap，外部禁止整体替换）
    messages: [],

    // messageStore 旁路封装，提供 O(1) findById/findIndexById/findByEl
    // 与 _rawState.messages 共享同一数组引用，所有写路径走 store API
    messageStore: null, // 在 _rawState 声明完后立即初始化（见下方）

    // 消息 ID 映射（双轨 alias 指向 messageStore.idMap，迁移期保留兼容旧消费方）
    messageIdMap: null, // 在 messageStore 初始化后赋值为 store.idMap

    // 会话脏标记（消息变更追踪，避免无变更时冗余保存）
    sessionDirty: false,

    // UI 状态
    isLoading: false,
    currentAssistantMessage: null,
    requestTimeout: 300000, // 请求超时时间（毫秒），默认 5 分钟
    // 流式响应空闲超时：两次 chunk 之间允许的最长无数据间隔。requestTimeout 只保护
    // 连接+headers 阶段（fetch abort），token 阶段慢/卡死/代理 silent drop 由此守门。
    // reasoning 模型（含 extended thinking）内部推理时可能持续 1-5 分钟无 SSE
    // chunk，120s 默认会误杀；用户可在偏好设置中调高
    streamIdleTimeout: 120000,
    longChatRenderingMode: 'auto',

    // 工具调用续传状态
    isToolCallPending: false, // 工具正在执行中
    isSavingContinuation: false, // 正在保存 continuation 消息
    isToolCallContinuation: false, // 下次 sendToAPI 复用消息元素
    toolCallContinuationElement: null, // 要复用的消息 DOM 元素
    // sourceSessionId 锁住发起 continuation 时的会话；resendWithToolResults 时若
    // currentSessionId 已切换，丢弃 continuation 改走 background save，避免新会话被污染
    toolCallContinuationSessionId: null,

    // 图片处理
    imageBuffers: new Map(), // 存储正在接收的图片分块数据
    imageIdCounter: 0,
    imageTimeoutMs: 60000,
    maxImageBufferSize: 100 * 1024 * 1024, // 100MB
    uploadedImages: [],
    imageSize: '2K', // '2K' | '4K'
    fastImageCompression: false, // 高速压缩模式（512px 超级压缩）
    pdfMode: 'standard', // PDF 处理模式: 'standard' | 'compat' | 'render'

    // 图片压缩重试状态
    isImageCompressionRetry: false, // 下次 sendToAPI 以重试模式运行
    imageRetryMessageElement: null, // 重试时复用的消息 DOM 元素
    // sourceSessionId 锁住发起 retry 时的会话；resolvePlaceholder 时若 currentSessionId
    // 已切换，丢弃 retry 元素走 resolveNew，避免复用脱离 DOM 的旧元素
    imageRetrySessionId: null,
    // 已尝试压缩重试的会话 ID 集合（per-sessionId 锁）— 全局 boolean 在跨会话场景下
    // 会让前一会话的 retried=true 误锁住后一会话的首次重试机会
    _imageCompressionRetriedSessions: new Set(),

    // 消息编辑
    lastUserMessage: null,
    messageHistory: [],
    maxHistorySize: 10,
    editingIndex: null,
    editingElement: null,

    // API 配置
    apiFormat: 'openai', // 'openai' | 'openai-responses' | 'openai-image' | 'gemini' | 'claude' | 'openclaw'
    endpoints: {
        openai: '',
        'openai-image': '',
        gemini: '',
        claude: ''
    },
    apiKeys: {
        openai: '',
        'openai-image': '',
        gemini: '',
        claude: ''
    },
    customModels: {
        openai: '',
        'openai-image': '',
        gemini: '',
        claude: ''
    },
    customHeaders: [],

    // 提供商管理
    providers: [], // 提供商列表
    currentProviderId: null, // 当前使用的提供商 ID
    selectedModel: '', // 当前选中的模型ID（从下拉列表）

    // 模型参数
    modelParams: {
        openai: {
            temperature: null,
            max_tokens: null,
            top_p: null,
            frequency_penalty: null,
            presence_penalty: null
        },
        'openai-image': {
            size: null,
            customSize: '',
            quality: null,
            output_format: null,
            output_compression: null,
            background: null,
            moderation: null,
            input_fidelity: null,
            n: 1,
            partial_images: 0
        },
        gemini: {
            temperature: null,
            maxOutputTokens: null,
            topP: null,
            topK: null
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
    thinkingNoneMode: false, // 关闭时是否发送 none（Responses API 模式）
    claudeAdaptiveThinking: false, // Claude adaptive thinking 模式
    claudeEffortLevel: 'high', // Claude adaptive effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
    claudeShowThinking: true, // 是否显式请求返回思考摘要（display: summarized）
    webSearchEnabled: false,
    monitorEnabled: false,
    geminiApiKeyInHeader: false,
    prefillEnabled: true,

    // 输出详细度配置
    verbosityEnabled: false, // 是否启用输出详细度控制
    outputVerbosity: 'medium', // 'low' | 'medium' | 'high'

    // Code Execution 开关
    codeExecutionEnabled: false, // 代码执行功能（支持 Gemini、OpenAI、Claude）

    // Computer Use 开关和配置（仅 Electron 环境）
    computerUseEnabled: false, // 计算机控制功能（仅 Claude + Electron）
    computerUsePermissions: {
        mouse: true, // 允许鼠标控制
        keyboard: true, // 允许键盘控制
        screenshot: true, // 允许屏幕截图
        bash: true, // 允许执行 Bash 命令
        textEditor: true // 允许编辑文件
    },
    bashConfig: {
        workingDirectory: '', // 默认工作目录（空表示应用根目录）
        timeout: 30, // 超时时间（秒）
        requireConfirmation: true // 是否需要用户确认
    },

    // 工具调用兜底
    xmlToolCallingEnabled: false, // XML 工具调用兜底（兼容不支持原生 tools 的后端）

    // 配置管理
    savedConfigs: [],
    currentConfigName: '',
    pendingModelSelection: null,

    // 文件夹管理
    folders: [],

    // 会话管理
    sessions: [],
    currentSessionId: null,
    isSwitchingSession: false, // 防止会话切换竞态条件
    backgroundTasks: new Map(),
    // 乐观锁：跟踪每个 session 本 tab 已知的最新 IDB updatedAt。saveSessionAtomic 写入前对比，
    // 不匹配说明另一 tab 已抢先写入，本次写入退避并触发 storage:conflict 让 UI 提示用户
    _lastKnownSessionUpdatedAt: new Map(), // Map<sessionId, number>

    // 多回复生成
    replyCount: 1,
    currentReplies: [],
    selectedReplyIndex: 0,

    // 工具调用历史
    toolCallHistory: [], // 工具调用历史记录
    maxToolHistorySize: 100, // 最大历史记录数
    toolHistoryEnabled: true, // 是否启用历史记录

    // 工具调用权限
    toolPermissions: {
        enabled: false, // 是否启用权限系统
        mode: 'whitelist', // 'whitelist' | 'blacklist'
        whitelist: [], // 白名单（仅允许列表中的工具）
        blacklist: [], // 黑名单（禁止列表中的工具）
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

    // 统一预设系统
    prefillPresets: [],
    activePrefillPresetId: null,

    // 防抖控制
    isSending: false,
    sendLockTimeout: null,

    // 快捷消息
    quickMessages: [],
    quickMessagesCategories: ['常用', '问候', '告别'],

    // MCP 配置（Model Context Protocol）
    mcpServers: [], // MCP 服务器列表
    tools: [] // 工具列表（内置 + MCP + 自定义）
};

// 立即初始化 messageStore，让其持有 _rawState.messages 的引用
// state-mutations 12 mutator 内部全部走 store API，store 内部 splice 原地改保持引用稳定
_rawState.messageStore = new MessageStore(_rawState.messages);
// messageIdMap 暴露 store 的私有 idMap 作为只读 alias（双轨期兼容旧消费方）
_rawState.messageIdMap = _rawState.messageStore.idMap;

// ========== Proxy 响应式包装 ==========

let _batchDepth = 0;
let _batchedChanges = [];

/**
 * 发射属性变更事件
 * 事件名与 state-mutations.js 的 setState() 一致
 */
function _emitChange(key, oldValue, newValue) {
    eventBus.emit(`state:${String(key)}`, { oldValue, newValue });
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

        // messages 数组禁止整体替换：会让 messageStore 持有的旧引用悬空
        // 旧代码 state.messages = newArr 自动转走 store.replaceAll 保持引用稳定
        if (prop === 'messages' && target.messageStore && Array.isArray(value)) {
            target.messageStore.replaceAll(value);
            // store.replaceAll 内部 splice 原地改，target.messages 引用未变，emit 通知消费方
            if (_batchDepth > 0) {
                _batchedChanges.push({ key: prop, oldValue: old, newValue: target.messages });
            } else {
                _emitChange(prop, old, target.messages);
            }
            return true;
        }

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
        if (!(prop in target)) return true; // 不存在的属性 delete 不发事件
        delete target[prop];
        // 与 set 路径对称：batch 内收集到 _batchedChanges，batch 结束统一 emit；
        // 否则订阅者收不到 `batch(() => delete state.x)` 内的删除通知
        if (_batchDepth > 0) {
            _batchedChanges.push({ key: prop, oldValue: old, newValue: undefined });
        } else {
            _emitChange(prop, old, undefined);
        }
        return true;
    }
});

// ========== 公共 API ==========

// 重新导出 elements（便于其他模块导入）
export { elements } from './elements.js';

/**
 * 获取当前状态对象引用
 * @returns {Object} 响应式 state 对象
 */
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
