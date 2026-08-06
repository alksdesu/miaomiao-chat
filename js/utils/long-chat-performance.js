const DEFAULT_SAMPLE_LIMIT = 100;

function now() {
    return typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now();
}

function summarize(samples) {
    if (samples.length === 0) {
        return { count: 0, latest: 0, min: 0, max: 0, average: 0, p95: 0 };
    }

    const values = samples.map((sample) => sample.value).sort((a, b) => a - b);
    const total = values.reduce((sum, value) => sum + value, 0);
    const p95Index = Math.min(values.length - 1, Math.ceil(values.length * 0.95) - 1);
    return {
        count: values.length,
        latest: samples[samples.length - 1].value,
        min: values[0],
        max: values[values.length - 1],
        average: total / values.length,
        p95: values[p95Index]
    };
}

export class LongChatPerformanceMonitor {
    constructor({ sampleLimit = DEFAULT_SAMPLE_LIMIT } = {}) {
        this.sampleLimit = sampleLimit;
        this.samples = new Map();
        this.gauges = new Map();
        this.counters = new Map();
        this.longTaskObserver = null;
    }

    startSpan(name, metadata = {}) {
        const startedAt = now();
        let completed = false;
        return (extraMetadata = {}) => {
            if (completed) return 0;
            completed = true;
            const duration = Math.max(0, now() - startedAt);
            this.recordDuration(name, duration, { ...metadata, ...extraMetadata });
            return duration;
        };
    }

    async measureAsync(name, action, metadata = {}) {
        const finish = this.startSpan(name, metadata);
        try {
            return await action();
        } finally {
            finish();
        }
    }

    recordDuration(name, duration, metadata = {}) {
        if (!Number.isFinite(duration) || duration < 0) return;
        const samples = this.samples.get(name) || [];
        samples.push({ value: duration, metadata, timestamp: Date.now() });
        if (samples.length > this.sampleLimit) {
            samples.splice(0, samples.length - this.sampleLimit);
        }
        this.samples.set(name, samples);
    }

    setGauge(name, value) {
        if (!Number.isFinite(value)) return;
        this.gauges.set(name, value);
    }

    increment(name, amount = 1) {
        if (!Number.isFinite(amount)) return;
        this.counters.set(name, (this.counters.get(name) || 0) + amount);
    }

    observeLongTasks() {
        const Observer = globalThis.PerformanceObserver;
        if (
            this.longTaskObserver ||
            typeof Observer === 'undefined' ||
            !Observer.supportedEntryTypes?.includes('longtask')
        ) {
            return false;
        }

        this.longTaskObserver = new Observer((list) => {
            for (const entry of list.getEntries()) {
                this.recordDuration('longTask', entry.duration, { name: entry.name });
            }
        });
        this.longTaskObserver.observe({ entryTypes: ['longtask'] });
        return true;
    }

    disconnect() {
        this.longTaskObserver?.disconnect();
        this.longTaskObserver = null;
    }

    getSnapshot() {
        const durations = {};
        for (const [name, samples] of this.samples) {
            durations[name] = summarize(samples);
        }
        return {
            durations,
            gauges: Object.fromEntries(this.gauges),
            counters: Object.fromEntries(this.counters)
        };
    }

    reset() {
        this.samples.clear();
        this.gauges.clear();
        this.counters.clear();
    }
}

export const longChatPerformance = new LongChatPerformanceMonitor();
