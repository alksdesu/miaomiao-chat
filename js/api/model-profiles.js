/**
 * 模型能力表：按 apiFormat 与模型 ID 解析请求约束（推理档位、采样参数、预填充、工具版本、出图规格）
 * 运行时计算、不落库；未识别的模型返回宽松默认值，请求与不做型号约束时一致
 */

export const CLAUDE_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
const CLAUDE_EFFORTS_NO_XHIGH = Object.freeze(['low', 'medium', 'high', 'max']);

const GEMINI_ASPECT_STANDARD = Object.freeze([
    '1:1',
    '2:3',
    '3:2',
    '3:4',
    '4:3',
    '4:5',
    '5:4',
    '9:16',
    '16:9',
    '21:9'
]);
const GEMINI_ASPECT_WIDE = Object.freeze([...GEMINI_ASPECT_STANDARD, '1:4', '4:1', '1:8', '8:1']);

// ========== 模型 ID 匹配 ==========

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 按完整片段匹配模型名：允许 "openai/gpt-5.5"、"models/gemini-2.5-pro" 这类前缀，
 * 但 "gpt-5" 不会命中 "gpt-5.5"；excludeSuffixes 排除 -pro / -codex 等参数面不同的变体
 */
function modelToken(base, excludeSuffixes = []) {
    const exclude = excludeSuffixes.length
        ? `(?!-(?:${excludeSuffixes.map(escapeRegExp).join('|')})(?![\\w.]))`
        : '';
    return new RegExp(`(?:^|[/:\\s])${escapeRegExp(base)}(?![\\w.])${exclude}`);
}

const CLAUDE_ID_PATTERN = /claude-(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?!\d)/;

function parseClaudeVersion(modelId) {
    const match = CLAUDE_ID_PATTERN.exec(modelId);
    if (!match) return null;
    const major = Number(match[2]);
    const minor = match[3] ? Number(match[3]) : 0;
    return { family: match[1], version: major * 100 + minor };
}

// ========== Claude ==========

const CLAUDE_BASE = Object.freeze({
    reasoning: {
        modes: ['adaptive', 'budget'],
        alwaysOn: false,
        efforts: null,
        display: true,
        blockBinding: false
    },
    sampling: true,
    assistantPrefill: true,
    computerUse: { type: 'computer_20251124', beta: 'computer-use-2025-11-24' }
});

const COMPUTER_TOOLSET = { type: 'computer_toolset_20260801', beta: null };
const COMPUTER_20251124 = { type: 'computer_20251124', beta: 'computer-use-2025-11-24' };
const COMPUTER_20250124 = { type: 'computer_20250124', beta: 'computer-use-2025-01-24' };

// 5.x / Fable：thinking 始终开启，只认 adaptive；采样参数与末尾 assistant 预填充一律 400
function claudeAdaptiveOnly({ alwaysOn, blockBinding = false, computerUse = COMPUTER_20251124 }) {
    return {
        reasoning: {
            modes: ['adaptive'],
            alwaysOn,
            efforts: CLAUDE_EFFORTS,
            display: true,
            blockBinding
        },
        sampling: false,
        assistantPrefill: false,
        computerUse
    };
}

const CLAUDE_46 = {
    reasoning: {
        modes: ['adaptive', 'budget'],
        alwaysOn: false,
        efforts: CLAUDE_EFFORTS_NO_XHIGH,
        display: true,
        blockBinding: false
    },
    sampling: true,
    assistantPrefill: false,
    computerUse: COMPUTER_20251124
};

function claudeBudgetOnly(computerUse) {
    return {
        reasoning: {
            modes: ['budget'],
            alwaysOn: false,
            efforts: null,
            display: false,
            blockBinding: false
        },
        sampling: true,
        assistantPrefill: true,
        computerUse
    };
}

