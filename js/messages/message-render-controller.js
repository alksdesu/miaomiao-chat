import { longChatPerformance } from '../utils/long-chat-performance.js';
import { logger } from '../utils/logger.js';
import { isMessageElementInteractionProtected } from '../utils/message-dom-protection.js';

const FALLBACK_CHUNK_SIZE = 10;
const DEFAULT_DEHYDRATE_DELAY = 1500;

export class MessageRenderController {
    constructor({
        root = null,
        rootMargin = '150% 0px',
        dehydrateDelay = DEFAULT_DEHYDRATE_DELAY
    } = {}) {
        this.root = root;
        this.rootMargin = rootMargin;
        this.dehydrateDelay = dehydrateDelay;
        this.records = new Map();
        this.observer = null;
        this.fallbackTimer = null;
        this.createObserver();
    }

    createObserver() {
        const Observer = globalThis.IntersectionObserver;
        if (typeof Observer === 'undefined' || !this.root) return;
        this.observer = new Observer(
            (entries) => {
                for (const entry of entries) {
                    if (entry.isIntersecting) {
                        this.cancelScheduledDehydrate(entry.target);
                        void this.hydrate(entry.target);
                    } else {
                        this.scheduleDehydrate(entry.target);
                    }
                }
            },
            { root: this.root, rootMargin: this.rootMargin, threshold: 0 }
        );
    }

    reset(root = this.root) {
        this.disconnect();
        this.root = root;
        this.records.clear();
        this.createObserver();
        this.updateMetrics();
    }

    register(messageEl, hydrate, { dehydrate = null, priority = false, pinned = false } = {}) {
        if (!messageEl || typeof hydrate !== 'function') return;
        this.dispose(messageEl);

        const record = {
            hydrate,
            dehydrate: typeof dehydrate === 'function' ? dehydrate : null,
            state: 'pending',
            pinned: Boolean(pinned),
            dehydrateTimer: null
        };
        this.records.set(messageEl, record);
        messageEl.dataset.hydrationState = record.state;

        if (this.observer) this.observer.observe(messageEl);
        if (priority) {
            void this.hydrate(messageEl);
        } else if (!this.observer) {
            this.scheduleFallback();
        }
        this.updateMetrics();
    }

    async hydrate(messageEl) {
        const record = this.records.get(messageEl);
        if (!record || record.state === 'hydrating' || record.state === 'hydrated') return false;

        this.cancelScheduledDehydrate(messageEl);
        record.state = 'hydrating';
        messageEl.dataset.hydrationState = record.state;
        const finish = longChatPerformance.startSpan('messageHydration', {
            messageId: messageEl.dataset.messageId || ''
        });

        try {
            await record.hydrate();
            record.state = 'hydrated';
            messageEl.dataset.hydrationState = record.state;
            longChatPerformance.increment('hydratedMessages');
            return true;
        } catch (error) {
            record.state = 'failed';
            messageEl.dataset.hydrationState = record.state;
            logger.error('[MessageRenderController] 消息 hydration 失败:', error);
            return false;
        } finally {
            finish();
            this.updateMetrics();
        }
    }

    async dehydrate(messageEl, { force = false } = {}) {
        const record = this.records.get(messageEl);
        if (!record || record.state !== 'hydrated' || !record.dehydrate) return false;
        if (this.isProtected(messageEl, record) && !force) return false;

        this.cancelScheduledDehydrate(messageEl);
        record.state = 'dehydrating';
        messageEl.dataset.hydrationState = record.state;
        const finish = longChatPerformance.startSpan('messageDehydration', {
            messageId: messageEl.dataset.messageId || ''
        });

        try {
            await record.dehydrate();
            record.state = 'dehydrated';
            messageEl.dataset.hydrationState = record.state;
            longChatPerformance.increment('dehydratedMessages');
            return true;
        } catch (error) {
            record.state = 'hydrated';
            messageEl.dataset.hydrationState = record.state;
            logger.error('[MessageRenderController] 消息 dehydration 失败:', error);
            return false;
        } finally {
            finish();
            this.updateMetrics();
        }
    }

