import { Browser, Page } from "puppeteer";
import puppeteer from "puppeteer-extra";
import path from 'path';
import Database from "better-sqlite3";

const StealthPlugin = require('puppeteer-extra-plugin-stealth')
puppeteer.use(StealthPlugin())

let browser: Browser
const wait = (mill: number) => (new Promise(resolve => setTimeout(resolve, Math.max(mill, 1000))))

const AUTHOR_RECHECK_SECONDS = 3 * 24 * 60 * 60

const pad = (n: number) => String(n).padStart(2, '0')
const formatTime = (date: Date) => {
    return `[${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}]`
}

const log = (...args: unknown[]) => console.log(formatTime(new Date()), ...args)

const initPuppeteer = async () => {
    const profileDir = `${__dirname}/../user-list`

    browser = await puppeteer.launch({
        protocolTimeout: 360000000,
        headless: false,
        // headless: 'shell',
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
            log(`failed to open ${url}`)
        }
        await wait(5000)
    }
}

const getMediumId = (url: string): number => {
    const hexId = url.split('?')[0].split('-').pop() || ''
    try {
        return parseInt(hexId, 16)
    } catch {
        return 0
    }
}

interface ExtractedArticle {
    id: number
    title: string
    url: string
}

const extractArticlesFromPage = async (page: Page, checked: number, db: Database.Database): Promise<ExtractedArticle[]> => {
    const articles: ExtractedArticle[] = []
    const seenUrls = new Set<string>()
    const checkExistsStmt = db.prepare('SELECT 1 FROM articles WHERE id = ?')

    let lastScrollHeight = 0
    let scrollAttempts = 0
    const maxScrollAttempts = checked === 0 ? 50 : 2
    const targetMax = checked === 0 ? 1000 : 50

    while (scrollAttempts < maxScrollAttempts) {
        const newArticles = await page.evaluate(() => {
            const results: Array<{ title: string, url: string }> = []
            const seen = new Set<string>()

            const articleBlocks = document.querySelectorAll('article')
            for (const block of articleBlocks) {
                const h2 = block.querySelector('h2')
                if (!h2) continue

                let link: Element | null = null

                // Prefer link with source=user_profile_page
                const allLinks = block.querySelectorAll('a[href^="/"]')
                for (const a of allLinks) {
                    const href = a.getAttribute('href') || ''
                    if (href.includes('source=user_profile_page')) {
                        link = a
                        break
                    }
                }

                // Fallback: any data-discover link
                if (!link) {
                    link = block.querySelector('a[data-discover="true"]')
                }

                if (!link) continue

                const href = link.getAttribute('href') || ''
                const fullUrl = new URL(href, window.location.href).href
                const baseUrlPath = fullUrl.split('?')[0]

                let cleanTitle = h2.textContent || ''
                cleanTitle = cleanTitle.replace(/\s+/g, ' ').trim()
                if (!cleanTitle) continue

                if (!seen.has(baseUrlPath)) {
                    seen.add(baseUrlPath)
                    results.push({ title: cleanTitle, url: fullUrl })
                }
            }
            return results
        })

        let newCount = 0
        let existingCount = 0

        for (const art of newArticles) {
            if (seenUrls.has(art.url)) continue
            seenUrls.add(art.url)

            const id = getMediumId(art.url)
            if (!id) continue

            const exists = checkExistsStmt.get(id)
            if (exists) {
                existingCount++
            } else {
                newCount++
            }
            articles.push({ id, title: art.title, url: art.url })
        }

        // Stop conditions
        if (articles.length >= targetMax) break
        if (checked > 0 && existingCount > newCount && scrollAttempts > 3) break

        const scrollHeight = await page.evaluate(() => document.documentElement.scrollHeight)
        if (scrollHeight === lastScrollHeight && scrollAttempts > 3) {
            break
        }
        lastScrollHeight = scrollHeight

        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
        await wait(3000)
        scrollAttempts++
    }

    return articles
}

const main = async () => {
    log("started")
    const page = await initPuppeteer();    
    const dbPath = path.resolve(__dirname, '../../medium_consumer.db')
    const db = new Database(dbPath)

    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
    db.pragma('cache_size = 1000')

    db.exec(`
        CREATE TABLE IF NOT EXISTS articles (
            id INTEGER PRIMARY KEY,
            title TEXT,
            html TEXT,
            url TEXT,
            tags TEXT,
            author TEXT,
            date TEXT,
            en TEXT,
            base TEXT,
            zh TEXT,
            ko TEXT,
            ru TEXT,
            ja TEXT,
            hi TEXT,
            ar TEXT
        )
    `)
    
    const getAuthorStmt = db.prepare(`
        SELECT url, checked FROM authors
        WHERE checked = 0 OR (CAST(strftime('%s', 'now') AS INTEGER) - checked) > ${AUTHOR_RECHECK_SECONDS}
        LIMIT 1
    `)
    const updateAuthorStmt = db.prepare(`
        UPDATE authors SET checked = CAST(strftime('%s', 'now') AS INTEGER), count = ? WHERE url = ?
    `)

    const insertMany = db.transaction((articles: ExtractedArticle[]) => {
        if (articles.length === 0) {
            return 0
        }

        const valuesSql = articles.map(() => '(?, ?, ?)').join(', ')
        const sql = `INSERT OR IGNORE INTO articles (id, title, url) VALUES ${valuesSql}`
        const params: Array<number | string> = []

        for (const art of articles) {
            params.push(art.id)
            params.push(art.title)
            params.push(art.url)
        }

        const result = db.prepare(sql).run(...params)
        return result.changes || 0
    })

    while (true) {
        try {
            const row = getAuthorStmt.get() as { url: string, checked: number } | undefined
            if (!row) {
                log('no authors to check, waiting...')
                await wait(60000)
                continue
            }

            const { url, checked } = row
            // console.log(`checking ${url} (checked=${checked})`)

            await openUrl(page, url)
            // await wait(3000)

            const articles = await extractArticlesFromPage(page, checked, db)

            const insertedCount = insertMany(articles)

            updateAuthorStmt.run(articles.length, url)
            log(`inserted ${insertedCount} new articles from ${url} (scanned ${articles.length})`)

        } catch (err) {
            log(err)
        }
        await wait(Math.round(Math.random() * 1000) + 1000)
    }
}

main()
