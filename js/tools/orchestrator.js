/**
 * 工具调用编排器
 *
 * 跨层编排：parser 落 tool_call → executor 执行 → writeBack 写回 part.result → handler 重发
 * 与 manager(注册) / executor(执行) / history(审计) 形成 tools 层清晰编排三角。
 *
 * 入口契约：sink/handler 调 handleToolCallStream(toolCalls, {assistantMessageEl, sourceSessionId})
 * 参数注入而非读全局 state，便于纯函数化测试 + 跨会话守卫。
 */

import { logger } from '../utils/logger.js';
import { eventBus } from '../core/events.js';
import { EVENTS } from '../core/events-registry.js';
import { executeTool } from './executor.js';
import { snapshotBeforeToolCall } from './undo.js';
import { createToolCallUI, updateToolCallStatus } from '../ui/tool-display.js';
import { state } from '../core/state.js';
import { updateMessageAt } from '../core/state-mutations.js';
import { requestStateMachine, RequestState } from '../core/request-state-machine.js';
import { TOOL_INLINE_IMAGE_MAX, TOOL_INLINE_IMAGE_TOTAL_MAX } from '../utils/constants.js';
import { validateToolPairings } from '../messages/schema.js';
import { writeToolResultsToBackgroundSession } from '../messages/sync.js';
import { getCurrentProvider, getCurrentActiveApiKey } from '../api/current.js';

// 模块级指针：仅保存"最后一个 in-flight controller"，供 abortToolExecution 外部触发取消
// 所有读 .signal/.aborted 必须走 handleToolCallStream 内的局部 ctrl，杜绝 await 让出后被覆盖/清空的 null 竞态
// （sink.js 非 await 触发 + resend 链路套娃 → 同模块并发两个 handleToolCallStream 确有发生）
let currentAbortController = null;

/**
 * 取消正在进行的工具执行
 */
export function abortToolExecution() {
    currentAbortController?.abort();
}

/**
 * 处理工具返回的多媒体内容
 * 支持MCP标准格式和Claude Code Execution格式
 * @param {Object} result - 工具执行结果
 * @param {string} toolName - 工具名称
 * @returns {Promise<Object>} 增强后的结果
 */
