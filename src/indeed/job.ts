import path from 'path';
import { cleanup, initPuppeteer, openUrl, wait, withTimeout } from '../baseCrawler';
import locations from './us-location.json';
import industries from './us-location.json';
import { Page } from 'puppeteer';

const scrapeCompanyData = async (page: Page, url: string) => {

    await openUrl(page, url);
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
    // Implement the logic to scrape company data from the given URL
    // This function would use Puppeteer to navigate to the URL and extract the necessary information
}

const detectAndSolveCaptcha = async (page: Page): Promise<boolean> => {
    let bodyText = await page!.evaluate(() => document.body?.innerText || "");
    if (bodyText && /apologies/i.test(bodyText)) {
        // break
    }
    // Implement logic to detect if a CAPTCHA is present on the page
    // This could involve checking for specific elements or patterns that indicate a CAPTCHA
    return true; // Placeholder return value
}

const initialize = async (initialUrl: string, profileDir: string) => {
    try {
        console.log(`Initialization successful, locations: ${locations.length} industries: ${industries.length}`);
        const { page } = await initPuppeteer(profileDir);
        await openUrl(page, initialUrl);
        await detectAndSolveCaptcha(page);
        await wait(60000);
        return page
    } catch (err) {
        await cleanup();
    }
};

const main = async () => {
    const initialUrl = 'https://www.indeed.com'
    const profileDir = path.resolve(__dirname, `../../profiles/indeed-0`);
    const page = await initialize(initialUrl, profileDir);
    if (page) {
        
        for (const {name: location} of locations) {
            for (const {name: industry} of industries) {
                // https://www.indeed.com/companies/best-companies?industry=Aerospace+%26+Defense&location=Huntsville%2C+AL&after=OQ%3D%3D
                const url = `https://www.indeed.com/companies/best-companies?industry=${encodeURIComponent(industry)}&location=${encodeURIComponent(location)}`;
                await scrapeCompanyData(page, url);
                await wait(5000);
            }
        }
    }
}

main().catch(async (err) => {
    console.error("Worker failed with error:", err);
    await cleanup();
});