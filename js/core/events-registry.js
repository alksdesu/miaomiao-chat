/**
 * 事件名常量集中表
 * EventBus 用 KNOWN_EVENTS 做 typo 检测，新增事件需在此登记。
 */

export const EVENTS = Object.freeze({
    // API 请求生命周期
    API_SEND_REQUESTED: 'api:send-requested',
    API_RESEND_REQUESTED: 'api:resend-requested',
    API_CANCEL_REQUESTED: 'api:cancel-requested',

    // Config 持久化与同步
    CONFIG_FORMAT_CHANGE_REQUESTED: 'config:format-change-requested',
    CONFIG_LOADED: 'config:loaded',
    CONFIG_SYNC_CUSTOM_HEADERS: 'config:sync-custom-headers',
    CONFIG_SYNC_PREFILL_UI: 'config:sync-prefill-ui',
    CONFIG_SYNC_QUICK_TOGGLES: 'config:sync-quick-toggles',

    // DevTools 内置面板
    DEVTOOLS_SHOW: 'devtools:show',
    DEVTOOLS_TOGGLE: 'devtools:toggle',

    // 输入框 / 编辑器
    EDITOR_MODE_CHANGED: 'editor:mode-changed',
    EDITOR_REFRESH_ATTACHMENTS: 'editor:refresh-attachments',
    EDITOR_RESIZE_TEXTAREA: 'editor:resize-textarea',

    // 文件夹
    FOLDERS_CHANGED: 'folders:changed',

    // MCP 连接与工具发现
    MCP_CONNECTED: 'mcp:connected',
    MCP_CONNECTION_LOST: 'mcp:connection-lost',
    MCP_DISCONNECTED: 'mcp:disconnected',
    MCP_RECONNECT_FAILED: 'mcp:reconnect-failed',
    MCP_RESTART_LIMIT_EXCEEDED: 'mcp:restart-limit-exceeded',
    MCP_RETRY_ATTEMPT: 'mcp:retry-attempt',
    MCP_SERVER_RESTART_FAILED: 'mcp:server-restart-failed',
    MCP_SERVER_RESTARTED: 'mcp:server-restarted',
    MCP_SERVER_RESTARTING: 'mcp:server-restarting',
    MCP_TOOLS_DISCOVERED: 'mcp:tools-discovered',

    // 单条消息生命周期
    MESSAGE_CONTENT_UPDATED: 'message:content-updated',
    MESSAGE_COPY_REQUESTED: 'message:copy-requested',
    MESSAGE_DELETE_REQUESTED: 'message:delete-requested',
    MESSAGE_EDIT_REQUESTED: 'message:edit-requested',
    MESSAGE_QUOTE_REQUESTED: 'message:quote-requested',
    MESSAGE_RETRY_REQUESTED: 'message:retry-requested',
    MESSAGES_CHANGED: 'messages:changed',

    // 模型列表
    MODELS_FETCH_REQUESTED: 'models:fetch-requested',

    // 内置 Network 面板
    NETWORK_REPLAY_REQUEST: 'network:replay-request',
    NETWORK_STORE_CHANGED: 'network:store-changed',

    // OpenClaw 子协议
    OPENCLAW_AGENT_EVENT: 'openclaw:agent-event',
    OPENCLAW_APPROVAL_REQUESTED: 'openclaw:approval-requested',
    OPENCLAW_CHAT_DELTA: 'openclaw:chat-delta',
    OPENCLAW_CHAT_DONE: 'openclaw:chat-done',
    OPENCLAW_CONNECTED: 'openclaw:connected',
    OPENCLAW_CRON_EVENT: 'openclaw:cron-event',
    OPENCLAW_DISCONNECTED: 'openclaw:disconnected',
    OPENCLAW_ERROR: 'openclaw:error',
    OPENCLAW_SCREEN_CAPTURE: 'openclaw:screen-capture',

    // 提供商
    PROVIDERS_ADDED: 'providers:added',
    PROVIDERS_DELETED: 'providers:deleted',
    PROVIDERS_MODELS_CHANGED: 'providers:models-changed',
    PROVIDERS_SWITCHED: 'providers:switched',
    PROVIDERS_UPDATED: 'providers:updated',

    // 快捷消息
    QUICKMSG_MODAL_CLOSE_REQUESTED: 'quickmsg:modal-close-requested',
    QUICKMSG_UPDATED: 'quickmsg:updated',

    // 多回复
    REPLY_SELECT_REQUESTED: 'reply:select-requested',

    // 会话恢复阶段
    RESTORE_DISABLE_VIRTUAL_SCROLL: 'restore:disable-virtual-scroll',
    RESTORE_INIT_VIRTUAL_SCROLL: 'restore:init-virtual-scroll',
    RESTORE_TOOL_CALLS: 'restore:tool-calls',
    LONG_CHAT_RENDERING_MODE_CHANGED: 'long-chat:rendering-mode-changed',

    // 会话搜索索引
    SESSION_SEARCH_INDEX_UPDATED: 'session-search:index-updated',

    // 会话生命周期
    SESSION_BEFORE_SWITCH: 'session:before-switch',
    SESSION_MONITOR_READY: 'session:monitor-ready',
    SESSION_SWITCH_REQUESTED: 'session:switch-requested',
    SESSION_SWITCHED: 'session:switched',
    SESSIONS_LOADED: 'sessions:loaded',
    SESSIONS_SEARCH_STATE_CHANGED: 'sessions:search-state-changed',
    SESSIONS_UPDATED: 'sessions:updated',

    // 全局 state
    STATE_MESSAGES_REPLACED: 'state:messages-replaced',

    // 存储
    STORAGE_QUOTA_EXCEEDED: 'storage:quota-exceeded',

    // 流式生命周期
    STREAM_COMPLETE: 'stream:complete',
    STREAM_ERROR: 'stream:error',

    // 工具管理 / 工具调用
    TOOL_MANAGER_OPENED: 'tool-manager:opened',
    TOOL_ENABLED_CHANGED: 'tool:enabled:changed',
    TOOL_REGISTERED: 'tool:registered',
    TOOL_REMOVED: 'tool:removed',
    TOOL_STATUS_CHANGED: 'tool:status:changed',
    TOOLS_MANAGE_OPEN: 'tools:manage:open',
    TOOLS_SELECTOR_CLOSED: 'tools:selector:closed',
    TOOLS_SELECTOR_OPENED: 'tools:selector:opened',
    TOOLS_UPDATED: 'tools:updated',

    // 通用 UI 操作
    UI_NOTIFICATION: 'ui:notification',
    UI_OPEN_IMAGE_VIEWER: 'ui:open-image-viewer',
    UI_RESET_INPUT_BUTTONS: 'ui:reset-input-buttons',
    UI_SCROLL_TO_BOTTOM: 'ui:scroll-to-bottom',
    UI_SHOW_CANCEL_BUTTON: 'ui:show-cancel-button',
    UI_UPDATE_IMAGE_PREVIEW: 'ui:update-image-preview'
});

/**
 * 已注册事件名扁平集合（用于 EventBus typo 检测）
 */
export const KNOWN_EVENTS = new Set(Object.values(EVENTS));