// 同一 family 内按版本降序，首个 version >= min 的规则命中
const CLAUDE_RULES = [
    {
        id: 'claude-fable-5-1',
        family: 'fable',
        min: 501,
        profile: claudeAdaptiveOnly({ alwaysOn: true, blockBinding: true })
    },
    {
        id: 'claude-fable-5',
        family: 'fable',
        min: 500,
        profile: claudeAdaptiveOnly({ alwaysOn: true })
    },
    {
        id: 'claude-mythos-5-1',
        family: 'mythos',
        min: 501,
        profile: claudeAdaptiveOnly({ alwaysOn: true })
    },
    {
        id: 'claude-mythos-5',
        family: 'mythos',
        min: 500,
        profile: claudeAdaptiveOnly({ alwaysOn: true })
    },
    {
        id: 'claude-opus-5-5',
        family: 'opus',
        min: 505,
        profile: claudeAdaptiveOnly({
            alwaysOn: true,
            blockBinding: true,
            computerUse: COMPUTER_TOOLSET
        })
    },
    {
        id: 'claude-opus-5',
        family: 'opus',
        min: 500,
        profile: claudeAdaptiveOnly({ alwaysOn: true })
    },
    {
        id: 'claude-opus-4-8',
        family: 'opus',
        min: 408,
        profile: claudeAdaptiveOnly({ alwaysOn: false })
    },
    {
        id: 'claude-opus-4-7',
        family: 'opus',
        min: 407,
        profile: claudeAdaptiveOnly({ alwaysOn: false })
    },
    { id: 'claude-opus-4-6', family: 'opus', min: 406, profile: CLAUDE_46 },
    {
        id: 'claude-opus-4-5',
        family: 'opus',
        min: 405,
        profile: claudeBudgetOnly(COMPUTER_20251124)
    },
    {
        id: 'claude-opus-4-1',
        family: 'opus',
        min: 400,
        profile: claudeBudgetOnly(COMPUTER_20250124)
    },
    {
        id: 'claude-sonnet-5-5',
        family: 'sonnet',
        min: 505,
        profile: claudeAdaptiveOnly({
            alwaysOn: true,
            blockBinding: true,
            computerUse: COMPUTER_TOOLSET
        })
    },
    {
        id: 'claude-sonnet-5',
        family: 'sonnet',
        min: 500,
        profile: claudeAdaptiveOnly({ alwaysOn: true })
    },
    { id: 'claude-sonnet-4-6', family: 'sonnet', min: 406, profile: CLAUDE_46 },
    {
        id: 'claude-sonnet-4-5',
        family: 'sonnet',
        min: 400,
        profile: claudeBudgetOnly(COMPUTER_20250124)
    },
    {
        id: 'claude-haiku-5-5',
        family: 'haiku',
        min: 505,
        profile: claudeAdaptiveOnly({
            alwaysOn: true,
            blockBinding: true,
            computerUse: COMPUTER_TOOLSET
        })
    },
    {
        id: 'claude-haiku-4-5',
        family: 'haiku',
        min: 400,
        profile: claudeBudgetOnly(COMPUTER_20250124)
    }
];

function matchClaudeRule(modelId) {
    const parsed = parseClaudeVersion(modelId);
    if (!parsed) return null;
    return (
        CLAUDE_RULES.find((rule) => rule.family === parsed.family && parsed.version >= rule.min) ||
        null
    );
}

// ========== OpenAI（Chat / Responses 共用） ==========

const OPENAI_BASE = Object.freeze({
    reasoning: { supported: true, efforts: null, defaultEffort: null },
    sampling: 'always',
    chatTools: 'always',
    maxTokensParam: 'max_tokens',
    verbosity: true,
    streamUsage: false,
    // Responses 回放 assistant 消息时带回 phase（commentary / final_answer）
    assistantPhase: false
});

function openaiReasoning(efforts, defaultEffort, overrides = {}) {
    return {
        reasoning: { supported: true, efforts, defaultEffort },
        sampling: 'effort-none',
        chatTools: 'always',
        maxTokensParam: 'max_completion_tokens',
        verbosity: true,
        streamUsage: true,
        assistantPhase: false,
        ...overrides
    };
}

const OPENAI_NON_REASONING = {
    reasoning: { supported: false, efforts: null, defaultEffort: null },
    sampling: 'always',
    chatTools: 'always',
    maxTokensParam: 'max_completion_tokens',
    verbosity: false,
    streamUsage: true,
    assistantPhase: false
};

const EFFORTS_NONE_TO_MAX = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
const EFFORTS_NONE_TO_XHIGH = ['none', 'low', 'medium', 'high', 'xhigh'];

