import path from 'path';
import { cleanup, initPuppeteer, openUrl, wait, withTimeout } from '../baseCrawler';
import locations from './us-location.json';
import industries from './us-industry.json';
import { Page } from 'puppeteer';

const scrapeCompanyData = async (page: Page, url: string) => {

    
    const companies = [] as { name: string, href: string }[];
    while (true) {
        await openUrl(page, url);
        const solved = await detectAndSolveCaptcha(page);
        if (!solved) {
            console.error(`Failed to solve CAPTCHA for URL: ${url}`);
            return;
        }

        const items = await page.evaluate(() => {
            const data = []
            const elements = document.querySelectorAll('main ul li') as NodeListOf<HTMLElement>;
            for (const el of Array.from(elements)) {
                const link = el.querySelector('h2 a');
                if (link) {
                    const name = link.textContent?.trim() || '';
                    const href = link.getAttribute('href') || '';
                    data.push({ name, href });
                }
            }
            return data;
        })

        if (items.length === 0) {
            break;
        }
        
        companies.push(...items);

        const nextUrl = await page.evaluate(() => {
            const elements = document.querySelectorAll('main nav a') as NodeListOf<HTMLElement>;
            for (const el of Array.from(elements)) {
                if (el.textContent?.trim() === 'Next') {
                    return el.getAttribute('href') || '';
                }
            }
            return '';
        })
        if (nextUrl) {
            url = `https://www.indeed.com${nextUrl}`;
        } else {
            break;
        }
        await wait(1000 + Math.round(Math.random() * 3000));
    }

    console.log(companies)
    // Implement the logic to scrape company data from the given URL
    // This function would use Puppeteer to navigate to the URL and extract the necessary information
}

const detectAndSolveCaptcha = async (page: Page): Promise<boolean> => {
    while(true) {
        let bodyText = await page!.evaluate(() => document.body?.innerText || "");
        if (bodyText.includes('Additional Verification Required')) {
            // Implement CAPTCHA solving logic here
            await wait(1000); // Placeholder for CAPTCHA solving time
        } else {
            break;
        }
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
        await wait(1000);
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
            for (const {link: industry} of industries) {
                // https://www.indeed.com/companies/best-companies?industry=Aerospace+%26+Defense&location=Huntsville%2C+AL&after=OQ%3D%3D
                const url = `https://www.indeed.com${industry}-in-${location.replace(' ', '-')}`;
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