async function enrichToolResultWithFiles(result, toolName) {
    const unwrapResultPayload = (rawResult) => {
        if (!rawResult || typeof rawResult !== 'object') return rawResult;
        if (Array.isArray(rawResult.content)) return rawResult;
        if (rawResult.result && typeof rawResult.result === 'object') return rawResult.result;
        if (Array.isArray(rawResult.result)) return { content: rawResult.result };
        return rawResult;
    };

    const attachConvertedContent = (rawResult, payload, converted) => {
        if (!rawResult || typeof rawResult !== 'object') {
            return { ...(payload || {}), ...(converted || {}) };
        }

        // MCP 客户端常见包裹结构: { success: true, result: {...} }
        if (rawResult.result && typeof rawResult.result === 'object') {
            return {
                ...rawResult,
                ...converted,
                result: {
                    ...rawResult.result,
                    ...converted
                }
            };
        }

        return {
            ...rawResult,
            ...converted
        };
    };

    const normalizedPayload = unwrapResultPayload(result);
    const PERSIST_VIDEO_IPC_TIMEOUT_MS = 30000;
    const persistVideoUrlIfNeeded = async (videoUrl, mimeType = '') => {
        if (!videoUrl || typeof videoUrl !== 'string') return videoUrl;
        if (!videoUrl.startsWith('data:video/')) return videoUrl;
        if (!(typeof window !== 'undefined' && window.electron?.ipcRenderer?.invoke))
            return videoUrl;

        try {
            // IPC hang 兜底：主进程死锁/IPC 通道损坏让 invoke 既不 resolve 也不 reject
            // 整轮工具调用 Promise.all 永挂导致 isToolCallPending 永卡 true 锁死用户输入
            const storeResult = await Promise.race([
                window.electron.ipcRenderer.invoke('mcp:store-video', {
                    dataUrl: videoUrl,
                    mimeType
                }),
                new Promise((_, reject) =>
                    setTimeout(
                        () => reject(new Error('mcp:store-video IPC 超时')),
                        PERSIST_VIDEO_IPC_TIMEOUT_MS
                    )
                )
            ]);
            if (storeResult?.success && storeResult.fileUrl) {
                return storeResult.fileUrl;
            }
        } catch (error) {
            logger.warn('[Orchestrator] 视频持久化失败，回退 Data URL:', error);
        }

        return videoUrl;
    };

    // 1. 优先处理 MCP 标准 content 数组格式（兼容包装结构）
    if (normalizedPayload && Array.isArray(normalizedPayload.content)) {
        const converted = {};
        const images = [];
        const videos = [];
        const texts = [];
        let hasContent = false;

        logger.debug(`[Orchestrator] 检测到 MCP content 数组格式，开始转换`);

        // 单图 / 总计 双 cap：10 张 19MB 单图各自不超限但累计 190MB
        // 会触发 API 413 或 IDB QuotaExceeded，必须有总体上限兜底
        let cumulativeImageBytes = 0;
        let imageCapTriggered = false;

        for (const item of normalizedPayload.content) {
            // 处理文本内容
            if (item.type === 'text' && item.text) {
                texts.push(item.text);
                hasContent = true;
                logger.debug(`[Orchestrator] 发现文本内容: ${item.text.substring(0, 50)}...`);
            }
            // 处理图片内容
            else if (item.type === 'image' && item.data) {
                const mimeType = item.mimeType || item.media_type || 'image/png';
                // size cap：Claude 单图 30MB / OpenAI 20MB，超限 inline 触发 API 413/400。
                // base64 字节数 ≈ length * 3/4
                const approxBytes = (item.data.length * 3) / 4;
                if (approxBytes > TOOL_INLINE_IMAGE_MAX) {
                    const mb = (approxBytes / 1024 / 1024).toFixed(1);
                    logger.warn(
                        `[Orchestrator] 工具返回图片过大 (${mb}MB)，转为文本占位避免 API 413`
                    );
                    texts.push(`[图片已省略：返回了 ${mb}MB 的图片，超过 API 单图限制]`);
                    hasContent = true;
                } else if (cumulativeImageBytes + approxBytes > TOOL_INLINE_IMAGE_TOTAL_MAX) {
                    if (!imageCapTriggered) {
                        const totalMb = (TOOL_INLINE_IMAGE_TOTAL_MAX / 1024 / 1024).toFixed(0);
                        logger.warn(
                            `[Orchestrator] 累计图片超过 ${totalMb}MB 总上限，后续图片转为文本占位`
                        );
                        imageCapTriggered = true;
                        // 大图占位用户在 UI 看不到原因，emit 提示让用户知道发生了什么
                        eventBus.emit('ui:notification', {
                            message: `工具返回累计图片超过 ${totalMb}MB，部分已替换为文本占位避免 API 错误`,
                            type: 'warning',
                            duration: 6000
                        });
                    }
                    const mb = (approxBytes / 1024 / 1024).toFixed(1);
                    texts.push(`[图片已省略：${mb}MB，本批累计已达上限]`);
                    hasContent = true;
                } else {
                    cumulativeImageBytes += approxBytes;
                    images.push({
                        type: 'image_url',
                        url: `data:${mimeType};base64,${item.data}`
                    });
                    hasContent = true;
                    logger.debug(`[Orchestrator] 🖼️ 发现图片内容，MIME类型: ${mimeType}`);
                }
            } else if (item.type === 'image' && item.url) {
                images.push({
                    type: 'image_url',
                    url: item.url
                });
                hasContent = true;
            }
            // 处理视频内容
            else if (item.type === 'video' && item.data) {
                const mimeType = item.mimeType || item.media_type || item.mime_type || 'video/mp4';
                const rawVideoUrl = `data:${mimeType};base64,${item.data}`;
                const persistedVideoUrl = await persistVideoUrlIfNeeded(rawVideoUrl, mimeType);
                videos.push({
                    type: 'video_url',
                    url: persistedVideoUrl,
                    mimeType
                });
                hasContent = true;
                logger.debug(`[Orchestrator] 🎬 发现视频内容，MIME类型: ${mimeType}`);
            } else if (item.type === 'video' && item.url) {
                const mimeType = item.mimeType || item.media_type || item.mime_type || '';
                const persistedVideoUrl = await persistVideoUrlIfNeeded(item.url, mimeType);
                videos.push({
                    type: 'video_url',
                    url: persistedVideoUrl,
                    mimeType
                });
                hasContent = true;
            }
        }

        // 如果成功转换了内容，返回转换后的结果
        if (hasContent) {
            // 处理文本
            if (texts.length > 0) {
                converted.text = texts.join('\n');
            }

            // 处理图片
            if (images.length === 1) {
                // 单张图片使用 image 字段（向后兼容）
                converted.image = images[0].url;
            } else if (images.length > 1) {
                // 多张图片使用 images 数组
                converted.images = images;
            }

            // 处理视频
            if (videos.length === 1) {
                converted.video = videos[0].url;
                converted.videos = videos;
            } else if (videos.length > 1) {
                converted.videos = videos;
            }

            logger.debug(`[Orchestrator] MCP 格式转换完成:`, {
                hasText: !!converted.text,
                hasImage: !!converted.image,
                imagesCount: images.length,
                videosCount: videos.length
            });

            // 保留原始结果的其他字段，并在 wrapper/result 两层都补充转换字段
            return attachConvertedContent(result, normalizedPayload, converted);
        }
    }

    // 2. 处理 Claude Code Execution 格式（保持原有逻辑）
    if (toolName && toolName.includes('code_execution')) {
        if (result && result.content && typeof result.content === 'object') {
            const content = result.content;

            // 检测 bash_code_execution_result 格式
            if (content.type === 'bash_code_execution_result' && Array.isArray(content.content)) {
                const images = [];

                for (const item of content.content) {
                    // 检测文件输出
                    if (item.type === 'file' && item.file_id) {
                        logger.debug(`[Orchestrator] 🖼️ 检测到 Code Execution 文件输出:`, item);

                        try {
                            // 下载文件
                            const fileData = await downloadClaudeFile(item.file_id);
                            if (fileData) {
                                images.push({
                                    type: 'image_url',
                                    url: `data:${item.file_type || 'image/png'};base64,${fileData}`,
                                    file_id: item.file_id
                                });
                                logger.debug(`[Orchestrator] 文件下载成功: ${item.file_id}`);
                            }
                        } catch (error) {
                            logger.error(`[Orchestrator] ❌ 下载文件失败: ${item.file_id}`, error);
                        }
                    }
                }

                // 如果有图片，添加到结果中
                if (images.length > 0) {
                    return {
                        ...result,
                        images: images // 添加图片数组
                    };
                }
            }
        }
    }

    // 3. 如果都不匹配，返回原始结果
    return result;
}

