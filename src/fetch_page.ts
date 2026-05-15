import { Browser, Page } from "puppeteer";
import puppeteer from "puppeteer-extra";
import path from 'path';
import crypto from "crypto";
import Database from "better-sqlite3";
import { NodeHtmlMarkdown } from 'node-html-markdown';
import { fork } from 'child_process';

declare global {
  interface HTMLElement {
    __data?: any; // 或更具体的类型
  }
}
const md5 = (text: string) =>  crypto.createHash("md5").update(text).digest("hex");


const _originalLog = console.log
console.log = (...args: any[]) => {
    const d = new Date()
    const ts = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
    _originalLog(`[${ts}]`, ...args)
}

const StealthPlugin = require('puppeteer-extra-plugin-stealth')
puppeteer.use(StealthPlugin())

let showImage = false
let browser: Browser
const wait = (mill: number) => (new Promise(resolve => setTimeout(resolve, Math.max(mill, 1000))))

const getMediumId = (url: string): number => {
  const hexId = url.split('?')[0].split('-').pop() || ''
  try {
    return parseInt(hexId, 16)
  } catch {
    return 0
  }
}

const initPuppeteer = async () => {
    const profileDir = `${__dirname}/../user`

    browser = await puppeteer.launch({
        protocolTimeout: 360000000,
        headless: false,
        // headless: 'shell',
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
        const resourceType = req.resourceType()
        // req.continue();
        if (!showImage && (resourceType == 'font' || resourceType == 'image')) {
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

const closeBrowser = async () => {
    await browser.close();
}

const nhm = new NodeHtmlMarkdown({}, {
    'pre': {
        noEscape: true,
        preserveWhitespace: true,
        surroundingNewlines: 1,
        postprocess: ({ content }) => {
            return '\n```\n' + content.trim() + '\n```\n'
        }
    }
})

const openUrl = async (page: Page, url: string) => {
    await page.goto(url, { waitUntil: "networkidle2" });
    // while(true) {
        // try {
            
        //     // break
        // } catch (error) {
        //     console.log(`failed to open ${url}`)
        // }
        // await wait(5000)
    // }
}

interface Article {
    tags: string
    author: string
    date: string
    en: string
    html: string
}
// function simplifyLinksToItalics(text: string) {
//     // Regex explanation:
//     // \[([^\]]+)\]  -> Matches the link text inside brackets and captures it in group 1
//     // \([^\)]+\)    -> Matches the URL inside parentheses
//     return text.replace(/\[([^\]]+)\]\([^\)]+\)/g, '*$1*');
// }
const getDate = (d: string) => {
    try {
        return new Date(d).toISOString().split('T')[0]    
    } catch (error) {
        return d
    }
    
}

const getMarkdown = (html: string) => {
    return nhm.translate(html).replace(/\[([^\]]+)\]\([^\)]+\)/g, '*$1*').replace(/\n+/g, '\n')
}
const getArticleDetail = async (page: Page): Promise<{html: string, imageUrls: string[]}|null> => {
    await page.evaluate(() => {
        window.scrollTo(0, 0)
    })
    await wait(1000)

    let lastScrollTop = -1
    const maxScrollAttempts = 30
    for (let attempt = 0; attempt < maxScrollAttempts; attempt++) {
        const state = await page.evaluate(() => {
            const el = document.scrollingElement || document.documentElement || document.body
            return {
                scrollTop: el.scrollTop,
                scrollHeight: el.scrollHeight,
                clientHeight: window.innerHeight
            }
        })

        const { scrollTop, scrollHeight, clientHeight } = state
        if (scrollTop + clientHeight >= scrollHeight - 2) {
            break
        }
        if (scrollTop === lastScrollTop) {
            await page.evaluate(() => {
                window.scrollTo(0, document.documentElement.scrollHeight || document.body.scrollHeight)
            })
            // await wait(500)
            break
        }

        lastScrollTop = scrollTop
        await page.evaluate(() => {
            window.scrollBy(0, Math.max(window.innerHeight - 150, 400))
        })
        await wait(50)
    }

    await wait(1000)

    const result = await page.evaluate(() => {
        const article = document.querySelector('article') as HTMLElement
        if (!article) return null

        const imageUrls: string[] = []
        const imgs = article.querySelectorAll('img')
        for (const img of imgs) {
            const src = img.getAttribute('src')
            if (src) {
                imageUrls.push(src)
            }
        }
        const elem = article.parentNode?.parentNode as HTMLElement
        const html = elem?.innerHTML
        return { html, imageUrls }
    })

    if (!result) return null

    const { html, imageUrls } = result
    return {
        html,
        imageUrls
    }
}

const main = async () => {
    console.log("started")
    // await wait(5000)
    
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

    db.exec(`
        CREATE TABLE IF NOT EXISTS images (
            key TEXT PRIMARY KEY,
            url TEXT,
            data BLOB
        )
    `)
    const row = db.prepare(`SELECT COUNT(*) AS a, SUM(en IS NULL) AS b FROM articles`).get()
    if (row) {
        const {a: totalCount,b: remainingCount} = row as {a: number, b: number}
        console.log(`Total articles: ${totalCount}, remaining to process: ${remainingCount}`)
    }

    const insertHtmlStmt = db.prepare(`UPDATE articles SET html=? WHERE id = ?`)
    const updateSimpleStmt = db.prepare(`UPDATE articles SET en=? WHERE id = ?`)
    const getArticleStmt = db.prepare(`SELECT id, html, url FROM articles WHERE id > ? AND en IS NULL ORDER BY id LIMIT 1`)
    const insertImageStmt = db.prepare(`INSERT OR IGNORE INTO images (key, url) VALUES (?, ?)`)
    const insertImageMany = db.transaction((imageData: {key: string, url: string}[]) => {
        for (const {key, url} of imageData) {
            insertImageStmt.run(key, url)
        }
    })
    

    const page = await initPuppeteer();
    await openUrl(page, `https://medium.com/`)
    console.log(`waiting for login...`)
    // await wait(10000)

    // Start image downloader worker
    fork(path.resolve(__dirname, 'image_downloader.ts'), [], { execArgv: ['-r', 'ts-node/register/transpile-only'] })
    let lastId = 0
    let count = 0
    while (true) {
        try {
            const rows = getArticleStmt.get(lastId) as {id: number, html: string, url: string} | undefined
            if (!rows) {
                await wait(60000)
                continue
            }
            const {id, html, url} = rows
            lastId = id
            if (!html) {
                await openUrl(page, url)
                const article = await getArticleDetail(page)
                if (article) {
                    // Insert images to queue
                    insertImageMany(article.imageUrls.map(url => ({key: md5(url), url})))
                    insertHtmlStmt.run(article.html, id)
                    count++
                    console.log(`Count ${count} #${id}`)
                } else {
                    insertHtmlStmt.run('', id)
                }
            }
            
            
        } catch (err) {
            console.log(err)
        }
        await wait(Math.round(Math.random() * 1000) + 1000)
    }
    // await closeBrowser()
}

main()
