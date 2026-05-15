import path from "path";
import Database from "better-sqlite3";
import { ChildProcess, fork } from "child_process";

const wait = (mill: number) => new Promise(resolve => setTimeout(resolve, Math.max(mill, 1000)));

// ─── Rich inline progress bar (no external deps) ──────────────────────────────
class MultiBar {
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
        // Move cursor up one line per existing bar, then rewrite
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

class SingleBar {
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
        const available = Math.max(0, termWidth - stats.length - 12); // 12 = brackets + padding
        const filled = Math.floor(available * pct);
        const empty = available - filled;
        const bar = "█".repeat(filled) + "░".repeat(empty);
        return `${bar} ${pctStr} ${stats}`;
    }

    private formatStats(): string {
        const { elapsed, eta, rate } = this.payload;
        const parts: string[] = [];
        parts.push(`${String(this.value).padStart(String(this.total).length)}/${this.total}`);
        if (rate != null) parts.push(`${rate.toFixed(2)} it/s`);
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

// ─── App ──────────────────────────────────────────────────────────────────────
const NUM_WORKERS = 10;

interface WorkerState {
    process: ChildProcess;
    busy: boolean;
    profileDir: string;
}

const main = async () => {
    const startTime = Date.now();

    const dbPath = path.resolve(__dirname, "../../medium_consumer.db");
    const db = new Database(dbPath);

    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("cache_size = 1000");

    db.exec(`
        CREATE TABLE IF NOT EXISTS articles (
            id INTEGER PRIMARY KEY,
            title TEXT,
            html TEXT,
            url TEXT,
            tags TEXT,
            author TEXT,
            date TEXT,
            en TEXT,
            base TEXT,
            zh TEXT,
            ko TEXT,
            ru TEXT,
            ja TEXT,
            hi TEXT,
            ar TEXT
        )
    `);

    db.exec(`
        CREATE TABLE IF NOT EXISTS images (
            key TEXT PRIMARY KEY,
            url TEXT,
            data BLOB
        )
    `);

    const stats = db.prepare(`SELECT COUNT(*) AS total FROM articles WHERE html IS NULL`).get() as { total: number } | undefined;
    const totalToProcess = (stats?.total ?? 0);
    const alreadyDone = 0;

    const multibar = new MultiBar();
    const bar = multibar.create(totalToProcess, alreadyDone, { elapsed: 0, eta: 0, rate: 0 });

    // Reserve terminal space for the bar
    for (let i = 0; i < 1; i++) process.stdout.write("\n");
    multibar.start(250);

    const workers: WorkerState[] = [];
    let activeTasks = 0;
    let lastId = 0;
    let workerIdCounter = 0;
    let isShuttingDown = false;
    let idlePollTimer: NodeJS.Timeout | null = null;
    let processedSinceStart = alreadyDone;

    const getArticleStmt = db.prepare(
        `SELECT id, url FROM articles WHERE id > ? AND html IS NULL ORDER BY id LIMIT 1`
    );

    const claimNextArticle = (): { id: number; url: string } | undefined => {
        let row = getArticleStmt.get(lastId) as { id: number; url: string } | undefined;
        if (!row && lastId !== 0) {
            row = getArticleStmt.get(0) as { id: number; url: string } | undefined;
            if (row) lastId = 0;
        }
        if (row) {
            lastId = row.id;
        }
        return row;
    };

    const updateBar = () => {
        const elapsedSec = (Date.now() - startTime) / 1000;
        const rate = elapsedSec > 0 ? processedSinceStart / elapsedSec : 0;
        const remainingItems = totalToProcess - processedSinceStart;
        const eta = rate > 0 ? remainingItems / rate : 0;
        bar.update(processedSinceStart);
        bar.payload = { elapsed: elapsedSec, eta, rate };
    };

    const dispatch = () => {
        if (isShuttingDown) return;

        let assignedAny = false;
        for (const w of workers) {
            if (w.busy) continue;
            const article = claimNextArticle();
            if (!article) break;
            assignedAny = true;
            w.busy = true;
            activeTasks++;
            w.process.send({ type: "task", id: article.id, url: article.url });
        }

        if (!assignedAny && activeTasks === 0) {
            if (!idlePollTimer) {
                idlePollTimer = setTimeout(() => {
                    idlePollTimer = null;
                    dispatch();
                }, 60000);
            }
        } else if (assignedAny && idlePollTimer) {
            clearTimeout(idlePollTimer);
            idlePollTimer = null;
        }
    };

    const onWorkerMessage = (workerState: WorkerState, msg: any) => {
        if (msg?.done || msg?.error) {
            if (workerState.busy) {
                activeTasks--;
                workerState.busy = false;
            }
            if (!msg?.error) {
                processedSinceStart++;
                updateBar();
            }
            dispatch();
        }
    };

    const onWorkerExit = (workerState: WorkerState, code: number | null, signal: string | null) => {
        if (workerState.busy) {
            activeTasks--;
            workerState.busy = false;
        }

        const idx = workers.indexOf(workerState);
        if (idx !== -1) workers.splice(idx, 1);

        if (!isShuttingDown) {
            spawnWorker();
            dispatch();
        }
    };

    const spawnWorker = () => {
        const index = workerIdCounter++;
        const profileDir = path.resolve(__dirname, `../user-${index}`);
        const child = fork(path.resolve(__dirname, "worker.ts"), [], {
            execArgv: ["-r", "ts-node/register/transpile-only"],
        });

        child.send({ type: "init", profileDir });

        const state: WorkerState = { process: child, busy: false, profileDir };
        workers.push(state);

        child.on("message", (msg) => onWorkerMessage(state, msg));
        child.on("exit", (code, signal) => onWorkerExit(state, code, signal));
        child.on("error", () => {});
    };

    for (let i = 0; i < NUM_WORKERS; i++) {
        spawnWorker();
        await wait(5000);
    }

    dispatch();

    const imageDownloader = fork(path.resolve(__dirname, "image_downloader.ts"), [], {
        execArgv: ["-r", "ts-node/register/transpile-only"],
    });

    const shutdown = () => {
        if (isShuttingDown) return;
        isShuttingDown = true;

        multibar.stop();

        if (idlePollTimer) {
            clearTimeout(idlePollTimer);
            idlePollTimer = null;
        }

        for (const w of workers) {
            w.process.kill("SIGTERM");
        }
        imageDownloader.kill("SIGTERM");

        setTimeout(() => {
            for (const w of workers) {
                w.process.kill("SIGKILL");
            }
            imageDownloader.kill("SIGKILL");
            process.exit(1);
        }, 10000).unref();
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
};

try {
    main();
} catch (err) {
    console.error("Fatal error in main:", err);
    process.exit(1);
}