/**
 * 下载 Claude 文件
 * @param {string} fileId - 文件 ID
 * @returns {Promise<string>} Base64 编码的文件内容
 */
async function downloadClaudeFile(fileId) {
    // 从当前提供商获取 API key，而非硬编码 claude
    const provider = getCurrentProvider();
    const apiKey = provider ? getCurrentActiveApiKey(provider.id) : state.apiKeys?.claude;
    if (!apiKey) {
        throw new Error('Claude API key not found');
    }

    try {
        const response = await fetch(`https://api.anthropic.com/v1/files/${fileId}`, {
            headers: {
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
                'anthropic-beta': 'files-api-2025-04-14',
                'anthropic-dangerous-direct-browser-access': 'true'
            }
        });

        if (!response.ok) {
            throw new Error(`Failed to download file: ${response.status} ${response.statusText}`);
        }

        // 读取文件内容为 ArrayBuffer
        const arrayBuffer = await response.arrayBuffer();

        // 分块转 base64：逐字节字符串拼接是 O(n²)，数 MB 文件会卡死 UI 线程
        const bytes = new Uint8Array(arrayBuffer);
        const CHUNK_SIZE = 0x8000;
        let binary = '';
        for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK_SIZE));
        }

        return btoa(binary);
    } catch (error) {
        logger.error(`[downloadClaudeFile] 下载失败:`, error);
        throw error;
    }
}