// Astra / 6.1 Sol 不支持 none：采样参数永远被拒，Chat Completions 也不能带工具
const GPT6_STRICT = openaiReasoning(['low', 'medium', 'high', 'xhigh', 'max'], 'medium', {
    sampling: 'never',
    chatTools: 'never',
    assistantPhase: true
});
// 6 Sol / Luna：effort 为 none 时才接受采样参数，Chat Completions 也只在 none 时能带工具
const GPT6_NONE_CAPABLE = openaiReasoning(EFFORTS_NONE_TO_MAX, 'medium', {
    chatTools: 'effort-none',
    assistantPhase: true
});
const GPT56 = openaiReasoning(EFFORTS_NONE_TO_MAX, 'medium', { assistantPhase: true });

const VARIANT_SUFFIXES = ['pro', 'codex', 'chat', 'chat-latest'];

const OPENAI_RULES = [
    { id: 'gpt-6.1-sol', match: modelToken('gpt-6.1-sol', VARIANT_SUFFIXES), profile: GPT6_STRICT },
    { id: 'gpt-6-astra', match: modelToken('gpt-6-astra', VARIANT_SUFFIXES), profile: GPT6_STRICT },
    {
        id: 'gpt-6-sol',
        match: modelToken('gpt-6-sol', VARIANT_SUFFIXES),
        profile: GPT6_NONE_CAPABLE
    },
    {
        id: 'gpt-6-luna',
        match: modelToken('gpt-6-luna', VARIANT_SUFFIXES),
        profile: GPT6_NONE_CAPABLE
    },
    { id: 'gpt-5.6-sol', match: modelToken('gpt-5.6-sol', VARIANT_SUFFIXES), profile: GPT56 },
    {
        id: 'gpt-5.6-terra',
        match: modelToken('gpt-5.6-terra', VARIANT_SUFFIXES),
        profile: GPT56
    },
    { id: 'gpt-5.6-luna', match: modelToken('gpt-5.6-luna', VARIANT_SUFFIXES), profile: GPT56 },
    { id: 'gpt-5.6', match: modelToken('gpt-5.6', VARIANT_SUFFIXES), profile: GPT56 },
    {
        id: 'gpt-5.5',
        match: modelToken('gpt-5.5', VARIANT_SUFFIXES),
        profile: openaiReasoning(EFFORTS_NONE_TO_XHIGH, 'medium', { assistantPhase: true })
    },
    {
        id: 'gpt-5.4',
        match: modelToken('gpt-5.4', VARIANT_SUFFIXES),
        profile: openaiReasoning(EFFORTS_NONE_TO_XHIGH, 'none', { assistantPhase: true })
    },
    {
        id: 'gpt-5.2',
        match: modelToken('gpt-5.2', VARIANT_SUFFIXES),
        profile: openaiReasoning(EFFORTS_NONE_TO_XHIGH, 'none')
    },
    {
        id: 'gpt-5.1',
        match: modelToken('gpt-5.1', VARIANT_SUFFIXES),
        profile: openaiReasoning(['none', 'low', 'medium', 'high'], 'none')
    },
    {
        id: 'gpt-5',
        match: modelToken('gpt-5', VARIANT_SUFFIXES),
        profile: openaiReasoning(['minimal', 'low', 'medium', 'high'], 'medium', {
            sampling: 'never'
        })
    },
    {
        id: 'o-series',
        match: /(?:^|[/:\s])o\d(?:-(?:mini|pro))?(?![\w.])/,
        profile: openaiReasoning(['low', 'medium', 'high'], 'medium', {
            sampling: 'never',
            verbosity: false
        })
    },
    { id: 'gpt-4.1', match: modelToken('gpt-4.1'), profile: OPENAI_NON_REASONING },
    { id: 'gpt-4o', match: modelToken('gpt-4o'), profile: OPENAI_NON_REASONING },
    { id: 'gpt-4-turbo', match: modelToken('gpt-4-turbo'), profile: OPENAI_NON_REASONING }
];

// ========== Gemini ==========

const GEMINI_BASE = Object.freeze({
    // level / budget 以外的 'auto' 表示未识别：沿用按名称推断的旧规则
    thinking: { mode: 'auto', levels: null, budgetRange: null },
    sampling: 'allowed',
    // output 为 null 表示未识别：沿用设置面板的出图配置
    image: { output: null, sizes: null, aspectRatios: null },
    minTimeoutMs: null,
    longDecode: false
});

function geminiText(levels, overrides = {}) {
    return {
        thinking: { mode: 'level', levels, budgetRange: null },
        sampling: 'allowed',
        image: { output: false, sizes: null, aspectRatios: null },
        minTimeoutMs: null,
        longDecode: false,
        ...overrides
    };
}

