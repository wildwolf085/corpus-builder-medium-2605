import path from "path";
import fs from "fs";
import { ChildProcess, fork } from "child_process";
import { MultiBar } from "../progress";
import { DatabaseManager } from "./database";

const NUM_WORKERS = 4;

interface TopicTask {
    slug: string;
    topic: string;
}

interface Author {
    url: string;
    topic: string;
}

const progressPath = path.resolve(__dirname, "../.fetch_authors_progress");

const readProgress = (): Set<string> => {
    try {
        const data = fs.readFileSync(progressPath, "utf-8");
        return new Set(data.split("\n").map(s => s.trim()).filter(Boolean));
    } catch (e) {
        return new Set<string>();
    }
};

const appendProgress = (slug: string) => {
    fs.appendFileSync(progressPath, slug + "\n");
};

const main = async () => {
    const startTime = Date.now();

    const db = new DatabaseManager();

    const Topics = require("./topics.json") as { [k: string]: string };
    const topicSlugs = Object.keys(Topics);

    const processed = readProgress();
    const queue: TopicTask[] = [];
    for (const slug of topicSlugs) {
        if (processed.has(slug)) continue;
        queue.push({ slug, topic: Topics[slug] });
    }

    if (queue.length === 0) {
        console.log("No topics to process.");
        db.close();
        return;
    }

    const totalTopics = queue.length;
    let processedCount = 0;
    let totalInserted = 0;
    let lastUpdateTime = "";
    const fmtTime = (d = new Date()) => `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}:${String(d.getSeconds()).padStart(2,"0")}`;

    const multibar = new MultiBar();
    const bar = multibar.create(totalTopics, processedCount, {
        elapsed: 0,
        eta: 0,
        rate: 0,
        inserted: totalInserted,
    });

    process.stdout.write("\n");
    multibar.start(250);

    const workers: Array<{ proc: ChildProcess; busy: boolean }> = [];
    let isShuttingDown = false;
    let workerIdCounter = 0;

    const updateBar = () => {
        const elapsedSec = (Date.now() - startTime) / 1000;
        const rate = elapsedSec > 0 ? processedCount / elapsedSec : 0;
        const remainingTopics = totalTopics - processedCount;
        const eta = rate > 0 ? remainingTopics / rate : 0;
        const activeWorkers = workers.filter(w => w.busy).length;
        bar.update(processedCount);
        bar.payload = { elapsed: elapsedSec, eta, rate, inserted: totalInserted, lastUpdate: lastUpdateTime, workers: activeWorkers };
    };

    const tryExit = () => {
        if (queue.length === 0 && workers.every(w => !w.busy)) {
            multibar.stop();
            console.log("All tasks complete. Shutting down workers.");
            isShuttingDown = true;
            for (const w of workers) {
                try { w.proc.kill("SIGTERM"); } catch (e) {}
            }
            db.close();
            process.exit(0);
        }
    };

    const spawnWorker = () => {
        if (isShuttingDown) return;
        const profileDir = path.resolve(__dirname, `../../profiles/user-authors-${workerIdCounter++}`);
        const child = fork(path.resolve(__dirname, "fetch_authors_worker.ts"), [], {
            execArgv: ["-r", "ts-node/register/transpile-only"],
        });
        child.send({ type: "init", profileDir });

        const worker = { proc: child, busy: false };
        workers.push(worker);

        child.on("message", (msg: any) => {
            if (isShuttingDown) return;
            if (msg?.ready) {
                assignNext(worker);
            } else if (msg?.type === "result") {
                const authors = msg.authors as Author[];
                const { inserted } = db.insertAuthors(authors);
                processedCount++;
                totalInserted += inserted;
                lastUpdateTime = fmtTime();
                updateBar();
                appendProgress(msg.slug);
                worker.busy = false;
                assignNext(worker);
                tryExit();
            } else if (msg?.type === "error") {
                console.error(`Worker error on ${msg.slug}:`, msg.reason || msg.error);
                worker.busy = false;
                assignNext(worker);
                tryExit();
            }
        });

        child.on("exit", (code) => {
            if (isShuttingDown) return;
            console.log(`Worker exited ${code}`);
            const idx = workers.indexOf(worker);
            if (idx !== -1) workers.splice(idx, 1);

            const hasWork = queue.length > 0 || workers.some(w => w.busy);
            if (hasWork) {
                spawnWorker();
                for (const w of workers) assignNext(w);
            }
            tryExit();
        });

        child.on("error", (err) => {
            console.error("Worker error event:", err);
        });
    };

    const assignNext = (worker: { proc: ChildProcess; busy: boolean }) => {
        if (worker.busy) return;
        const task = queue.shift();
        if (!task) return;
        worker.busy = true;
        worker.proc.send({ type: "task", slug: task.slug, topic: task.topic, maxAuthors: 30 });
    };

    for (let i = 0; i < NUM_WORKERS; i++) {
        spawnWorker();
        await new Promise(r => setTimeout(r, 5000));
    }
};

main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
});