/**
 * 执行工具调用并渲染 UI（并行执行版本）
 * @param {Array} toolCalls - 工具调用列表
 * @returns {Promise<Array>} 工具结果列表
 */
export async function executeToolCalls(toolCalls, options = {}) {
    logger.debug(`[Orchestrator] 🔧 并行执行 ${toolCalls.length} 个工具调用`);
    const externalSignal = options.signal || null;

    // 创建撤销快照（在执行工具前）
    try {
        snapshotBeforeToolCall(
            toolCalls.map((tc) => ({
                id: tc.id,
                name: tc.name,
                arguments: tc.arguments
            }))
        );
    } catch (err) {
        logger.warn('[Orchestrator] 创建撤销快照失败:', err);
    }

    // 第一步：为所有工具创建 UI 并发布检测事件
    for (const toolCall of toolCalls) {
        const { id, name, arguments: args } = toolCall;

        logger.debug(`[Orchestrator] 准备执行工具: ${name}`, args);

        // 创建工具调用 UI
        await createToolCallUI({
            id,
            name,
            args
        });
    }

    // 第二步：并行执行所有工具
    const executionPromises = toolCalls.map(async (toolCall) => {
        const { id, name, arguments: args, parseError, parseErrorMessage, rawArguments } = toolCall;

        // 参数 JSON 截断 / 解析失败：跳过 executeTool（用 args={} 调用会让工具误以为参数缺省执行），
        // 直接落 ERROR 让模型看到显式错误提示，避免静默错误结果污染对话
        if (parseError) {
            logger.warn(`[Orchestrator] 跳过解析失败的工具调用: ${name}`, {
                parseErrorMessage,
                rawArguments
            });
            updateToolCallStatus(id, 'failed', {
                error: `参数 JSON 解析失败: ${parseErrorMessage}`,
                errorCode: 'arguments_parse_error',
                toolName: name,
                toolArgs: rawArguments
            });
            return {
                id,
                name,
                result: {
                    error:
                        `Tool "${name}" arguments JSON parse failed: ${parseErrorMessage}. ` +
                        `Raw arguments may be truncated by upstream proxy. ` +
                        `Do NOT retry with the same incomplete arguments. ` +
                        `Please respond to the user about this parameter error.`,
                    is_error: true,
                    original_error: parseErrorMessage,
                    failed_args: rawArguments
                },
                isError: true
            };
        }

        try {
            // 执行工具
            // 使用工具名称查找执行，id 仅用于跟踪和结果回传；signal 透传让 cancelCurrentRequest
            // 真能打断长跑工具（fetch / MCP / bash），否则 abort 后用户必须等工具自己超时
            const result = await executeTool(name, args, { signal: externalSignal });

            logger.debug(`[Orchestrator] 工具执行成功: ${name}`, result);

            // 检测并处理多媒体内容（图片、视频等）
            const enrichedResult = await enrichToolResultWithFiles(result, name);

            // 更新 UI 为成功状态（使用 enriched 结果以正确渲染图片）
            try {
                logger.debug(`[Orchestrator] 准备更新工具UI状态为completed: ${id}`);
                updateToolCallStatus(id, 'completed', { result: enrichedResult });
                logger.debug(`[Orchestrator] 工具UI状态更新完成`);
            } catch (uiError) {
                logger.error(`[Orchestrator] ❌ 更新工具UI失败:`, uiError);
            }

            // 跨格式 id 套件已由 parts-builder 在落 part 时持久化到 part.idMap，
            // 重发时 adapter 直接 select 目标格式槽位，无需运行时预登记

            // 返回格式无关的工具结果
            return {
                id,
                name,
                result: enrichedResult,
                isError: false
            };
        } catch (error) {
            logger.error(`[Orchestrator] ❌ 工具执行失败: ${name}`, error);
            logger.error(`[Orchestrator] 错误详情:`, {
                message: error.message,
                errorName: error.name,
                args: JSON.stringify(args, null, 2)
            });

            // 更新 UI 为失败状态
            updateToolCallStatus(id, 'failed', {
                error: error.message,
                errorCode: error.code,
                toolName: name,
                toolArgs: args
            });

            // 错误语义分级：AbortError / 用户拒绝 是用户主动决策（非工具技术故障），
            // 给 LLM 明确信号避免它把"被中断/被拒"误读为可重试的瞬态故障
            // AbortError：用户点停止 / 切会话 / 超时触发 abortController → DOMException name='AbortError'
            // 用户拒绝：confirmToolExecutionIfRequired 返回 false → executor 抛 Error('用户拒绝执行工具 ...')
            const isAbortError =
                error.name === 'AbortError' ||
                (error instanceof DOMException && error.name === 'AbortError');
            const isUserRejected =
                !isAbortError &&
                typeof error.message === 'string' &&
                error.message.includes('用户拒绝');

            let errorMessage;
            if (isAbortError) {
                errorMessage =
                    `Tool "${name}" was aborted by the user (request cancellation or session switch). ` +
                    `This is not a tool failure. Do NOT retry. ` +
                    `If the user asks again, you may attempt the tool, but otherwise acknowledge the cancellation.`;
            } else if (isUserRejected) {
                errorMessage =
                    `Tool "${name}" was explicitly rejected by the user. ` +
                    `The user does NOT want this tool to run. Do NOT retry this tool call. ` +
                    `Please respond to the user WITHOUT using this tool, ` +
                    `using an alternative approach or asking what the user prefers.`;
            } else if (error.message.includes('Missing required parameter')) {
                errorMessage =
                    `Tool "${name}" call failed due to missing required parameter. ` +
                    `This is a parameter schema issue, not a temporary error. ` +
                    `Do NOT retry this tool call. Please respond to the user explaining the issue. ` +
                    `Error details: ${error.message}`;
            } else if (
                error.message.includes('不存在') ||
                error.message.includes('not found') ||
                error.message.includes('not available')
            ) {
                errorMessage =
                    `Tool "${name}" is not available or not registered. ` +
                    `This tool cannot be used. Do NOT retry this tool. ` +
                    `Please respond to the user WITHOUT using this tool.`;
            } else {
                errorMessage =
                    `Tool "${name}" execution failed: ${error.message}. ` +
                    `This error cannot be fixed by retrying with the same parameters. ` +
                    `Do NOT retry this tool call. Please respond to the user based on this error.`;
            }

            return {
                id,
                name,
                result: {
                    error: errorMessage,
                    is_error: true,
                    original_error: error.message,
                    error_kind: isAbortError
                        ? 'aborted'
                        : isUserRejected
                          ? 'user_rejected'
                          : 'execution_failed',
                    failed_args: args
                },
                isError: true
            };
        }
    });

    // 第三步：等待所有工具执行完成
    const results = await Promise.all(executionPromises);

    logger.debug(`[Orchestrator] 🎉 所有工具执行完成: ${results.length}/${toolCalls.length}`);

    return results;
}

