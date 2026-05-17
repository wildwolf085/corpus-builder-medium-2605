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
    // ── Phase 1: scroll until page is fully loaded ────────────────────────────
    const scrollCount = checked === 0 ? 50 : 5;
    let stagnantScrolls = 0;
    const maxStagnantScrolls = 6;

    for (let i = 0; i < scrollCount; i++) {
        const prevHeight = await page!.evaluate(() => document.documentElement.scrollHeight);
        const prevArticles = await page!.evaluate(() => document.querySelectorAll("article").length);

        await page!.evaluate(() => {
            window.scrollBy(0, Math.max(window.innerHeight - 100, 400));
        });
        await wait(3000);

        // Click any "Show more" / "Load more" if present
        const clicked = await page!.evaluate(() => {
            const btns = Array.from(document.querySelectorAll("button"));
            for (const b of btns) {
                const text = (b.textContent || "").toLowerCase();
                if (text.includes("show more") || text.includes("load more") || text.includes("see more")) {
                    (b as HTMLButtonElement).click();
                    return true;
                }
            }
            return false;
        });
        if (clicked) await wait(3000);

        const newHeight = await page!.evaluate(() => document.documentElement.scrollHeight);
        const newArticles = await page!.evaluate(() => document.querySelectorAll("article").length);

        if (newHeight === prevHeight && newArticles === prevArticles) {
            stagnantScrolls++;
            if (stagnantScrolls >= maxStagnantScrolls) break;
        } else {
            stagnantScrolls = 0;
        }
    }

    // ── Phase 2: extract everything in one shot ──────────────────────────────
    const articles = await page!.evaluate(() => {
        const results: Array<{ title: string; url: string }> = [];
        const seen = new Set<string>();

        const isArticleLink = (href: string): boolean => {
            if (!href) return false;
            try {
                const url = new URL(href, window.location.href);
                const path = url.pathname;
                return /-[0-9a-f]{12,}$/i.test(path) || /\/p\//i.test(path);
            } catch {
                return false;
            }
        };

        for (const block of Array.from(document.querySelectorAll("article"))) {
            const h2 = block.querySelector("h2");
            if (!h2) continue;

            const title = (h2.textContent || "").replace(/\s+/g, " ").trim();
            if (!title) continue;

            const anchors = Array.from(block.querySelectorAll('a[href]')) as HTMLAnchorElement[];
            let link = h2.closest('a[href]') as HTMLAnchorElement | null;

            if (!link) {
                link = anchors.find(a => isArticleLink(a.getAttribute("href") || "")) || null;
            }
            if (!link) {
                link = anchors.find(a => a.getAttribute("href")?.startsWith("/") || a.getAttribute("href")?.includes("medium.com")) || null;
            }
            if (!link) continue;

            const href = link.getAttribute("href") || "";
            const fullUrl = new URL(href, window.location.href).href;
            const base = fullUrl.split("?")[0];

            if (!seen.has(base)) {
                seen.add(base);
                results.push({ title, url: fullUrl });
            }
        }
        return results;
    });

    const extracted: ExtractedArticle[] = [];
    const seenUrls = new Set<string>();

    for (const art of articles) {
        if (seenUrls.has(art.url)) continue;
        seenUrls.add(art.url);
        const id = getMediumId(art.url);
        if (!id) continue;
        extracted.push({ id, title: art.title, url: art.url });
    }

    return extracted;
};

const initPuppeteer = async (profileDir: string) => {
    browser = await puppeteer.launch({
        protocolTimeout: 360000000,
        headless: "shell",
        args: [
            '--start-maximized',
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
                // console.error(`Error processing author ${authorUrl}:`, err);
                process.send!({ type: "error", url: authorUrl, reason: String(err) });
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