function geminiBudget(budgetRange) {
    return {
        thinking: { mode: 'budget', levels: null, budgetRange },
        sampling: 'allowed',
        image: { output: false, sizes: null, aspectRatios: null },
        minTimeoutMs: null,
        longDecode: false
    };
}

function geminiImage(thinking, sizes, aspectRatios) {
    return {
        thinking,
        sampling: 'allowed',
        image: { output: true, sizes, aspectRatios },
        minTimeoutMs: null,
        longDecode: false
    };
}

const LEVELS_LMH = ['low', 'medium', 'high'];
const LEVELS_MLMH = ['minimal', 'low', 'medium', 'high'];

// 图片模型与 Lite 变体必须排在同前缀的基础模型之前
const GEMINI_RULES = [
    {
        id: 'gemini-nano-banana-2.1',
        match: modelToken('gemini-nano-banana-2.1'),
        profile: geminiImage(
            { mode: 'level', levels: ['minimal', 'medium', 'high'], budgetRange: null },
            ['1K', '2K', '4K'],
            GEMINI_ASPECT_WIDE
        )
    },
    {
        id: 'gemini-3.1-flash-lite-image',
        match: modelToken('gemini-3.1-flash-lite-image'),
        profile: geminiImage(
            { mode: 'level', levels: ['minimal', 'high'], budgetRange: null },
            ['1K'],
            GEMINI_ASPECT_STANDARD
        )
    },
    {
        id: 'gemini-3.1-flash-image',
        match: modelToken('gemini-3.1-flash-image'),
        profile: geminiImage(
            { mode: 'level', levels: ['low', 'high'], budgetRange: null },
            ['1K', '2K', '4K'],
            GEMINI_ASPECT_WIDE
        )
    },
    {
        id: 'gemini-3-pro-image',
        match: modelToken('gemini-3-pro-image'),
        profile: geminiImage(
            { mode: 'level', levels: ['low', 'high'], budgetRange: null },
            ['1K', '2K', '4K'],
            GEMINI_ASPECT_STANDARD
        )
    },
    {
        id: 'gemini-2.5-flash-image',
        match: modelToken('gemini-2.5-flash-image'),
        profile: geminiImage(
            { mode: 'auto', levels: null, budgetRange: null },
            [],
            GEMINI_ASPECT_STANDARD
        )
    },
    {
        id: 'gemini-4-argon',
        match: modelToken('gemini-4-argon'),
        profile: geminiText(LEVELS_LMH, {
            sampling: 'ignored',
            // 官方要求客户端超时至少 20 分钟
            minTimeoutMs: 20 * 60 * 1000,
            longDecode: true
        })
    },
    {
        id: 'gemini-3.8-flash',
        match: modelToken('gemini-3.8-flash'),
        profile: geminiText(LEVELS_LMH)
    },
    {
        id: 'gemini-3.7-flash',
        match: modelToken('gemini-3.7-flash'),
        profile: geminiText(LEVELS_LMH)
    },
    {
        id: 'gemini-3.6-flash',
        match: modelToken('gemini-3.6-flash'),
        profile: geminiText(LEVELS_MLMH)
    },
    {
        id: 'gemini-3.5-flash-lite',
        match: modelToken('gemini-3.5-flash-lite'),
        profile: geminiText(LEVELS_MLMH)
    },
    {
        id: 'gemini-3.5-flash',
        match: modelToken('gemini-3.5-flash'),
        profile: geminiText(LEVELS_MLMH)
    },
    {
        id: 'gemini-3.1-flash-lite',
        match: modelToken('gemini-3.1-flash-lite'),
        profile: geminiText(LEVELS_MLMH)
    },
    { id: 'gemini-3.1-pro', match: modelToken('gemini-3.1-pro'), profile: geminiText(LEVELS_LMH) },
    { id: 'gemini-3-flash', match: modelToken('gemini-3-flash'), profile: geminiText(LEVELS_MLMH) },
    { id: 'gemini-3-pro', match: modelToken('gemini-3-pro'), profile: geminiText(['low', 'high']) },
    {
        id: 'gemini-2.5-flash-lite',
        match: modelToken('gemini-2.5-flash-lite'),
        profile: geminiBudget([512, 24576])
    },
    {
        id: 'gemini-2.5-flash',
        match: modelToken('gemini-2.5-flash'),
        profile: geminiBudget([0, 24576])
    },
    {
        id: 'gemini-2.5-pro',
        match: modelToken('gemini-2.5-pro'),
        profile: geminiBudget([128, 32768])
    }
];

