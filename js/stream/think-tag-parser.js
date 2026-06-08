/**
 * <think> 标签解析器
 * 用于提取 DeepSeek 等模型使用的 <think>...</think> 思考内容
 * 支持流式和非流式两种模式
 */

/**
 * 流式 <think> 标签解析器（用于流式响应）
 */
export class ThinkTagParser {
    constructor() {
        this.buffer = ''; // 累积缓冲区
        this.thinkingContent = ''; // 运行时变量，非旧格式字段
        this.isInsideThink = false; // 是否在 <think> 标签内
    }

    /**
     * 处理增量文本
     * @param {string} delta - 新增的文本片段
     * @returns {{ displayText: string, thinkingDelta: string }} 处理结果
     */
    processDelta(delta) {
        this.buffer += delta;

        let displayText = '';
        let thinkingDelta = '';

        // 循环处理，直到无法继续
        while (true) {
            if (this.isInsideThink) {
                // 在 <think> 标签内，寻找 </think>
                const closeIndex = this.buffer.indexOf('</think>');
                if (closeIndex !== -1) {
                    // 找到闭合标签
                    const thinkContent = this.buffer.substring(0, closeIndex);
                    thinkingDelta += thinkContent;
                    this.thinkingContent += thinkContent;
                    this.buffer = this.buffer.substring(closeIndex + 8); // 8 = '</think>'.length
                    this.isInsideThink = false;
                } else {
                    // 没找到闭合标签，检查是否有部分 </think>
                    const potentialClose = this.findPartialClose(this.buffer);
                    if (potentialClose > 0) {
                        // 有完整的思考内容
                        const safeContent = this.buffer.substring(0, potentialClose);
                        thinkingDelta += safeContent;
                        this.thinkingContent += safeContent;
                        this.buffer = this.buffer.substring(potentialClose);
                    } else if (this.buffer.length > 0 && !this.buffer.includes('<')) {
                        // 没有 < 符号，全部是思考内容
                        thinkingDelta += this.buffer;
                        this.thinkingContent += this.buffer;
                        this.buffer = '';
                    }
                    break; // 等待更多数据
                }
            } else {
                // 不在 <think> 标签内，寻找 <think>
                const openIndex = this.buffer.indexOf('<think>');
                if (openIndex !== -1) {
                    // 找到开始标签
                    displayText += this.buffer.substring(0, openIndex);
                    this.buffer = this.buffer.substring(openIndex + 7); // 7 = '<think>'.length
                    this.isInsideThink = true;
                } else {
                    // 没找到开始标签，检查是否有部分 <think>
                    const potentialOpen = this.findPartialOpen(this.buffer);
                    if (potentialOpen > 0) {
                        // 有安全的显示内容
                        displayText += this.buffer.substring(0, potentialOpen);
                        this.buffer = this.buffer.substring(potentialOpen);
                    } else if (!this.buffer.includes('<')) {
                        // 没有 < 符号，全部是显示内容
                        displayText += this.buffer;
                        this.buffer = '';
                    }
                    break; // 等待更多数据
                }
            }
        }

        return { displayText, thinkingDelta };
    }

    /**
     * 查找可能的部分 </think> 标签位置
     */
    findPartialClose(text) {
        const partials = ['<', '</', '</t', '</th', '</thi', '</thin', '</think'];
        for (let i = partials.length - 1; i >= 0; i--) {
            if (text.endsWith(partials[i])) {
                return text.length - partials[i].length;
            }
        }
        return text.length; // 没有部分标签，全部安全
    }

    /**
     * 查找可能的部分 <think> 标签位置
     */
    findPartialOpen(text) {
        const partials = ['<', '<t', '<th', '<thi', '<thin', '<think'];
        for (let i = partials.length - 1; i >= 0; i--) {
            if (text.endsWith(partials[i])) {
                return text.length - partials[i].length;
            }
        }
        return text.length; // 没有部分标签，全部安全
    }

    /**
     * 获取累积的思考内容
     */
    getThinkingContent() {
        return this.thinkingContent;
    }

    /**
     * 流结束时刷新缓冲区
     * @returns {{ displayText: string, thinkingDelta: string }}
     */
    flush() {
        let displayText = '';
        let thinkingDelta = '';

        if (this.isInsideThink) {
            // 未闭合的 <think> 标签，内容作为思考内容
            thinkingDelta = this.buffer;
            this.thinkingContent += this.buffer;
        } else {
            // 正常显示内容
            displayText = this.buffer;
        }

        this.buffer = '';
        return { displayText, thinkingDelta };
    }
}

/**
 * 非流式 <think> 标签解析（用于非流式响应）
 *
 * 支持嵌套 <think>...<think>...</think>...</think>：用深度计数器找匹配的最外层
 * </think>，避免之前 indexOf('</think>') 朴素匹配让外层后半段被泄漏成显示文本。
 *
 * @param {string} text - 要解析的文本
 * @returns {{ displayText: string, thinkingContent: string }} 解析结果
 */
export function parseThinkTags(text) {
    if (!text || typeof text !== 'string') {
        return { displayText: text || '', thinkingContent: '' };
    }

    let displayText = '';
    let thinkingContent = ''; // 运行时变量，非旧格式字段
    let remaining = text;

    while (remaining.length > 0) {
        const openIndex = remaining.indexOf('<think>');
        if (openIndex === -1) {
            displayText += remaining;
            break;
        }
        displayText += remaining.substring(0, openIndex);

        // 从 openIndex+7 开始用深度计数器找匹配的最外层 </think>
        let depth = 1;
        let scan = openIndex + 7;
        let matchedClose = -1;
        while (scan < remaining.length) {
            const nextOpen = remaining.indexOf('<think>', scan);
            const nextClose = remaining.indexOf('</think>', scan);
            if (nextClose === -1) break;
            if (nextOpen !== -1 && nextOpen < nextClose) {
                depth++;
                scan = nextOpen + 7;
            } else {
                depth--;
                if (depth === 0) {
                    matchedClose = nextClose;
                    break;
                }
                scan = nextClose + 8;
            }
        }

        if (matchedClose === -1) {
            // 未闭合，剩余全归 thinking
            thinkingContent += remaining.substring(openIndex + 7);
            break;
        }
        thinkingContent += remaining.substring(openIndex + 7, matchedClose);
        remaining = remaining.substring(matchedClose + 8);
    }

    return { displayText: displayText.trim(), thinkingContent: thinkingContent.trim() };
}
