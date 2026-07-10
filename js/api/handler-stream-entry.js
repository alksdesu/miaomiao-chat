/**
 * 流式响应入口适配
 *
 * 把 response → adapter.streamParser 的样板逻辑（OpenClaw 走 WS 跳过 reader，
 * 其他家校验 body 非 null 后取 reader）从 handler.js 主体抽出。
 */

/**
 * @param {Response} response
 * @param {import('./handler-context.js').HandlerContext} ctx
 */
export async function handleStreamResponse(response, ctx) {
    const { adapter, requestFormat: responseFormat, abortController, sessionId } = ctx;

    // OpenClaw 走 WebSocket 无 reader；其他家校验 body 非 null
    // （代理 200 + Content-Length:0 / HEAD / 204 时 body 为 null，
    // 裸 getReader() 抛 'Cannot read properties of null'，用户看到 TypeError）
    if (responseFormat !== 'openclaw' && !response.body) {
        throw new Error('响应体为空（代理可能返回了空响应）');
    }
    const reader = responseFormat === 'openclaw' ? null : response.body.getReader();

    // adapter.streamParser 统一签名 (reader, sessionId, sink?, signal?)
    // signal 透传到 BaseStreamParser.parse 监听 abort
    await adapter.streamParser(reader, sessionId, null, abortController?.signal || null);
}
