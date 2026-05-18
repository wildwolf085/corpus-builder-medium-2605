import path from "path";
import { Worker } from "worker_threads";
import { MultiBar } from "../progress";
import { DatabaseManager } from "./database";

const db = new DatabaseManager();

// progress UI
const multibar = new MultiBar();
let imgBar: any = null;
let startTime = Date.now();
let processedSinceStart = 0;
let initialDownloaded = 0;
let initialCaptured = false;

// Worker-thread based downloader pool
// Worker code (string) performs the HTTP(S) GET and returns a transferred ArrayBuffer
const workerCode = `
const { parentPort } = require('worker_threads');
const http = require('http');
const https = require('https');

parentPort.on('message', (task) => {
    const { key, url } = task;
    try {
        const isHttps = String(url).startsWith('https');
        const protocol = isHttps ? https : http;
        const req = protocol.get(url, (res) => {
            if (res.statusCode !== 200) {
                parentPort.postMessage({ key, error: 'HTTP ' + res.statusCode });
                return;
            }
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                try {
                    const buf = Buffer.concat(chunks);
                    // send as base64 string to avoid transferable/clone issues
                    parentPort.postMessage({ key, data: buf.toString('base64') });
                } catch (e) {
                    parentPort.postMessage({ key, error: String(e) });
                }
            });
            res.on('error', (e) => parentPort.postMessage({ key, error: String(e) }));
        });
        req.on('error', (e) => parentPort.postMessage({ key, error: String(e) }));
        req.setTimeout(30000, () => { req.destroy(); parentPort.postMessage({ key, error: 'Timeout' }); });
    } catch (e) {
        parentPort.postMessage({ key, error: String(e) });
    }
});
`;

const makeWorker = () => new Worker(workerCode, { eval: true });

const CONCURRENCY = 8;

let shuttingDown = false;

// worker pool with automatic respawn on error/exit
const pool: { worker: Worker; busy: boolean }[] = [];
const createSlot = () => {
    const worker = makeWorker();
    const slot = { worker, busy: false };
    worker.on('error', (err) => {
        console.error('image worker error:', err);
        try { worker.terminate() } catch (e) {}
        // respawn
        const idx = pool.indexOf(slot);
        if (idx !== -1) pool[idx] = createSlot();
    });
    worker.on('exit', (code) => {
        if (code !== 0) console.error('image worker exited:', code);
        const idx = pool.indexOf(slot);
        if (idx !== -1) pool[idx] = createSlot();
    });
    return slot;
};
for (let i = 0; i < CONCURRENCY; i++) pool.push(createSlot());

const runTask = (key: string, url: string): Promise<void> => {
    return new Promise((resolve) => {
        const assign = () => {
            const slot = pool.find(p => !p.busy);
            if (!slot) {
                setTimeout(assign, 50);
                return;
            }
            slot.busy = true;
            const onMessage = (msg: any) => {
                slot.worker.off('message', onMessage);
                slot.busy = false;
                if (!msg) { resolve(); return; }
                if (msg.error) {
                    resolve();
                    return;
                }
                try {
                    let data: Buffer;
                    if (typeof msg.data === 'string') data = Buffer.from(msg.data, 'base64');
                    else if (msg.data instanceof Buffer) data = msg.data;
                    else data = Buffer.from(msg.data);
                    db.updateImageData(key, data);
                } catch (e) {
                    console.error('failed to write image for', key, e);
                }
                resolve();
            };
            slot.worker.on('message', onMessage);
            try {
                slot.worker.postMessage({ key, url });
            } catch (e) {
                slot.worker.off('message', onMessage);
                slot.busy = false;
                console.error('failed to post task to worker', e);
                resolve();
            }
        };
        assign();
    });
};

const processQueue = async () => {
    let backoffMs = 1000;
    while (!shuttingDown) {
        const rows = db.getImageBatch(CONCURRENCY);
        if (!rows || rows.length === 0) {
            await new Promise(resolve => setTimeout(resolve, backoffMs));
            backoffMs = Math.min(30000, backoffMs * 1.5);
            continue;
        }

        backoffMs = 1000;

        await Promise.all(rows.map(({ key, url }) => {
            if (shuttingDown) return Promise.resolve();
            return runTask(key, url);
        }));

        try {
            const { total, remaining } = db.getImageCounts();
            const currentDownloaded = total - remaining;
            if (!imgBar) {
                initialDownloaded = currentDownloaded;
                initialCaptured = true;
                processedSinceStart = 0;
                startTime = Date.now();
                imgBar = multibar.create(total, currentDownloaded, { elapsed: 0, eta: 0, rate: 0 });
                // reserve a line for this bar
                process.stdout.write("\n");
                multibar.start(250);
            } else {
                processedSinceStart = Math.max(0, currentDownloaded - initialDownloaded);
                const elapsedSec = (Date.now() - startTime) / 1000;
                const rate = elapsedSec > 0 ? processedSinceStart / elapsedSec : 0;
                const eta = rate > 0 ? remaining / rate : 0;
                imgBar.update(currentDownloaded);
                imgBar.payload = { elapsed: elapsedSec, eta, rate };
            }
        } catch (e) {
            // ignore
        }
    }
};

// Periodically update the progress bar if present
const sendProgress = () => {
    try {
        if (!imgBar || !initialCaptured) return;
        const { total, remaining } = db.getImageCounts();
        const currentDownloaded = total - remaining;
        processedSinceStart = Math.max(0, currentDownloaded - initialDownloaded);
        const elapsedSec = (Date.now() - startTime) / 1000;
        const rate = elapsedSec > 0 ? processedSinceStart / elapsedSec : 0;
        const eta = rate > 0 ? remaining / rate : 0;
        imgBar.update(currentDownloaded);
        imgBar.payload = { elapsed: elapsedSec, eta, rate };

        if (remaining === 0) {
            stopProgressTimer();
            multibar.stop();
        }
    } catch (e) {
        // ignore
    }
};

let progressTimer: NodeJS.Timeout | null = null;

const startProgressTimer = (ms = 5000) => {
    if (progressTimer) return;
    progressTimer = setInterval(sendProgress, ms);
};

const stopProgressTimer = () => {
    if (progressTimer) {
        clearInterval(progressTimer);
        progressTimer = null;
    }
};

startProgressTimer();
processQueue();
