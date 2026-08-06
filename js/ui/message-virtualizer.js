import { longChatPerformance } from '../utils/long-chat-performance.js';
import { logger } from '../utils/logger.js';
import { VariableHeightIndex } from './variable-height-index.js';
import { isMessageElementInteractionProtected } from '../utils/message-dom-protection.js';

const DEFAULT_VIEWPORT_HEIGHT = 800;

export class MessageVirtualizer {
    constructor({
        root,
        renderItem,
        onUnmount = null,
        estimateHeight = 160,
        overscan = 1200
    } = {}) {
        if (!root || typeof renderItem !== 'function') {
            throw new TypeError('MessageVirtualizer 需要 root 与 renderItem');
        }
        this.root = root;
        this.renderItem = renderItem;
        this.onUnmount = onUnmount;
        this.estimateHeight = estimateHeight;
        this.overscan = overscan;
        this.items = [];
        this.heightIndex = new VariableHeightIndex(0, estimateHeight);
        this.mounted = new Map();
        this.range = { start: 0, end: -1 };
        this.scheduledFrame = null;
        this.protectionTimer = null;
        this.topSpacer = null;
        this.bottomSpacer = null;
        this.resizeObserver = null;
        this.boundOnScroll = () => this.scheduleUpdate();
    }

    init(items, { initialIndex = null, estimates = null } = {}) {
        this.destroy();
        this.items = Array.isArray(items) ? items : [];
        this.heightIndex.reset(this.items.length, estimates);
        this.topSpacer = this.createSpacer('virtual-spacer-top');
        this.bottomSpacer = this.createSpacer('virtual-spacer-bottom');
        this.root.replaceChildren(this.topSpacer, this.bottomSpacer);
        this.root.addEventListener('scroll', this.boundOnScroll, { passive: true });
        this.createResizeObserver();

        if (this.items.length === 0) {
            this.updateMetrics();
            return;
        }

        const targetIndex = Number.isInteger(initialIndex)
            ? Math.max(0, Math.min(initialIndex, this.items.length - 1))
            : 0;
        const viewportHeight = this.getViewportHeight();
        this.root.scrollTop = Math.max(
            0,
            Math.min(
                this.heightIndex.prefixSum(targetIndex),
                this.heightIndex.getTotalHeight() - viewportHeight
            )
        );
        this.updateRange(true);
    }

    createSpacer(className) {
        const spacer = document.createElement('div');
        spacer.className = className;
        spacer.setAttribute('aria-hidden', 'true');
        return spacer;
    }

    createResizeObserver() {
        const Observer = globalThis.ResizeObserver;
        if (typeof Observer === 'undefined') return;
        this.resizeObserver = new Observer((entries) => {
            for (const entry of entries) {
                const index = Number.parseInt(entry.target.dataset.messageIndex, 10);
                const height = entry.borderBoxSize?.[0]?.blockSize || entry.contentRect?.height;
                this.updateMeasuredHeight(index, height);
            }
        });
    }

    getViewportHeight() {
        return this.root.clientHeight || DEFAULT_VIEWPORT_HEIGHT;
    }

    calculateRange(scrollTop = this.root.scrollTop) {
        if (this.items.length === 0) return { start: 0, end: -1 };
        const viewportHeight = this.getViewportHeight();
        const startOffset = Math.max(0, scrollTop - this.overscan);
        const endOffset = Math.min(
            this.heightIndex.getTotalHeight(),
            scrollTop + viewportHeight + this.overscan
        );
        return {
            start: Math.max(0, this.heightIndex.findIndexAtOffset(startOffset)),
            end: Math.min(this.items.length - 1, this.heightIndex.findIndexAtOffset(endOffset))
        };
    }

    scheduleUpdate() {
        if (this.scheduledFrame !== null) return;
        const schedule =
            globalThis.requestAnimationFrame || ((callback) => setTimeout(callback, 0));
        this.scheduledFrame = schedule(() => {
            this.scheduledFrame = null;
            this.updateRange();
        });
    }

    updateRange(force = false) {
        const nextRange = this.calculateRange();
        if (!force && nextRange.start === this.range.start && nextRange.end === this.range.end) {
            return;
        }
        this.mountRange(nextRange);
    }

    mountRange(nextRange) {
        let hasProtectedOutsideRange = false;
        for (const [index, element] of this.mounted) {
            if (index >= nextRange.start && index <= nextRange.end) continue;
            if (this.isProtected(element)) {
                hasProtectedOutsideRange = true;
                continue;
            }
            this.unmountIndex(index, element);
        }

        for (let index = nextRange.start; index <= nextRange.end; index += 1) {
            if (!this.mounted.has(index)) this.mountIndex(index);
        }

        this.range = nextRange;
        this.updateSpacers();
        this.updateMetrics();
        this.scheduleProtectionRecheck(hasProtectedOutsideRange);
    }

    scheduleProtectionRecheck(required) {
        if (!required) {
            if (this.protectionTimer !== null) clearTimeout(this.protectionTimer);
            this.protectionTimer = null;
            return;
        }
        if (this.protectionTimer !== null) return;
        this.protectionTimer = setTimeout(() => {
            this.protectionTimer = null;
            this.updateRange(true);
        }, 500);
    }