/**
 * 把工具执行结果写回 state.messages 中对应 tool_call part 的 result/state 字段
 *
 * 遍历所有含 tool_call 的 assistant 全量配对（适配多轮 continuation）。
 * toolResults 只包含本轮 id，前几轮 part.id 不在 toolResults 中自然跳过 find 返回 undefined，
 * 因此可安全遍历所有历史 assistant 而不会误覆盖旧轮结果。
 * id 同源（part.id 与 toolResults[].id 都是 parser 落 part 时的原始 id，不参与跨格式映射）。
 * 跨格式 id 套件已由 parts-builder 在落 part 时持久化到 part.idMap，与本函数无关。
 *
 * @internal export 仅供单测访问，业务代码通过 handleToolCallStream 调用
 * @param {Array<{id:string,name:string,result:*,isError:boolean}>} toolResults
 * @returns {number} matched - 成功写回的 part 数量
 */
export function writeToolResultsBackToState(toolResults) {
    let matched = 0;
    for (let i = 0; i < state.messages.length; i++) {
        const msg = state.messages[i];
        if (msg.role !== 'assistant' || !Array.isArray(msg.parts)) continue;
        // 跳过不含 tool_call 的 assistant（pause_turn 后落的纯 thinking、纯文本、被编辑过的消息）
        const hasToolCall = msg.parts.some((p) => p.type === 'tool_call');
        if (!hasToolCall) continue;

        // immutable：构建新 parts 数组而非 in-place 改 part 字段，统一走 updateMessageAt mutator，
        // 确保所有写路径经收敛层，MessageStore 引入后可观察化
        let msgMatched = 0;
        const newParts = msg.parts.map((part) => {
            if (part.type !== 'tool_call') return part;
            // 显式校验 id 非空，避免 find(id==='') 与空 id part 错配
            if (!part.id) return part;
            const r = toolResults.find((x) => x.id && x.id === part.id);
            if (!r) return part;
            msgMatched++;
            return { ...part, result: r.result, state: r.isError ? 'error' : 'done' };
        });
        if (msgMatched > 0) {
            updateMessageAt(i, { parts: newParts });
            matched += msgMatched;
        }
    }
    if (matched === 0 && toolResults.length > 0) {
        logger.warn(
            `[Orchestrator] writeBack: 未匹配任何 tool_call part（toolResults=${toolResults.length}），重发将携带 pending tool_call`
        );
    } else {
        logger.debug(`[Orchestrator] writeBack: matched ${matched}/${toolResults.length} parts`);
    }
    return matched;
}

