/**
 * 多回复与客户端工具互斥：多回复的并发流不执行工具调用。
 * 联网搜索、代码执行由服务端执行，不经客户端工具续作，不计入
 */

import { state } from '../core/state.js';
import { eventBus } from '../core/events.js';
import { getToolStats } from '../tools/manager.js';
import { isElectron } from '../utils/platform.js';
import { logger } from '../utils/logger.js';

/**
 * @returns {string} 已启用的客户端工具描述，没有时为空字符串
 */
export function describeEnabledClientTools() {
    const enabledTools = [];
    try {
        const { enabled } = getToolStats();
        if (enabled > 0) enabledTools.push(`${enabled} 个工具`);
    } catch (error) {
        logger.warn('[MultiReplyTools] 工具系统未加载:', error);
    }
    // computer 工具在工具管理里隐藏不计数，Claude 原生的 computer / bash / text_editor 也由这个开关决定
    if (state.computerUseEnabled && isElectron()) enabledTools.push('Computer Use');
    return enabledTools.join('、');
}

/**
 * 多回复数量大于 1 时拒绝开启 Computer Use 并提示；只有桌面端的 Computer Use 会产生工具调用
 * @returns {boolean} 是否拒绝
 */
export function rejectComputerUseForMultiReply() {
    if (!(state.replyCount > 1) || !isElectron()) return false;
    // ui:notification 经 textContent 纯文本渲染，禁止拼接 getIcon 等 HTML 字符串
    eventBus.emit('ui:notification', {
        message: `多回复模式与工具调用功能互斥\n\n当前多回复数量为 ${state.replyCount}，请先将其设为 1 后再开启 Computer Use。`,
        type: 'error',
        duration: 6000
    });
    return true;
}
