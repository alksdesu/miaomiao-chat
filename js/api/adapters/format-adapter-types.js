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
 */

/**
 * @typedef {Object} PrefillContext
 * @property {Array} opening   getOpeningMessages(format) 输出
 * @property {Array} trailing  getPrefillMessages(format) 输出
 */

/**
 * @typedef {Object} GenerationParams
 * adapter.buildGenerationParams 输出，请求发出前固化在 requestProfile 中，工具续作复用
 * @property {Object}      modelParams   采样与长度参数（wire 字段名）
 * @property {Object|null} thinkingCfg   推理配置，由 buildRequestBody 合并进请求体
 * @property {Object|null} verbosityCfg  输出详细度配置
 * @property {import('../request-notices.js').RequestNotice[]} [notices]
 *     按能力表丢弃或改写了用户设置时的提示，pipeline 按会话去重后弹出
 */

/**
 * @typedef {Object} RequestBodyContext
 * @property {Array}    messages       adapter.partsToAPIMessages 输出
 * @property {string}   model          模型 ID
 * @property {Object}   modelParams    GenerationParams.modelParams
 * @property {Object|null} thinkingCfg GenerationParams.thinkingCfg
 * @property {Object|null} verbosityCfg GenerationParams.verbosityCfg
 * @property {SystemContext} systemCtx
 * @property {PrefillContext|null} prefill
 * @property {Array}    tools          pipeline 收集到的工具列表
 * @property {boolean}  isXmlMode      state.xmlToolCallingEnabled 快照
 * @property {Object}   profile        resolveModelProfile 输出（模型能力约束）
 * @property {Object|null} capabilities 用户在模型编辑里设置的能力（图片输入 / 输出）
 * @property {Object|null} formatSettings adapter.captureFormatSettings 输出
 * @property {Object}   state          requestProfile.state 通用开关快照
 * @property {string}   endpoint       用户配置的原始端点
 * @property {Object|null} computerDisplay 需要声明显示器尺寸的 computer 工具所用的截图尺寸，
 *     pipeline 每个任务取一次；没有这类工具或取不到时为 null
 * @property {import('../request-notices.js').RequestNotice[]} notices
 *     组装请求体时按能力表丢弃或改写内容（工具、末尾预填充等）就追加一条提示
 */

/**
 * @typedef {Object} ParsedReply
 * 非流式响应解析结果（与原 parseApiResponse 返回形状等价）。
 * 各家字段不同，含 toolCalls/content/thinkingContent/contentParts 等中间字段，
 * 由 handler 传给 buildPartsFromStreamingState 转 parts[]。
 * stop 为归一后的结束原因（messages/stop-reason.js）；没有正文时返回 `{content: '', stop}`，
 * 由 handler 按空回复落错误消息。
 */

/**
 * @typedef {Object} FormatAdapter
 *
 * 元数据
 * @property {string} name           日志前缀（'OpenAI Chat' / 'Claude' / 'Gemini' / ...）
 * @property {string} apiFormat      provider.apiFormat 匹配键
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
 *     可将 system/prefill/tools 设为 false，跳过聊天格式专属管线。
 *
 * 流式层
 * @property {Function} parserClass  BaseStreamParser 子类引用（如 ClaudeStreamParser）
 * @property {Function} streamParser
 *     流式解析入口函数 (reader, sessionId, sink?) => Promise<BaseStreamParser>
 *     format 由 adapter 内部注入；sink 缺省走 DefaultSink（写 state.messages + 渲染全局 UI），
 *     多流路径由 multi-stream.js 注入 BufferedSink 静音 commit + UI。
 *
 * 消息层
 * @property {(msgs: Array, opts?: {injectReasoning?: boolean, isXmlMode?: boolean, profile?: Object, declaredTools?: Array}) => Array} partsToAPIMessages
 *     新格式消息数组 → API 原生消息数组（含 XML 模式 tool_result 追加 user 消息）；
 *     收到的消息已由 pipeline 按模型能力处理过历史图片，profile 为当前型号的能力表，
 *     declaredTools 为本次请求实际下发的原生工具（XML 模式为空），历史调用据此决定能否原样回放
 * @property {(data: Object, options?: {isXmlMode?: boolean}) => ParsedReply|null} parseResponse
 *     非流式响应解析；isXmlMode 取自 requestProfile，缺省按原生工具协议解析
 *
 * 请求构造层
 * @property {(state: Object, ctx: {profile: Object, notices?: import('../request-notices.js').RequestNotice[]}) => Array} collectBuiltinTools
 *     code_execution / web_search / computer_use 三家 schema 不同的内置工具，工具版本按能力表选择；
 *     XML 模式下服务端工具无法通过提示词调用，不返回并提示
 * @property {(systemTools: Array) => Array} formatSystemTools
 *     getToolsForAPI 返回的系统工具列表的最终包装（Gemini 独有 functionDeclarations）
 * @property {(settings: import('../params.js').GenerationSettings, ctx: {model: string, profile: Object, nativeTools: boolean}) => GenerationParams} buildGenerationParams
 *     设置面板的采样 / 推理 / 详细度快照 → 自家 wire 字段，按能力表约束到该型号接受的取值；
 *     nativeTools 表示请求会带原生工具（XML 模式下工具写进提示词，不算）
 * @property {(state: Object) => Object} [captureFormatSettings]
 *     格式专属设置快照（Gemini 的 API Key 传递方式、出图尺寸、多段 system parts）
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