/**
 * 处理工具调用流（完整流程）
 *
 * 工具结果直接写回最后一条 assistant 消息中对应 tool_call part 的 result/state
 * 字段，重发整个 state.messages 让 adapter 自然展开——不再追加临时消息。
 *
 * 跨会话守卫：sourceSessionId 锁住工具调用发起时的会话，若 currentSessionId 在
 * 工具执行期间已切换，跳过 resend 并通知用户，避免工具结果污染新会话
 *
 * 上下文参数注入：assistantMessageEl / sourceSessionId 由调用方现读现传，
 * 不再隐式读 state.currentAssistantMessage / state.currentSessionId，便于纯函数化测试
 *
 * @param {Array} toolCalls - 工具调用列表
 * @param {Object} [context] - 调用上下文
 * @param {HTMLElement|null} [context.assistantMessageEl] - 助手消息根 DOM（resendWithToolResults 复用）
 * @param {string|null} [context.sourceSessionId] - 工具执行发起时的会话 ID（跨会话守卫）
 * @returns {Promise<void>}
 */
export async function handleToolCallStream(toolCalls, context = {}) {
    logger.debug('[Orchestrator] 🚀 开始工具调用流程');

    // 调用方未传时回退读全局（兼容老调用方 + 测试 happy path）
    const assistantMessageEl =
        context.assistantMessageEl ?? state.currentAssistantMessage?.closest('.message') ?? null;
    if (assistantMessageEl) {
        logger.debug('[Orchestrator] 保存消息元素引用用于 continuation');
    }
    const sourceSessionId = context.sourceSessionId ?? state.currentSessionId;

    // try 外提升：finally 需访问本次调用持有的 ctrl 做自指清理
    // （局部持有 ctrl 而非读模块变量是修 .signal 读到 null 的关键，模块变量随时可能被并发调用覆盖/置空）
    const ctrl = new AbortController();
    currentAbortController = ctrl;

    try {
        // 入口诊断：执行前扫描历史 tool_call 配对状态，孤儿 part 仅日志不阻断
        // （帮助定位多轮 continuation 累积的 pending/running 残留）
        try {
            const v = validateToolPairings(state.messages);
            if (!v.valid) {
                logger.warn('[Orchestrator] 入口检测到 tool_call 孤儿:', v.orphans);
            }
        } catch (e) {
            logger.warn('[Orchestrator] validateToolPairings 调用失败:', e);
        }

        // 1. 执行所有工具调用（透传 signal 让 abortToolExecution 真能打断 fetch/MCP/bash）
        // ctrl 在 try 外提升声明，此处仅消费
        const toolResults = await executeToolCalls(toolCalls, {
            signal: ctrl.signal
        });

        // 执行完成后检查是否被取消
        if (ctrl.signal.aborted) {
            logger.info('[Orchestrator] 工具执行已取消，收口结果后跳过重发');
            // toolResults 已含各工具的取消 result，必须写回收口为 error，
            // 否则 tool_call parts 残留 pending/running 永久转圈
            try {
                if (sourceSessionId !== state.currentSessionId) {
                    await writeToolResultsToBackgroundSession(sourceSessionId, toolResults);
                } else {
                    writeToolResultsBackToState(toolResults);
                }
            } catch (e) {
                logger.error('[Orchestrator] 取消后写回工具结果失败:', e);
            }
            state.isToolCallPending = false;
            // 状态机可能已被当前会话新请求占用，仅归属本请求会话时才重置
            if (requestStateMachine.sessionId === sourceSessionId) {
                requestStateMachine.forceReset({ silent: true });
            }
            eventBus.emit('ui:reset-input-buttons');
            return;
        }

        // 2. 写回 state.messages：把 toolResults 写到对应 tool_call part 的 result/state
        // 跨会话场景：state.messages 已被切换会话替换，writeBack 会找不到对应 part →
        // 改走 IDB 写回原会话，让用户切回时看到完成状态而非永久 pending
        const isCrossSession = sourceSessionId !== state.currentSessionId;
        if (isCrossSession) {
            logger.warn(
                `[Orchestrator] 跨会话: ${sourceSessionId} → ${state.currentSessionId}，写回 IDB 而非前台 state`
            );
            try {
                await writeToolResultsToBackgroundSession(sourceSessionId, toolResults);
            } catch (e) {
                logger.error('[Orchestrator] 跨会话写回 IDB 失败:', e);
            }
            state.isToolCallPending = false;
            // 状态机可能已被当前会话新请求占用，仅归属本请求会话时才重置
            if (requestStateMachine.sessionId === sourceSessionId) {
                requestStateMachine.forceReset({ silent: true });
            }
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                message: '会话切换导致回复中断，请重发获取完整回复',
                type: 'warning'
            });
            eventBus.emit('ui:reset-input-buttons');
            return;
        }

        const matched = writeToolResultsBackToState(toolResults);

        // 部分写回成功（部分孤儿）：不阻断后续 resend，但提示用户存在孤儿
        // matched=0 走下方阻断分支，matched===length 走静默成功
        if (matched > 0 && matched < toolResults.length) {
            eventBus.emit('ui:notification', {
                message: `工具结果部分写回成功 (${matched}/${toolResults.length})，存在孤儿`,
                type: 'warning',
                duration: 4000
            });
        }

        // 3. matched=0 阻断 resend——避免下游 adapter 输出 pending tool_use 无 tool_result
        //    触发 Claude 'tool_use without tool_result' / OpenAI 'function_call without output' 400
        if (matched === 0 && toolResults.length > 0) {
            logger.error('[Orchestrator] writeBack 未匹配任何 part，跳过 resend 防止 API 校验失败');
            state.isToolCallPending = false;
            requestStateMachine.forceReset();
            eventBus.emit('ui:reset-input-buttons');
            eventBus.emit('ui:notification', {
                message: '工具结果写回失败，请检查消息是否被编辑',
                type: 'error'
            });
            return;
        }

        // 4. 发送新请求（state.messages 已含 tool_call.result，adapter.partsToAPIMessages 自然展开）
        //    handler 静态 import orchestrator → orchestrator 反向需 handler.resendWithToolResults，
        //    用动态 import 打破 ESM 循环（resendWithToolResults 与 sendToAPI 同模块绑死无法外迁）
        const { resendWithToolResults } = await import('../api/handler.js');
        await resendWithToolResults(assistantMessageEl);
    } catch (error) {
        logger.error('[Orchestrator] 工具调用流程失败:', error);

        // 将未完成的 tool_call parts 标记为 error，防止下次重发产生孤立 tool_use
        // 与 writeToolResultsBackToState 对称：遍历所有含 tool_call 的 assistant 全量兜底
        // （多轮 continuation 场景下旧轮 part 可能也处于 pending/running，需统一收口为 error）
        // immutable：构建新 parts 走 updateMessageAt，与 writeToolResultsBackToState 同源
        const messages = state.messages || [];
        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            if (msg.role !== 'assistant' || !Array.isArray(msg.parts)) continue;
            const hasToolCall = msg.parts.some((p) => p.type === 'tool_call');
            if (!hasToolCall) continue;
            let touched = false;
            const newParts = msg.parts.map((part) => {
                if (part.type !== 'tool_call') return part;
                if (part.state === 'done') return part; // 保留已成功写入的 result
                touched = true;
                return {
                    ...part,
                    state: 'error',
                    result: { content: error.message, is_error: true }
                };
            });
            if (touched) updateMessageAt(i, { parts: newParts });
        }

        // 清理工具调用标志，防止状态泄漏
        state.isToolCallPending = false;

        // 重置请求状态机，防止永久卡在 TOOL_CALLING 状态
        requestStateMachine.forceReset();

        eventBus.emit('ui:notification', {
            message: `工具调用失败: ${error.message}`,
            type: 'error'
        });

        // 强制重置按钮状态
        eventBus.emit('ui:reset-input-buttons');
    } finally {
        // 仅清自己写入的那个；并发场景下若已被后到者覆盖，保留对方的指针让 abortToolExecution 仍可工作
        if (currentAbortController && currentAbortController === ctrl) {
            currentAbortController = null;
        }
    }
}