// ========== OpenAI Image ==========

const IMAGE_BASE = Object.freeze({ qualities: null, inputFidelity: true });

const IMAGE_QUALITIES = ['auto', 'low', 'medium', 'high'];

const IMAGE_RULES = [
    {
        id: 'gpt-image-2.5-sunburst',
        match: modelToken('gpt-image-2.5-sunburst'),
        profile: { qualities: [...IMAGE_QUALITIES, 'xhigh', 'max'], inputFidelity: false }
    },
    {
        id: 'gpt-image-2.5-flare',
        match: modelToken('gpt-image-2.5-flare'),
        profile: { qualities: [...IMAGE_QUALITIES, 'xhigh', 'max'], inputFidelity: false }
    },
    {
        id: 'gpt-image-2',
        match: modelToken('gpt-image-2'),
        profile: { qualities: IMAGE_QUALITIES, inputFidelity: false }
    },
    {
        id: 'gpt-image-1.5',
        match: modelToken('gpt-image-1.5'),
        profile: { qualities: IMAGE_QUALITIES, inputFidelity: true }
    },
    {
        id: 'gpt-image-1-mini',
        match: modelToken('gpt-image-1-mini'),
        profile: { qualities: IMAGE_QUALITIES, inputFidelity: true }
    },
    {
        id: 'gpt-image-1',
        match: modelToken('gpt-image-1'),
        profile: { qualities: IMAGE_QUALITIES, inputFidelity: true }
    }
];

// ========== 解析入口 ==========

const FAMILIES = {
    claude: { base: CLAUDE_BASE, rules: CLAUDE_RULES, find: matchClaudeRule },
    openai: { base: OPENAI_BASE, rules: OPENAI_RULES },
    gemini: { base: GEMINI_BASE, rules: GEMINI_RULES },
    'openai-image': { base: IMAGE_BASE, rules: IMAGE_RULES }
};

const FORMAT_FAMILY = {
    claude: 'claude',
    openai: 'openai',
    'openai-responses': 'openai',
    gemini: 'gemini',
    'openai-image': 'openai-image'
};

function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        Object.values(value).forEach(deepFreeze);
    }
    return value;
}

function mergeProfile(base, overrides) {
    const merged = { ...base };
    for (const [key, value] of Object.entries(overrides || {})) {
        const baseValue = base[key];
        merged[key] =
            value && typeof value === 'object' && !Array.isArray(value) && baseValue
                ? { ...baseValue, ...value }
                : value;
    }
    return merged;
}

function findRule(family, lookupId) {
    if (!lookupId) return null;
    if (family.find) return family.find(lookupId);
    return family.rules.find((rule) => rule.match.test(lookupId)) || null;
}

/**
 * 解析模型能力
 * @param {string} apiFormat
 * @param {string} modelId
 * @param {{ alias?: string|null }} [options] alias 为用户在模型编辑里指定的官方型号，优先于模型 ID
 * @returns {Readonly<Object>} 至少含 id / known / family 三个字段，其余按格式不同
 */
export function resolveModelProfile(apiFormat, modelId, { alias = null } = {}) {
    const familyKey = FORMAT_FAMILY[apiFormat] || null;
    const family = familyKey ? FAMILIES[familyKey] : null;
    if (!family) {
        return deepFreeze({ id: null, known: false, family: familyKey });
    }
    const lookupId = String(alias || modelId || '')
        .trim()
        .toLowerCase();
    const rule = findRule(family, lookupId);
    const profile = mergeProfile(family.base, rule?.profile);
    return deepFreeze({
        ...structuredClone(profile),
        id: rule?.id || null,
        known: !!rule,
        family: familyKey
    });
}

/**
 * 列出某格式可作为别名的官方型号 ID
 * @param {string} apiFormat
 * @returns {string[]}
 */
export function listProfileIds(apiFormat) {
    const family = FAMILIES[FORMAT_FAMILY[apiFormat]];
    if (!family) return [];
    return family.rules.map((rule) => rule.id).filter((id) => id !== 'o-series');
}
