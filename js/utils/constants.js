/**
 * 应用程序全局常量
 */

// ========== 文件大小限制 ==========

/** 最大文件大小限制（20MB） */
export const MAX_FILE_SIZE = 20 * 1024 * 1024;

/** API 提供商文件大小限制 */
export const API_FILE_SIZE_LIMITS = {
    gemini: 20 * 1024 * 1024,
    openai: 20 * 1024 * 1024,
    claude: 20 * 1024 * 1024
};

// ========== 消息限制 ==========

/** 最大 Markdown 渲染长度（防卡顿） */
export const MAX_MARKDOWN_LENGTH = 100000;

/** 单次上传最大附件数量 */
export const MAX_ATTACHMENTS = 10;

/** 自动转换为文档的 token 阈值 */
export const AUTO_DOCUMENT_TOKEN_THRESHOLD = 30000;

// ========== 超时 ==========

/** 图片压缩超时（毫秒） */
export const IMAGE_COMPRESSION_TIMEOUT = 10000;

// ========== XML 工具调用 ==========

/** XML 工具调用最大缓冲区大小（字符） */
export const XML_MAX_BUFFER_SIZE = 50000;

/** XML 单个工具最大内容长度（字符） */
export const XML_MAX_TOOL_CONTENT_LENGTH = 10000;

/** 工具 ID 计数器循环阈值 */
export const TOOL_ID_COUNTER_MAX = 10000;

// ========== 流式/网络 ==========

/** 默认流式空闲超时（毫秒），用户偏好覆盖 state.streamIdleTimeout */
export const STREAM_IDLE_TIMEOUT_DEFAULT = 120000;

/** Responses API（reasoning 模型）空闲超时下限（毫秒） */
export const STREAM_IDLE_TIMEOUT_RESPONSES_MIN = 5 * 60 * 1000;

/** OpenClaw heartbeat 假死检测倍率（lastServerMessageAt 阈值 = tickInterval × 此值） */
export const WS_HEARTBEAT_TIMEOUT_RATIO = 2.5;

// ========== 工具/资源上限 ==========

/** 工具确认对话框默认超时（毫秒），用户不响应自动拒绝 */
export const TOOL_CONFIRM_DIALOG_TIMEOUT = 5 * 60 * 1000;

/** 工具返回单图 inline 上限（字节），超限替换为文本占位避免 API 413 */
export const TOOL_INLINE_IMAGE_MAX = 20 * 1024 * 1024;

/** 工具返回累计图片上限（字节），多图累计超限后续转占位 */
export const TOOL_INLINE_IMAGE_TOTAL_MAX = 50 * 1024 * 1024;

// ========== 导入/导出 ==========

/** 导入备份文件大小上限（字节），防 OOM */
export const IMPORT_FILE_MAX_SIZE = 100 * 1024 * 1024;

// ========== 流式渲染优化 ==========

/** 流式累积字符增量阈值：未到此值跳过 doRender */
export const RENDER_THROTTLE_CHARS = 400;

/** 流式两次 doRender 最小间隔（ms）：未到跳过本帧 */
export const RENDER_THROTTLE_MS = 150;

/** thinking 长度超过此值时启用更大的节流间隔（100k token 整段 reparse 每帧 100-200ms） */
export const THINKING_HEAVY_THRESHOLD_CHARS = 5000;

/** 重 thinking 模式下两次 doRender 最小间隔（ms） */
export const THINKING_HEAVY_RENDER_THROTTLE_MS = 1500;

/** scroll 监听容差：距底部小于此值视为跟随底部 */
export const SCROLL_FOLLOW_THRESHOLD_PX = 120;

/** requestIdleCallback 单帧高亮预算 */
export const STREAMING_FRAME_BUDGET_MS = 12;

/** hljs 单块高亮长度上限，超限降级为纯转义展示（防主线程冻结） */
export const HLJS_MAX_CODE_LENGTH = 50000;

// ========== 工具调用配对/老化 ==========

/** 工具被中断时的统一错误消息（老化超时 / 用户取消 / 流断开） */
export const TOOL_INTERRUPTED_MESSAGE = 'Tool execution was interrupted';

/** 工具结果未写回 state 时的占位消息 */
export const TOOL_RESULT_NOT_SAVED_MESSAGE = '工具结果未保存';

/** pending/running tool_call 老化阈值（毫秒），超时视为孤儿并强制标 ERROR */
export const TOOL_AGE_THRESHOLD_MS = 30 * 60 * 1000;
