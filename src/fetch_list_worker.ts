import { Browser, Page } from "puppeteer";
import puppeteer from "puppeteer-extra";

const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

const wait = (mill: number) => new Promise(resolve => setTimeout(resolve, Math.max(mill, 1000)));

let browser: Browser | null = null;
let page: Page | null = null;
let initialized = false;

const getMediumId = (url: string): number => {
    const hexId = url.split("?")[0].split("-").pop() || "";
    try {
        return parseInt(hexId, 16);
    } catch {
        return 0;
    }
};

interface ExtractedArticle {
    id: number;
    title: string;
    url: string;
}

const extractArticlesFromPage = async (checked: number): Promise<ExtractedArticle[]> => {
    const articles: ExtractedArticle[] = [];
    const seenUrls = new Set<string>();

    let lastScrollHeight = 0;
    let scrollAttempts = 0;
    const maxScrollAttempts = checked === 0 ? 50 : 2;
    const targetMax = checked === 0 ? 1000 : 50;

    while (scrollAttempts < maxScrollAttempts) {
        const newArticles = await page!.evaluate(() => {
            const results: Array<{ title: string; url: string }> = [];
            const seen = new Set<string>();

            const articleBlocks = Array.from(document.querySelectorAll("article"));
            for (const block of articleBlocks) {
                const h2 = block.querySelector("h2");
                if (!h2) continue;

                let link: Element | null = null;

                // Prefer link with source=user_profile_page
                const allLinks = Array.from(block.querySelectorAll('a[href^="/"]'));
                for (const a of allLinks) {
                    const href = a.getAttribute("href") || "";
                    if (href.includes("source=user_profile_page")) {
                        link = a;
                        break;
                    }
                }

                // Fallback: any data-discover link
                if (!link) {
                    link = block.querySelector('a[data-discover="true"]');
                }

                if (!link) continue;

                const href = link.getAttribute("href") || "";
                const fullUrl = new URL(href, window.location.href).href;
                const baseUrlPath = fullUrl.split("?")[0];

                let cleanTitle = h2.textContent || "";
                cleanTitle = cleanTitle.replace(/\s+/g, " ").trim();
                if (!cleanTitle) continue;

                if (!seen.has(baseUrlPath)) {
                    seen.add(baseUrlPath);
                    results.push({ title: cleanTitle, url: fullUrl });
                }
            }
            return results;
        });

        for (const art of newArticles) {
            if (seenUrls.has(art.url)) continue;
            seenUrls.add(art.url);

            const id = getMediumId(art.url);
            if (!id) continue;

            articles.push({ id, title: art.title, url: art.url });
        }

        // Stop conditions
        if (articles.length >= targetMax) break;

        const scrollHeight = await page!.evaluate(() => document.documentElement.scrollHeight);
        if (scrollHeight === lastScrollHeight && scrollAttempts > 3) {
            break;
        }
        lastScrollHeight = scrollHeight;

        await page!.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        await wait(2000);
        scrollAttempts++;
    }

    return articles;
};

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

const cleanup = async () => {
    try { if (browser) await browser.close(); } catch (e) {}
    process.exit(0);
};

process.on("message", async (message: any) => {
    try {
        if (message.type === "init") {
            await initPuppeteer(message.profileDir);
            initialized = true;
            process.send!({ ready: true });
        } else if (message.type === "task") {
            if (!initialized || !page) {
                process.send!({ error: true, reason: "Worker not initialized" });
                return;
            }

            const authorUrl = message.url as string;
            const checked = message.checked as number;

            try {
                await page.goto(authorUrl, { waitUntil: "networkidle2" });
                const articles = await extractArticlesFromPage(checked);
                process.send!({ type: "result", url: authorUrl, articles });
            } catch (err) {
                console.error(`Error processing author ${authorUrl}:`, err);
                process.send!({ type: "error", url: authorUrl, reason: String(err) });
            }
        }
    } catch (err) {
        console.error("Worker fatal:", err);
        process.send!({ type: "error", reason: String(err) });
        await cleanup();
    }
});

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
process.on("uncaughtException", (err) => { console.error("Uncaught exception:", err); cleanup(); });
process.on("unhandledRejection", (reason) => { console.error("Unhandled rejection:", reason); cleanup(); });
