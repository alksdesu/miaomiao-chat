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
