import { Browser, Page } from "puppeteer";
import puppeteer from "puppeteer-extra";

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
        const html = elem?.innerHTML ?? '';
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
    await openUrl(page, task.url);
    return await getArticleDetail(page);
};

const processQueue = async () => {
    if (processing || !initialized || taskQueue.length === 0) return;
    processing = true;
    while (taskQueue.length > 0) {
        const task = taskQueue.shift()!;
        try {
            const article = await runTask(task);
            process.send!({ type: 'result', id: task.id, html: article?.html ?? '', imageUrls: article?.imageUrls ?? [] });
        } catch (err) {
            console.error(`Unhandled error in task #${task.id}:`, err);
            process.send!({ type: 'error', id: task.id });
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
        console.error("Worker initialization failed:", err);
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