    scheduleDehydrate(messageEl) {
        const record = this.records.get(messageEl);
        if (
            !record ||
            record.state !== 'hydrated' ||
            this.isProtected(messageEl, record) ||
            !record.dehydrate
        )
            return;
        if (record.dehydrateTimer !== null) return;
        record.dehydrateTimer = setTimeout(() => {
            record.dehydrateTimer = null;
            void this.dehydrate(messageEl);
        }, this.dehydrateDelay);
    }

    cancelScheduledDehydrate(messageEl) {
        const record = this.records.get(messageEl);
        if (!record || record.dehydrateTimer === null) return;
        clearTimeout(record.dehydrateTimer);
        record.dehydrateTimer = null;
    }

    pin(messageEl) {
        const record = this.records.get(messageEl);
        if (!record) return false;
        record.pinned = true;
        this.cancelScheduledDehydrate(messageEl);
        return true;
    }

    unpin(messageEl) {
        const record = this.records.get(messageEl);
        if (!record) return false;
        record.pinned = false;
        return true;
    }

    isProtected(messageEl, record = this.records.get(messageEl)) {
        if (!messageEl || !record) return false;
        return record.pinned || isMessageElementInteractionProtected(messageEl);
    }

    findElementByMessageId(messageId) {
        if (!messageId) return null;
        for (const messageEl of this.records.keys()) {
            if (messageEl.dataset.messageId === messageId) return messageEl;
        }
        return null;
    }

    pinByMessageId(messageId) {
        const messageEl = this.findElementByMessageId(messageId);
        return messageEl ? this.pin(messageEl) : false;
    }

    unpinByMessageId(messageId) {
        const messageEl = this.findElementByMessageId(messageId);
        return messageEl ? this.unpin(messageEl) : false;
    }

    dispose(messageEl) {
        const record = this.records.get(messageEl);
        if (!record) return false;
        this.cancelScheduledDehydrate(messageEl);
        this.observer?.unobserve(messageEl);
        this.records.delete(messageEl);
        this.updateMetrics();
        return true;
    }

    scheduleFallback() {
        if (this.fallbackTimer !== null) return;
        this.fallbackTimer = setTimeout(async () => {
            this.fallbackTimer = null;
            const elements = Array.from(this.records.entries())
                .filter(([, record]) => record.state === 'pending' || record.state === 'dehydrated')
                .slice(0, FALLBACK_CHUNK_SIZE)
                .map(([element]) => element);
            for (const element of elements) {
                await this.hydrate(element);
            }
            if (this.getPendingCount() > 0) this.scheduleFallback();
        }, 0);
    }

    disconnect() {
        this.observer?.disconnect();
        this.observer = null;
        for (const messageEl of this.records.keys()) {
            this.cancelScheduledDehydrate(messageEl);
        }
        if (this.fallbackTimer !== null) {
            clearTimeout(this.fallbackTimer);
            this.fallbackTimer = null;
        }
    }

    getPendingCount() {
        let pending = 0;
        for (const record of this.records.values()) {
            if (record.state === 'pending' || record.state === 'hydrating') pending += 1;
        }
        return pending;
    }

    updateMetrics() {
        const stats = this.getStats();
        longChatPerformance.setGauge('pendingMessageHydrations', stats.pending);
        longChatPerformance.setGauge('hydratedMessageCount', stats.hydrated);
    }

    getStats() {
        let hydrated = 0;
        let dehydrated = 0;
        let pinned = 0;
        for (const record of this.records.values()) {
            if (record.state === 'hydrated') hydrated += 1;
            if (record.state === 'dehydrated') dehydrated += 1;
            if (record.pinned) pinned += 1;
        }
        return {
            pending: this.getPendingCount(),
            hydrated,
            dehydrated,
            pinned,
            total: this.records.size,
            strategy: this.observer ? 'intersection-observer' : 'chunked-fallback'
        };
    }
}

export const messageRenderController = new MessageRenderController();
