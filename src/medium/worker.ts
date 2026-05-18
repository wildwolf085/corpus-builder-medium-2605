import { Browser, Page } from "puppeteer";
import puppeteer from "puppeteer-extra";

const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const wait = (mill: number) => new Promise(resolve => setTimeout(resolve, Math.max(mill, 1000)));

const OPENURL_TIMEOUT = 90_000;
const PROCESS_TIMEOUT = 180_000;
const PAGE_RECREATE_INTERVAL = 50; // Recreate page every N tasks

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
        promise
            .then((val) => { clearTimeout(timer); resolve(val); })
            .catch((err) => { clearTimeout(timer); reject(err); });
    });
}

const tasksSinceLastRecreate = { count: 0 };

const recreatePage = async () => {
    if (!browser) return;
    try {
        if (page) { await page.close(); page = null; }
    } catch (_) { /* ignore on close */ }
    page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', (req) => {
        const resourceType = req.resourceType();
        if (resourceType === 'font' || resourceType === 'image') {
            req.abort();
        } else {
            req.continue();
        }
    });
    await page.setViewport({ width: 1900, height: 1080, deviceScaleFactor: 1 });
    await page.setDefaultNavigationTimeout(0);
    tasksSinceLastRecreate.count = 0;
};

const openUrl = async (page: Page, url: string) => {
    await withTimeout(page.goto(url, { waitUntil: "networkidle2" }), OPENURL_TIMEOUT, "openUrl " + url);
};

const getArticleDetail = async (page: Page): Promise<{html: string, imageUrls: string[]}|null> => {
    await page.evaluate(() => { window.scrollTo(0, 0); });
    await wait(1000);

    let lastScrollTop = -1;
    const maxScrollAttempts = 30;
    for (let attempt = 0; attempt < maxScrollAttempts; attempt++) {
        const state = await withTimeout(
            page.evaluate(() => {
                const el = document.scrollingElement || document.documentElement || document.body;
                return {
                    scrollTop: el.scrollTop,
                    scrollHeight: el.scrollHeight,
                    clientHeight: window.innerHeight
                };
            }),
            30_000,
            "scroll-evaluate"
        );

        const { scrollTop, scrollHeight, clientHeight } = state;
        if (scrollTop + clientHeight >= scrollHeight - 2) break;
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
            if (src?.includes('fill:64:64') || src?.includes('fill:32:32')) continue;
            if (src) imageUrls.push(src);
        }
        const elem = article.parentNode?.parentNode as HTMLElement;
        const html = elem?.innerHTML ?? '';
        return { html, imageUrls };
    });

    if (!result) return null;
    return { html: result.html, imageUrls: result.imageUrls };
};

// --- Persistent worker state ---
let browser: Browser | null = null;
let page: Page | null = null;
let initialized = false;
let processing = false;
const taskQueue: Array<{ id: number; url: string }> = [];

const cleanup = async () => {
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

const runTask = async (task: { id: number; url: string }) => {
    if (!page) throw new Error("Worker not initialized");
    if (!initialized) throw new Error("Worker not ready");

    tasksSinceLastRecreate.count++;
    if (tasksSinceLastRecreate.count % PAGE_RECREATE_INTERVAL === 0) {
        await recreatePage();
    }

    return await withTimeout(
        (async () => {
            await openUrl(page!, task.url);
            return await getArticleDetail(page!);
        })(),
        PROCESS_TIMEOUT,
        "runTask " + task.url
    );
};

const processQueue = async () => {
    if (processing || !initialized || taskQueue.length === 0) return;
    processing = true;
    while (taskQueue.length > 0) {
        const task = taskQueue[0]!;
        try {
            const article = await runTask(task);
            taskQueue.shift();
            process.send!({ type: 'result', id: task.id, html: article?.html ?? '', imageUrls: article?.imageUrls ?? [] });
        } catch (err) {
            taskQueue.shift();
            const errMsg = err instanceof Error ? err.message : String(err);
            process.send!({ type: 'error', id: task.id, reason: errMsg });
            if (errMsg.includes('Protocol error') || errMsg.includes('Target closed') || errMsg.includes('Session closed')) {
                try { if (browser) { await browser.close(); browser = null; page = null; } } catch (_) {}
                process.exit(1);
            }
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
        initialized = true;
        processQueue();
    } catch (err) {
        // console.error("Worker initialization failed:", err);
        process.send!({ type: 'error', id: -1 });
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