    mountIndex(index) {
        let element;
        try {
            element = this.renderItem(this.items[index], index);
        } catch (error) {
            logger.error('[MessageVirtualizer] 渲染消息失败:', error);
            return null;
        }
        if (!element) return null;
        element.dataset.messageIndex = String(index);

        const nextIndex = Array.from(this.mounted.keys())
            .filter((mountedIndex) => mountedIndex > index)
            .sort((a, b) => a - b)[0];
        const reference = nextIndex === undefined ? this.bottomSpacer : this.mounted.get(nextIndex);
        this.root.insertBefore(element, reference || this.bottomSpacer);
        this.mounted.set(index, element);
        this.resizeObserver?.observe(element);

        if (!this.resizeObserver) {
            const height = element.getBoundingClientRect().height || element.offsetHeight;
            if (height > 0) this.updateMeasuredHeight(index, height);
        }
        return element;
    }

    unmountIndex(index, element = this.mounted.get(index)) {
        if (!element) return false;
        this.resizeObserver?.unobserve(element);
        this.onUnmount?.(element, this.items[index], index);
        element.remove();
        this.mounted.delete(index);
        return true;
    }

    isProtected(element) {
        if (!element) return false;
        return (
            element.dataset.virtualPinned === 'true' ||
            isMessageElementInteractionProtected(element)
        );
    }

    updateMeasuredHeight(index, height) {
        if (!Number.isInteger(index) || !(height > 0)) return;
        const firstVisible = this.heightIndex.findIndexAtOffset(this.root.scrollTop);
        const delta = this.heightIndex.setHeight(index, height);
        if (delta === 0) return;
        if (index < firstVisible) this.root.scrollTop += delta;
        this.updateSpacers();
        this.updateMetrics();
    }

    updateSpacers() {
        if (!this.topSpacer || !this.bottomSpacer) return;
        const mountedIndices = Array.from(this.mounted.keys()).sort((a, b) => a - b);
        const start = mountedIndices[0] ?? 0;
        const end = mountedIndices.at(-1) ?? -1;
        this.topSpacer.style.height = `${this.heightIndex.prefixSum(start)}px`;
        this.bottomSpacer.style.height = `${Math.max(
            0,
            this.heightIndex.getTotalHeight() - this.heightIndex.prefixSum(end + 1)
        )}px`;

        const fragment = document.createDocumentFragment();
        fragment.appendChild(this.topSpacer);
        let previousIndex = start - 1;
        for (const index of mountedIndices) {
            if (index > previousIndex + 1) {
                const gap = this.createSpacer('virtual-spacer-gap');
                gap.style.height = `${this.heightIndex.rangeSum(previousIndex + 1, index)}px`;
                fragment.appendChild(gap);
            }
            fragment.appendChild(this.mounted.get(index));
            previousIndex = index;
        }
        fragment.appendChild(this.bottomSpacer);
        this.root.replaceChildren(fragment);
    }

    ensureMounted(index) {
        if (!Number.isInteger(index) || index < 0 || index >= this.items.length) return null;
        if (this.mounted.has(index)) return this.mounted.get(index);
        const viewportHeight = this.getViewportHeight();
        const offset = this.heightIndex.prefixSum(index);
        const range = this.calculateRange(Math.max(0, offset - viewportHeight / 2));
        this.mountRange(range);
        return this.mounted.get(index) || null;
    }

    scrollToIndex(index, behavior = 'smooth', block = 'center') {
        const element = this.ensureMounted(index);
        if (!element) return false;
        const viewportHeight = this.getViewportHeight();
        const itemOffset = this.heightIndex.prefixSum(index);
        const itemHeight = this.heightIndex.getHeight(index);
        let top = itemOffset;
        if (block === 'center') top -= Math.max(0, (viewportHeight - itemHeight) / 2);
        if (block === 'end') top -= Math.max(0, viewportHeight - itemHeight);
        top = Math.max(0, top);
        if (typeof this.root.scrollTo === 'function') {
            this.root.scrollTo({ top, behavior });
        } else {
            this.root.scrollTop = top;
        }
        this.updateRange(true);
        return true;
    }

    getElement(index) {
        return this.mounted.get(index) || null;
    }

    getStats() {
        return {
            renderedMessages: this.mounted.size,
            visibleRange: { ...this.range },
            measuredHeights: this.heightIndex.getMeasuredCount(),
            estimatedTotalHeight: this.heightIndex.getTotalHeight()
        };
    }

    updateMetrics() {
        const stats = this.getStats();
        longChatPerformance.setGauge('messageDomCount', stats.renderedMessages);
        longChatPerformance.setGauge('measuredMessageHeights', stats.measuredHeights);
        longChatPerformance.setGauge('estimatedMessageHeight', stats.estimatedTotalHeight);
    }

    destroy() {
        if (this.scheduledFrame !== null) {
            const cancel = globalThis.cancelAnimationFrame || clearTimeout;
            cancel(this.scheduledFrame);
            this.scheduledFrame = null;
        }
        if (this.protectionTimer !== null) {
            clearTimeout(this.protectionTimer);
            this.protectionTimer = null;
        }
        this.root?.removeEventListener('scroll', this.boundOnScroll);
        this.resizeObserver?.disconnect();
        this.resizeObserver = null;
        for (const [index, element] of this.mounted) {
            this.onUnmount?.(element, this.items[index], index);
        }
        this.mounted.clear();
        this.range = { start: 0, end: -1 };
        this.topSpacer = null;
        this.bottomSpacer = null;
    }
}
