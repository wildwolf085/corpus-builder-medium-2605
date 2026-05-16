export class MultiBar {
    private bars: SingleBar[] = [];
    private timer: NodeJS.Timeout | null = null;

    create(total: number, initial = 0, payload: Record<string, any> = {}): SingleBar {
        const bar = new SingleBar(this, total, initial, payload);
        this.bars.push(bar);
        return bar;
    }

    private draw() {
        const termWidth = process.stdout.columns || 80;
        const lines = this.bars.map(b => b.render(termWidth));
        process.stdout.write(this.bars.map(() => "\x1B[1A\x1B[2K").join("") + lines.join("\n") + "\n");
    }

    start(refreshRateMs = 250) {
        this.timer = setInterval(() => this.draw(), refreshRateMs);
    }

    stop() {
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
        this.draw();
    }
}

export class SingleBar {
    public value = 0;
    constructor(
        private readonly container: MultiBar,
        public readonly total: number,
        initial: number,
        public payload: Record<string, any>
    ) {
        this.value = initial;
    }

    increment(amount = 1) {
        this.value += amount;
    }

    update(value: number) {
        this.value = value;
    }

    render(termWidth: number): string {
        const pct = this.total > 0 ? this.value / this.total : 0;
        const pctStr = `${Math.floor(pct * 100)}%`.padStart(3);
        const stats = this.formatStats();
        const available = Math.max(0, termWidth - stats.length - 12);
        const filled = Math.floor(available * pct);
        const empty = available - filled;
        const bar = "█".repeat(filled) + "░".repeat(empty);
        return `${bar} ${pctStr} ${stats}`;
    }

    private formatStats(): string {
        const { elapsed, eta, rate, found, inserted, workers, lastUpdate } = this.payload;
        const parts: string[] = [];
        parts.push(`${String(this.value).padStart(String(this.total).length)}/${this.total}`);
        if (rate != null) parts.push(`${rate.toFixed(2)} it/s`);
        if (found != null) parts.push(`${found} found`);
        if (inserted != null) parts.push(`${inserted} inserted`);
        if (lastUpdate != null) parts.push(`[${lastUpdate}] workers: ${workers ?? 0}`);
        if (elapsed != null) parts.push(`${this.fmtTime(elapsed)}<${this.fmtTime(eta ?? 0)}`);
        return `| ${parts.join(" | ")}`;
    }

    private fmtTime(seconds: number): string {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        if (h > 0) return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
        return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    }
}

export function printProgress(total: number, remaining: number) {
    const downloaded = total - remaining;
    console.log(`Image progress: ${downloaded}/${total} downloaded (${remaining} remaining)`);
}
