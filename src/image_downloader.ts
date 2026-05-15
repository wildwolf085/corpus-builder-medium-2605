import Database from 'better-sqlite3'
import path from 'path'
import https from 'https'
import http from 'http'
import crypto from 'crypto'

const dbPath = path.resolve(__dirname, '../../medium_consumer.db')
const db = new Database(dbPath)

db.pragma('journal_mode = WAL')
db.pragma('synchronous = NORMAL')
db.pragma('cache_size = 1000')

const getStmt = db.prepare(`SELECT key, url FROM images WHERE data IS NULL LIMIT 1`)
const updateStmt = db.prepare(`UPDATE images SET data = ? WHERE key = ?`)

const downloadImage = (url: string): Promise<Buffer> => {
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith('https') ? https : http
        const req = protocol.get(url, (res) => {
            if (res.statusCode !== 200) {
                reject(new Error(`HTTP ${res.statusCode}`))
                return
            }
            const chunks: Buffer[] = []
            res.on('data', chunk => chunks.push(chunk))
            res.on('end', () => resolve(Buffer.concat(chunks)))
            res.on('error', reject)
        })
        req.on('error', reject)
        req.setTimeout(30000, () => {
            req.destroy()
            reject(new Error('Timeout'))
        })
    })
}

const processQueue = async () => {
    while (true) {
        const row = getStmt.get() as {key: string, url: string} | undefined
        if (!row) {
            await new Promise(resolve => setTimeout(resolve, 1000))
            continue
        }
        const {key, url} = row
        try {
            const data = await downloadImage(url)
            updateStmt.run(data, key)
        } catch (err: any) {
            console.error(`Failed to download ${url}:`, err.message)
        }
    }
}

processQueue()