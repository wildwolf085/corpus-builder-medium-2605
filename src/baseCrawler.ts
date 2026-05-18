import { Page } from "puppeteer";
import puppeteer from "puppeteer-extra";


const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

export const wait = (mill: number) => new Promise(resolve => setTimeout(resolve, Math.max(mill, 1000)));

const OPENURL_TIMEOUT = 90_000;

export const cleanup = async () => {
    process.exit(0);
};

export const initPuppeteer = async (profileDir: string) => {
    const browser = await puppeteer.launch({
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

    const page = await browser.newPage();
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

    return { browser, page };
};

export const withTimeout = <T>(promise: Promise<T>, ms: number, label: string): Promise<T> => {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
        promise
            .then((val) => { clearTimeout(timer); resolve(val); })
            .catch((err) => { clearTimeout(timer); reject(err); });
    });
}

export const openUrl = async (page: Page, url: string) => {
    await withTimeout(page.goto(url, { waitUntil: "networkidle2" }), OPENURL_TIMEOUT, "openUrl " + url);
};

