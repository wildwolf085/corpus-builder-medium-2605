import { Browser, Page } from "puppeteer";
import puppeteer from "puppeteer-extra";

const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

let browser: Browser | null = null;
let page: Page | null = null;
const wait = (mill: number) => new Promise(resolve => setTimeout(resolve, Math.max(mill, 1000)));

const initPuppeteer = async (profileDir: string) => {
    browser = await puppeteer.launch({
        protocolTimeout: 360000000,
        headless: "shell",
        args: [
            `--window-position=100,100`,
            `--window-size=1000,600`,
            "--disable-features=site-per-process",
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

    page.on("request", (req) => {
        const resourceType = req.resourceType();
        if (resourceType == "font" || resourceType == "image") {
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

interface Author {
    url: string;
    topic: string;
}

const safeEvaluate = async <T>(fn: () => T, retries = 3): Promise<T> => {
    for (let i = 0; i < retries; i++) {
        try {
            return await page!.evaluate(fn);
        } catch (err: any) {
            if (err.message?.includes("Execution context was destroyed") && i < retries - 1) {
                await wait(2000);
                continue;
            }
            throw err;
        }
    }
    throw new Error("safeEvaluate failed after retries");
};

const extractAuthorsFromPage = async (topic: string, maxAuthors: number): Promise<Author[]> => {
    const authors: Author[] = [];
    const seen = new Set<string>();

    let lastScrollHeight = 0;
    let scrollAttempts = 0;
    const maxScrollAttempts = 30;

    while (scrollAttempts < maxScrollAttempts) {
        const newAuthors = await safeEvaluate(() => {
            const results: Array<{ url: string }> = [];
            const seenHrefs = new Set<string>();

            const links = Array.from(document.querySelectorAll('a[href^="/@"]'));
            for (const link of links) {
                const href = link.getAttribute("href") || "";
                const match = href.match(/^\/@([^/?#]+)(?:[?#]|$)/);
                if (!match) continue;

                const username = match[1];
                const profileUrl = `https://medium.com/@${username}`;

                if (!seenHrefs.has(profileUrl)) {
                    seenHrefs.add(profileUrl);
                    results.push({ url: profileUrl });
                }
            }
            return results;
        });

        for (const a of newAuthors) {
            if (!seen.has(a.url)) {
                seen.add(a.url);
                authors.push({ url: a.url, topic });
            }
        }

        if (authors.length >= maxAuthors) break;

        const scrollHeight = await safeEvaluate(() => document.documentElement.scrollHeight);
        if (scrollHeight === lastScrollHeight && scrollAttempts > 3) break;
        lastScrollHeight = scrollHeight;

        await safeEvaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        await wait(3000);
        scrollAttempts++;
    }

    return authors;
};

const cleanup = async () => {
    try { if (browser) await browser.close(); } catch (e) {}
    process.exit(0);
};

process.on("message", async (message: any) => {
    try {
        if (message.type === "init") {
            await initPuppeteer(message.profileDir);
            // open base page to allow manual login if needed
            await page!.goto("https://medium.com/", { waitUntil: "networkidle2" });
            await wait(5000);
            process.send!({ ready: true });
        } else if (message.type === "task") {
            const slug = message.slug as string;
            const topic = message.topic as string;
            const maxAuthors = message.maxAuthors || 50;
            try {
                const url = `https://medium.com/tag/${slug}`;
                await page!.goto(url, { waitUntil: "networkidle2" });
                const authors = await extractAuthorsFromPage(topic, maxAuthors);
                process.send!({ type: "result", slug, authors });
            } catch (err) {
                // console.error(`failed to scrape topic ${slug}:`, err);
                process.send!({ type: "error", slug, reason: String(err) });
            }
        }
    } catch (err) {
        // console.error("Worker fatal:", err);
        process.send!({ type: "error", reason: String(err) });
        await cleanup();
    }
});

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
process.on("uncaughtException", (err) => { console.error("Uncaught exception:", err); cleanup(); });
process.on("unhandledRejection", (reason) => { console.error("Unhandled rejection:", reason); cleanup(); });
