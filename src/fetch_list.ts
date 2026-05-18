import fs from "fs";
import { ChildProcess, fork } from "child_process";
import { MultiBar } from "./progress";
import { DatabaseManager } from "./database";
import path from "path";

const NUM_WORKERS = 8;
const AUTHOR_RECHECK_SECONDS = 3 * 86400; // 3 days
const wait = (mill: number) => new Promise(resolve => setTimeout(resolve, Math.max(mill, 1000)));

const logPath = path.resolve(__dirname, "../list.txt");
const formatTimestamp = () => {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${String(d.getFullYear()).slice(2)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

interface Task {
    url: string;
    checked: number;
}

interface WorkerState {
    process: ChildProcess;
    busy: boolean;
    profileDir: string;
    currentTask?: Task;
}

const main = async () => {
    const startTime = Date.now();

    const db = new DatabaseManager();

    const rows = db.getAuthorsToRecheck(AUTHOR_RECHECK_SECONDS);
    const totalToProcess = rows.length;
    if (totalToProcess === 0) {
        console.log("No authors to process.");
        db.close();
        return;
    }

    let processedCount = 0;
    let totalFound = 0;
    let totalInserted = 0;
    let processedIndex = 0;
    let retryQueue: Task[] = [];

    const multibar = new MultiBar();
    const bar = multibar.create(totalToProcess, processedCount, {
        elapsed: 0,
        eta: 0,
        rate: 0,
        found: totalFound,
        inserted: totalInserted,
    });

    process.stdout.write("\n");
    multibar.start(250);

    const workers: WorkerState[] = [];
    let activeTasks = 0;
    let isShuttingDown = false;
    let idlePollTimer: NodeJS.Timeout | null = null;
    let workerIdCounter = 0;
    let lastUpdateTime = "";
    const fmtTime = (d = new Date()) => `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}:${String(d.getSeconds()).padStart(2,"0")}`;

    const updateBar = () => {
        const elapsedSec = (Date.now() - startTime) / 1000;
        const rate = elapsedSec > 0 ? processedCount / elapsedSec : 0;
        const remainingItems = totalToProcess - processedCount;
        const eta = rate > 0 ? remainingItems / rate : 0;
        bar.update(processedCount);
        bar.payload = {
            elapsed: elapsedSec,
            eta,
            rate,
            found: totalFound,
            inserted: totalInserted,
            lastUpdate: lastUpdateTime,
            workers: activeTasks,
        };
    };

    const checkCompletion = () => {
        if (processedIndex >= rows.length && retryQueue.length === 0 && activeTasks === 0) {
            multibar.stop();
            console.log("All authors processed. Exiting.");
            isShuttingDown = true;
            if (idlePollTimer) { clearTimeout(idlePollTimer); idlePollTimer = null; }
            for (const w of workers) {
                try { w.process.kill("SIGTERM"); } catch (e) {}
            }
            db.close();
            process.exit(0);
        }
    };

    const getNextTask = (): Task | undefined => {
        if (retryQueue.length > 0) return retryQueue.shift()!;
        if (processedIndex < rows.length) return rows[processedIndex++];
        return undefined;
    };

    const dispatch = () => {
        if (isShuttingDown) return;

        let assignedAny = false;
        for (const w of workers) {
            if (w.busy) continue;
            const task = getNextTask();
            if (!task) break;
            assignedAny = true;
            w.busy = true;
            w.currentTask = task;
            activeTasks++;
            w.process.send({ type: "task", url: task.url, checked: task.checked });
        }

        if (!assignedAny) {
            if (activeTasks === 0) {
                checkCompletion();
                if (!isShuttingDown && !idlePollTimer) {
                    idlePollTimer = setTimeout(() => {
                        idlePollTimer = null;
                        dispatch();
                    }, 60000);
                }
            }
        } else if (idlePollTimer) {
            clearTimeout(idlePollTimer);
            idlePollTimer = null;
        }
    };

    const onWorkerMessage = (workerState: WorkerState, msg: any) => {
        if (msg?.ready) {
            dispatch();
            return;
        }

        if (msg?.type === "result" || msg?.type === "error") {
            if (workerState.busy) {
                activeTasks--;
                workerState.busy = false;
                workerState.currentTask = undefined;
            }

            if (msg?.type === "result") {
                const articles = msg.articles as Array<{ id: number; title: string; url: string }>;
                let found = articles.length;
                let inserted = 0;

                for (const art of articles) {
                    if (!db.articleExists(art.id)) {
                        db.insertArticle(art.id, art.title, art.url);
                        inserted++;
                    }
                }
                
                db.updateAuthorChecked(msg.url, msg.newUrl, found);

                processedCount++;
                totalFound += found;
                totalInserted += inserted;
                lastUpdateTime = fmtTime();
                fs.appendFileSync(logPath, `[${formatTimestamp()}] ${msg.url} | ${inserted} / ${found}\n`);
                updateBar();
            } else if (msg?.type === "error") {
                const reason = msg.reason || msg.error || "unknown";
                fs.appendFileSync(logPath, `[${formatTimestamp()}] ${msg.url || ""} | ${reason} error\n`);
                processedCount++;
                lastUpdateTime = fmtTime();
                updateBar();
            }
            dispatch();
            checkCompletion();
        }
    };

    const onWorkerExit = (workerState: WorkerState, code: number | null, signal: string | null) => {
        if (workerState.busy) {
            activeTasks--;
            workerState.busy = false;
            if (workerState.currentTask) {
                retryQueue.push(workerState.currentTask);
            }
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
        const profileDir = path.resolve(__dirname, `../profiles/user-list-${index}`);
        const child = fork(path.resolve(__dirname, "fetch_list_worker.ts"), [], {
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
        await wait(2000);
    }

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
