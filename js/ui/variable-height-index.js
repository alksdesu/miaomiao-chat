export class VariableHeightIndex {
    constructor(count = 0, estimate = 160) {
        this.estimate = Math.max(1, Number(estimate) || 160);
        this.reset(count);
    }

    reset(count = 0, estimates = null) {
        this.count = Math.max(0, Number.parseInt(count, 10) || 0);
        this.values = new Float64Array(this.count);
        this.tree = new Float64Array(this.count + 1);
        this.measured = new Uint8Array(this.count);
        for (let index = 0; index < this.count; index += 1) {
            const estimate = Number(estimates?.[index]);
            this.values[index] = estimate > 0 ? estimate : this.estimate;
            this.add(index, this.values[index]);
        }
    }

    add(index, delta) {
        for (let cursor = index + 1; cursor <= this.count; cursor += cursor & -cursor) {
            this.tree[cursor] += delta;
        }
    }

    setHeight(index, height, measured = true) {
        if (!Number.isInteger(index) || index < 0 || index >= this.count) return 0;
        const next = Math.max(1, Number(height) || this.estimate);
        const delta = next - this.values[index];
        if (delta === 0) return 0;
        this.values[index] = next;
        this.measured[index] = measured ? 1 : this.measured[index];
        this.add(index, delta);
        return delta;
    }

    getHeight(index) {
        return index >= 0 && index < this.count ? this.values[index] : 0;
    }

    prefixSum(endExclusive) {
        let cursor = Math.max(0, Math.min(this.count, Number.parseInt(endExclusive, 10) || 0));
        let sum = 0;
        while (cursor > 0) {
            sum += this.tree[cursor];
            cursor -= cursor & -cursor;
        }
        return sum;
    }

    rangeSum(start, endExclusive) {
        return this.prefixSum(endExclusive) - this.prefixSum(start);
    }

    getTotalHeight() {
        return this.prefixSum(this.count);
    }

    getMeasuredCount() {
        let count = 0;
        for (const value of this.measured) count += value;
        return count;
    }

    findIndexAtOffset(offset) {
        if (this.count === 0) return -1;
        const target = Math.max(0, Math.min(Number(offset) || 0, this.getTotalHeight()));
        let index = 0;
        let accumulated = 0;
        let bit = 1;
        while (bit << 1 <= this.count) bit <<= 1;

        for (; bit > 0; bit >>= 1) {
            const next = index + bit;
            if (next <= this.count && accumulated + this.tree[next] <= target) {
                index = next;
                accumulated += this.tree[next];
            }
        }

        return Math.min(index, this.count - 1);
    }
}