/**
 * Claude pause_turn 服务端工具执行后的 continuation
 *
 * 合并 sink.triggerPauseTurnResend + handler.js 非流式 pause_turn 分支两处重复编排，
 * 保证两条路径 catch 行为一致（之前 sink 路径漏 forceReset/ui:reset-input-buttons，
 * 失败时会让状态机锁死在 TOOL_CALLING）
 *
 * @param {HTMLElement|null} assistantMessageEl - 要复用的助手消息根
 * @param {string|null} [sourceSessionId] - 调用时捕获的会话 ID，跨会话守卫
 * @returns {Promise<void>}
 */
export async function startPauseTurnContinuation(assistantMessageEl, sourceSessionId = null) {
    const capturedSessionId = sourceSessionId ?? state.currentSessionId ?? null;
    logger.debug(`[Orchestrator] 开始 pause_turn continuation (session=${capturedSessionId})`);
    requestStateMachine.transition(RequestState.TOOL_CALLING);
    state.isToolCallPending = true;

    try {
        const { resendWithToolResults } = await import('../api/handler.js');
        // 跨会话守卫：await microtask 后 state.currentSessionId 可能已被 switchToSession 改写
        // 不一致时不发起重发，避免把 pause_turn 后续上下文写入另一会话破坏 tool_use/tool_result 配对
        if (capturedSessionId && capturedSessionId !== state.currentSessionId) {
            logger.warn(
                `[Orchestrator] pause_turn 跨会话跳过: source=${capturedSessionId} current=${state.currentSessionId}`
            );
            state.isToolCallPending = false;
            // 状态机可能已被当前会话新请求占用，仅归属本请求会话时才重置
            if (requestStateMachine.sessionId === capturedSessionId) {
                requestStateMachine.forceReset({ silent: true });
            }
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                message: '会话切换导致回复中断，请重发获取完整回复',
                type: 'warning'
            });
            return;
        }
        // assistantMessageEl 在原会话被 restore.js innerHTML='' 清空后已脱离 DOM
        if (assistantMessageEl && !assistantMessageEl.isConnected) {
            logger.warn('[Orchestrator] pause_turn 跳过：assistantMessageEl 已脱离 DOM');
            state.isToolCallPending = false;
            // 状态机可能已被当前会话新请求占用，仅归属本请求会话时才重置
            if (requestStateMachine.sessionId === capturedSessionId) {
                requestStateMachine.forceReset({ silent: true });
            }
            eventBus.emit(EVENTS.UI_NOTIFICATION, {
                message: '会话切换导致回复中断，请重发获取完整回复',
                type: 'warning'
            });
            return;
        }
        await resendWithToolResults(assistantMessageEl);
    } catch (error) {
        logger.error('[Orchestrator] pause_turn continuation 失败:', error);
        state.isToolCallPending = false;
        requestStateMachine.forceReset();
        eventBus.emit('ui:reset-input-buttons');
    }
}
