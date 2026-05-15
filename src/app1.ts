import { Browser, Page } from "puppeteer";
import puppeteer from "puppeteer-extra";
import path from 'path';

const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const wait = (mill: number) => new Promise(resolve => setTimeout(resolve, Math.max(mill, 1000)));

const openUrl = async (page: Page, url: string) => {
    await page.goto(url, { waitUntil: "networkidle2" });
};

const initPuppeteer = async (profileDir: string) => {
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

const main = async () => {
    for (let i = 5; i < 10; i++) {
        const profileDir = path.resolve(__dirname, `../user-${i}`);
        const {browser, page} = await initPuppeteer(profileDir);
        await openUrl(page!, "https://medium.com/");
        await wait(5000);
    }
    await wait(3000000)
}

main()