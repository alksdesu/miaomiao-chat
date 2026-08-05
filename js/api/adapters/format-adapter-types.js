/**
 * FormatAdapter 接口契约
 *
 * 每家 API 提供商对应一个 plain object adapter，承载该格式的全部差异化逻辑：
 * - 消息层：parts[] → API messages（含 XML 模式 tool_result 追加）、非流式响应解析
 * - 请求层：buildRequestBody / resolveEndpoint / buildHeaders / buildQueryString
 * - 工具层：collectBuiltinTools（code_execution / web_search / computer_use 三家 schema 不同）、
 *           formatSystemTools（Gemini 独有 functionDeclarations 包装）
 * - 流式层：parserClass / streamParser（由 handler 派发到 stream/parser-*.js）
 *
 * 横切关注点（filter / system / prefill / tools 收集）由 js/api/request-pipeline.js 统一编排，
 * adapter 仅实现差异。工具结果通过 part.result 写回 state.messages 自然展开（Stage 3 取消
 * 临时消息架构）；XML 模式由 adapter.partsToAPIMessages 内部按 part.mode 决策，配合
 * js/tools/xml-formatter.js 的 appendXmlToolResults 追加 user 消息。
 */

/**
 * @typedef {Object} SystemContext
 * @property {string|null} systemPrompt       processVariables 之后的最终文本
 * @property {string|null} monitorContext     buildDevToolsContext 输出（启用 monitor 时）
 * @property {Array|null}  geminiSystemParts  仅 Gemini，多段 system 启用时
 */

/**
 * @typedef {Object} PrefillContext
 * @property {Array} opening   getOpeningMessages(format) 输出
 * @property {Array} trailing  getPrefillMessages(format) 输出
 */

/**
 * @typedef {Object} RequestBodyContext
 * @property {Array}    messages       adapter.partsToAPIMessages 输出
 * @property {string}   model          模型 ID
 * @property {Object}   modelParams    buildModelParams 输出
 * @property {Object|null} thinkingCfg buildThinkingConfig 输出
 * @property {Object|null} verbosityCfg buildVerbosityConfig 输出
 * @property {SystemContext} systemCtx
 * @property {PrefillContext|null} prefill
 * @property {Array}    tools          pipeline 收集到的工具列表
 * @property {boolean}  isXmlMode      state.xmlToolCallingEnabled 快照
 * @property {Object}   state          运行时 state 引用（用于读取格式特定开关，如 imageSize、geminiApiKeyInHeader）
 */

/**
 * @typedef {Object} ParsedReply
 * 非流式响应解析结果（与原 parseApiResponse 返回形状等价）。
 * 各家字段不同，含 toolCalls/content/thinkingContent/contentParts 等中间字段，
 * 由 handler 传给 buildPartsFromStreamingState 转 parts[]。
 */

/**
 * @typedef {Object} FormatAdapter
 *
 * 元数据
 * @property {string} name           日志前缀（'OpenAI Chat' / 'Claude' / 'Gemini' / ...）
 * @property {string} apiFormat      provider.apiFormat 匹配键
 * @property {'before'|'after'} filterPosition
 *     capabilities 过滤时机：'before' = partsToAPIMessages 之前过滤 state.messages，
 *     'after' = 之后过滤 adapter 输出。OpenAI 历史行为是 after，其他家是 before；
 *     pipeline 据此选择调用顺序。
 * @property {boolean} [supportsMultiStream]
 *     是否支持并行多回复（multi-stream）。缺省 true；false 时 handler 会将 replyCount 强制降为 1
 *     并发出 UI 提示（典型场景：OpenClaw 的 WebSocket 单连接协议不允许并发拉流）。
 * @property {'claude'|'gemini'|'openai'} [signatureFormat]
 *     thinking part signature 来源标识。非流式 handler 调 buildPartsFromStreamingState 时按
 *     adapter 注入，让 thinking part 携带来源；adapter.partsToAPIMessages 在下发 thinking
 *     block 前校验 part.signatureFormat 与自家匹配，否则跳过签名避免跨家 API 400
 *     invalid_signature。OpenClaw 中转 Claude 协议响应，按 'claude' 处理。
 * @property {boolean} [supportsMultipleReplies]
 *     是否使用全局 replyCount；false 时只发一个请求，由格式专属参数控制输出数量。
 * @property {Object} [requestFeatures]
 *     可将 system/prefill/tools/thinking/verbosity 设为 false，跳过聊天格式专属管线。
 *
 * 流式层
 * @property {Function} parserClass  BaseStreamParser 子类引用（如 ClaudeStreamParser）
 * @property {Function} streamParser
 *     流式解析入口函数 (reader, sessionId, sink?) => Promise<BaseStreamParser>
 *     format 由 adapter 内部注入；sink 缺省走 DefaultSink（写 state.messages + 渲染全局 UI），
 *     多流路径由 multi-stream.js 注入 BufferedSink 静音 commit + UI。
 *
 * 消息层
 * @property {(msgs: Array, opts?: Object) => Array} partsToAPIMessages
 *     新格式消息数组 → API 原生消息数组（含 XML 模式 tool_result 追加 user 消息）
 * @property {(data: Object) => ParsedReply|null} parseResponse
 *     非流式响应解析
 *
 * 请求构造层
 * @property {(state: Object) => Array} collectBuiltinTools
 *     code_execution / web_search / computer_use 三家 schema 不同的内置工具
 * @property {(systemTools: Array) => Array} formatSystemTools
 *     getToolsForAPI 返回的系统工具列表的最终包装（Gemini 独有 functionDeclarations）
 * @property {(ctx: RequestBodyContext) => Object} buildRequestBody
 *     一次性组装最终 requestBody（含 messages/system/tools/params/safetySettings 等所有差异）
 * @property {(baseEndpoint: string, model: string, isStreaming: boolean, requestBody?: Object, ctx?: Object) => string} resolveEndpoint
 *     OpenAI Responses 路径替换 / Gemini Vertex vs AI Studio 端点拼接
 * @property {(apiKey: string, ctx: Object) => Object} buildHeaders
 *     Authorization / x-api-key / x-goog-api-key + Claude beta features
 * @property {(apiKey: string, ctx: Object) => string} buildQueryString
 *     仅 Gemini 用（API key 走 query param 时），其他家返回 ''
 */

// 该模块仅提供类型契约文档，不导出运行时代码
export {};
