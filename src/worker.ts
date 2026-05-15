import { Browser, Page } from "puppeteer";
import puppeteer from "puppeteer-extra";
import path from 'path';
import crypto from "crypto";
import Database from "better-sqlite3";

const md5 = (text: string) => crypto.createHash("md5").update(text).digest("hex");

const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const wait = (mill: number) => new Promise(resolve => setTimeout(resolve, Math.max(mill, 1000)));

const openUrl = async (page: Page, url: string) => {
    await page.goto(url, { waitUntil: "networkidle2" });
};

const getArticleDetail = async (page: Page): Promise<{html: string, imageUrls: string[]}|null> => {
    await page.evaluate(() => {
        window.scrollTo(0, 0);
    });
    await wait(1000);

    let lastScrollTop = -1;
    const maxScrollAttempts = 30;
    for (let attempt = 0; attempt < maxScrollAttempts; attempt++) {
        const state = await page.evaluate(() => {
            const el = document.scrollingElement || document.documentElement || document.body;
            return {
                scrollTop: el.scrollTop,
                scrollHeight: el.scrollHeight,
                clientHeight: window.innerHeight
            };
        });

        const { scrollTop, scrollHeight, clientHeight } = state;
        if (scrollTop + clientHeight >= scrollHeight - 2) {
            break;
        }
        if (scrollTop === lastScrollTop) {
            await page.evaluate(() => {
                window.scrollTo(0, document.documentElement.scrollHeight || document.body.scrollHeight);
            });
            break;
        }

        lastScrollTop = scrollTop;
        await page.evaluate(() => {
            window.scrollBy(0, Math.max(window.innerHeight - 150, 400));
        });
        await wait(50);
    }

    await wait(1000);

    const result = await page.evaluate(() => {
        const article = document.querySelector('article') as HTMLElement;
        if (!article) return null;

        const imageUrls: string[] = [];
        const imgs = article.querySelectorAll('img');
        for (const img of Array.from(imgs)) {
            const src = img.getAttribute('src');
            if (src) {
                imageUrls.push(src);
            }
        }
        const elem = article.parentNode?.parentNode as HTMLElement;
        const html = elem?.innerHTML;
        return { html, imageUrls };
    });

    if (!result) return null;

    const { html, imageUrls } = result;
    return {
        html,
        imageUrls
    };
};

// --- Persistent worker state ---
let browser: Browser | null = null;
let page: Page | null = null;
let db: InstanceType<typeof Database> | null = null;
let insertHtmlStmt: Database.Statement | null = null;
let insertImageStmt: Database.Statement | null = null;
let insertImageMany: ((imageData: {key: string, url: string}[]) => void) | null = null;
let initialized = false;
let processing = false;
const taskQueue: Array<{ id: number; url: string }> = [];

const cleanup = async () => {
    if (db) { db.close(); db = null; }
    if (browser) { await browser.close(); browser = null; }
    page = null;
    process.exit(0);
};

const initPuppeteer = async (profileDir: string) => {
    browser = await puppeteer.launch({
        protocolTimeout: 360000000,
        headless: false,
        defaultViewport: null,
        args: [
            '--start-maximized',
            '--disable-features=site-per-process',
            "--fast-start",
            "--disable-extensions",
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-accelerated-2d-canvas",
            "--no-first-run",
            "--no-zygote",
            "--disable-gpu",
        ],
        userDataDir: profileDir,
    });

    page = await browser.newPage();
    await page.setRequestInterception(true);

    page.on('request', (req) => {
        const resourceType = req.resourceType();
        if (resourceType == 'font' || resourceType == 'image') {
            req.abort();
        } else {
            req.continue();
        }
    });

    await page.setViewport({
        width: 1900,
        height: 1080,
        deviceScaleFactor: 1,
    });
    await page.setDefaultNavigationTimeout(0);
};

const initDb = () => {
    const dbPath = path.resolve(__dirname, '../../medium_consumer.db');
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('cache_size = 1000');

    insertHtmlStmt = db.prepare(`UPDATE articles SET html=?, hsize=? WHERE id = ?`);
    insertImageStmt = db.prepare(`INSERT OR IGNORE INTO images (key, url) VALUES (?, ?)`);
    insertImageMany = db.transaction((imageData: {key: string, url: string}[]) => {
        for (const {key, url} of imageData) {
            insertImageStmt!.run(key, url);
        }
    });
};

const runTask = async (task: { id: number; url: string }) => {
    const { id, url } = task;
    if (!page || !insertHtmlStmt || !insertImageMany) {
        process.send!({ error: true, id, reason: "Worker not initialized" });
        return;
    }

    try {
        await openUrl(page, url);
        const article = await getArticleDetail(page);
        if (article) {
            insertImageMany(article.imageUrls.map(url => ({key: md5(url), url})));
            insertHtmlStmt.run(article.html, article.html.length, id);
        } else {
            insertHtmlStmt.run('', 0, id);
        }
        process.send!({ done: true, id });
    } catch (err) {
        console.error(`Error processing article #${id}:`, err);
        process.send!({ error: true, id });
    }
};

const processQueue = async () => {
    if (processing || !initialized || taskQueue.length === 0) return;
    processing = true;
    while (taskQueue.length > 0) {
        const task = taskQueue.shift()!;
        try {
            await runTask(task);
        } catch (err) {
            console.error(`Unhandled error in task #${task.id}:`, err);
            process.send!({ error: true, id: task.id });
        }
    }
    processing = false;
};

const initialize = async (profileDir: string) => {
    try {
        await initPuppeteer(profileDir);
        await openUrl(page!, "https://medium.com/");
        await wait(30000);
        console.log(`waiting for login...`);
        initDb();
        initialized = true;
        processQueue();
    } catch (err) {
        console.error("Worker initialization failed:", err);
        process.send!({ error: true, id: -1 });
        await cleanup();
    }
};

process.on('message', async (message: any) => {
    if (message.type === 'init') {
        await initialize(message.profileDir);
    } else if (message.type === 'task') {
        taskQueue.push({ id: message.id, url: message.url });
        processQueue();
    }
});

process.on('disconnect', cleanup);
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    cleanup();
});
process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection:', reason);
    cleanup();
});
