import { Browser, Page } from "puppeteer";
import puppeteer from "puppeteer-extra";
import path from 'path';
import fs from "fs";
import Database from "better-sqlite3";
import Topics from './topics.json'
const StealthPlugin = require('puppeteer-extra-plugin-stealth')
puppeteer.use(StealthPlugin())

let browser: Browser
const wait = (mill: number) => (new Promise(resolve => setTimeout(resolve, Math.max(mill, 1000))))

const initPuppeteer = async () => {
    const profileDir = `${__dirname}/../user-authors`

    browser = await puppeteer.launch({
        protocolTimeout: 360000000,
        headless: 'shell',
        args: [
            `--window-position=100,100`,
            `--window-size=1000,600`,
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
        const resourceType = req.resourceType()
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
    return page
}

const openUrl = async (page: Page, url: string) => {
    while (true) {
        try {
            await page.goto(url, { waitUntil: "networkidle2" });
            break
        } catch (error) {
            console.log(`failed to open ${url}`)
        }
        await wait(5000)
    }
}

interface Author {
    url: string
    topic: string
}

const safeEvaluate = async <T>(page: Page, fn: () => T, retries = 3): Promise<T> => {
    for (let i = 0; i < retries; i++) {
        try {
            return await page.evaluate(fn)
        } catch (err: any) {
            if (err.message?.includes('Execution context was destroyed') && i < retries - 1) {
                await wait(2000)
                continue
            }
            throw err
        }
    }
    throw new Error('safeEvaluate failed after retries')
}

const extractAuthorsFromPage = async (page: Page, topic: string, maxAuthors: number): Promise<Author[]> => {
    const authors: Author[] = []
    const seen = new Set<string>()

    let lastScrollHeight = 0
    let scrollAttempts = 0
    const maxScrollAttempts = 30

    while (scrollAttempts < maxScrollAttempts) {
        const newAuthors = await safeEvaluate(page, () => {
            const results: Array<{ url: string }> = []
            const seenHrefs = new Set<string>()

            const links = document.querySelectorAll('a[href^="/@"]')
            for (const link of links) {
                const href = link.getAttribute('href') || ''
                // Match /@username or /@username?... but not /@username/something
                const match = href.match(/^\/@([^/?#]+)(?:[?#]|$)/)
                if (!match) continue

                const username = match[1]
                const profileUrl = `https://medium.com/@${username}`

                if (!seenHrefs.has(profileUrl)) {
                    seenHrefs.add(profileUrl)
                    results.push({ url: profileUrl })
                }
            }
            return results
        })

        for (const a of newAuthors) {
            if (!seen.has(a.url)) {
                seen.add(a.url)
                authors.push({ url: a.url, topic })
            }
        }

        if (authors.length >= maxAuthors) break

        const scrollHeight = await safeEvaluate(page, () => document.documentElement.scrollHeight)
        if (scrollHeight === lastScrollHeight && scrollAttempts > 3) break
        lastScrollHeight = scrollHeight

        await safeEvaluate(page, () => window.scrollTo(0, document.documentElement.scrollHeight))
        await wait(3000)
        scrollAttempts++
    }

    return authors
}

const main = async () => {
    console.log("started")
    const page = await initPuppeteer();

    const dbPath = path.resolve(__dirname, '../../medium_consumer.db')
    const db = new Database(dbPath)

    db.exec(`CREATE TABLE IF NOT EXISTS authors (
        url TEXT PRIMARY KEY,
        checked INTEGER DEFAULT 0
    )`)

    // Add topic column if not exists
    const hasTopic = db.prepare(`SELECT COUNT(*) as cnt FROM pragma_table_info('authors') WHERE name = 'topic'`).get() as { cnt: number }
    if (hasTopic.cnt === 0) {
        db.exec(`ALTER TABLE authors ADD COLUMN topic TEXT`)
    }

    const insertAuthorStmt = db.prepare(`
        INSERT INTO authors (url, topic, checked)
        VALUES (?, ?, 0)
        ON CONFLICT(url) DO UPDATE SET
            topic = excluded.topic,
            checked = 0
    `)


    const insertMany = db.transaction((authors: Author[]) => {
        for (const a of authors) {
            insertAuthorStmt.run(a.url, a.topic)
        }
    })

    // Phase 1: Discover topics dynamically, then scrape each topic page
    // const topics = discoverTopics()
    const topics = Topics as {[key: string]: string}
    const topicSlugs = Object.keys(topics)

    const progressPath = path.resolve(__dirname, '../.fetch_authors_progress')
    let lastProcessedSlug = ''
    try {
        lastProcessedSlug = fs.readFileSync(progressPath, 'utf-8').trim()
    } catch { /* no progress file yet */ }

    let resumeFound = !lastProcessedSlug
    for (const slug of topicSlugs) {
        if (!resumeFound) {
            if (slug === lastProcessedSlug) {
                resumeFound = true
            }
            console.log(`skipping topic: ${slug} (already processed)`)
            continue
        }

        try {
            const url = `https://medium.com/tag/${slug}`
            console.log(`scraping topic: ${slug}`)
            await openUrl(page, url)
            await wait(3000)

            const authors = await extractAuthorsFromPage(page, topics[slug], 30)
            insertMany(authors)
            console.log(`  -> ${authors.length} authors`)

            fs.writeFileSync(progressPath, slug)
        } catch (err) {
            console.log(`failed to scrape topic ${slug}:`, err)
        }
        await wait(3000)
    }

    // Phase 2: Publications
    // for (const { slug, topic } of PUBLICATIONS) {
    //     try {
    //         const url = `https://medium.com/${slug}`
    //         console.log(`scraping publication: ${slug} (${topic})`)
    //         await openUrl(page, url)
    //         await wait(3000)

    //         const authors = await extractAuthorsFromPage(page, topic, 20)
    //         insertMany(authors)
    //         console.log(`  -> ${authors.length} authors`)
    //     } catch (err) {
    //         console.log(`failed to scrape publication ${slug}:`, err)
    //     }
    //     await wait(3000)
    // }

    // Report distribution
    const distribution = db.prepare(`SELECT topic, COUNT(*) as cnt FROM authors GROUP BY topic`).all()
    console.log('\nDomain distribution:')
    for (const row of distribution) {
        console.log(`  ${(row as any).topic}: ${(row as any).cnt}`)
    }

    await browser.close()
    console.log('done')
}

main()
