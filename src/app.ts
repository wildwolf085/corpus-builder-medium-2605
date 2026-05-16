import { ChildProcess, fork } from "child_process";
import { MultiBar } from "./progress";
import { DatabaseManager } from "./database";
import path from "path";

const wait = (mill: number) => new Promise(resolve => setTimeout(resolve, Math.max(mill, 1000)));

// ─── App ──────────────────────────────────────────────────────────────────────
const NUM_WORKERS = 4;

interface WorkerState {
    process: ChildProcess;
    busy: boolean;
    profileDir: string;
}

const main = async () => {
    const startTime = Date.now();

    const db = new DatabaseManager();

    const totalToProcess = db.getUnprocessedCount();

    const multibar = new MultiBar();
    const bar = multibar.create(totalToProcess, 0, { elapsed: 0, eta: 0, rate: 0 });

    // Reserve terminal space for the bar
    process.stdout.write("\n");
    multibar.start(250);

    const workers: WorkerState[] = [];
    let activeTasks = 0;
    let lastId = 0;
    let workerIdCounter = 0;
    let isShuttingDown = false;
    let idlePollTimer: NodeJS.Timeout | null = null;
    let processedSinceStart = 0;
    let lastUpdateTime = "";

    const fmtTime = (d = new Date()) => `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}:${String(d.getSeconds()).padStart(2,"0")}`;

    const claimNextArticle = (): { id: number; url: string } | undefined => {
        const row = db.getNextArticle(lastId);
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
        bar.payload = { elapsed: elapsedSec, eta, rate, lastUpdate: lastUpdateTime, workers: activeTasks };
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
        let completed = false;

        if (msg?.type === "result") {
            try {
                db.updateHtml(msg.id, msg.html ?? "");
                db.insertImages(msg.imageUrls ?? []);
            } catch (dbErr: any) {
                console.error(`DB write failed for #${msg.id}:`, dbErr.message || dbErr);
            }
            completed = true;
        } else if (msg?.type === "error" && typeof msg.id === "number" && msg.id >= 0) {
            try {
                db.markArticleEmpty(msg.id);
            } catch (dbErr: any) {
                console.error(`DB write failed for #${msg.id}:`, dbErr.message || dbErr);
            }
            completed = true;
        }

        if (completed) {
            processedSinceStart++;
            lastUpdateTime = fmtTime();
            updateBar();
        }

        if (workerState.busy) {
            activeTasks--;
            workerState.busy = false;
        }
        dispatch();
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

    const shutdown = async () => {
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

        setTimeout(() => {
            for (const w of workers) {
                w.process.kill("SIGKILL");
            }
            db.close();
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
