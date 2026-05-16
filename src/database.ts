import path from "path";
import crypto from "crypto";
import Database from "better-sqlite3";

type DbInstance = InstanceType<typeof Database>;

// Internal statement interface to bypass strict @types/better-sqlite3 generics
interface DbStmt {
    get(...params: any[]): any;
    all(...params: any[]): any[];
    run(...params: any[]): { changes: number };
}

export class DatabaseManager {
    private static DB_PATH = path.resolve(__dirname, "../../medium_consumer.db");
    private db: DbInstance;

    private updateHtmlStmt!: DbStmt;
    private insertImageStmt!: DbStmt;
    private getArticleStmt!: DbStmt;
    private getUnprocessedCountStmt!: DbStmt;

    private checkArticleExistsStmt!: DbStmt;
    private insertArticleStmt!: DbStmt;
    private updateAuthorCheckedStmt!: DbStmt;
    private getAuthorsToRecheckStmt!: DbStmt;

    private insertAuthorStmt!: DbStmt;

    private getBatchStmt!: DbStmt;
    private updateImageStmt!: DbStmt;
    private totalCountStmt!: DbStmt;
    private remainingCountStmt!: DbStmt;

    constructor() {
        this.db = new Database(DatabaseManager.DB_PATH);
        this.db.pragma("journal_mode = WAL");
        this.db.pragma("synchronous = NORMAL");
        this.db.pragma("cache_size = 1000");

        this.initSchema();
        this.initPreparedStatements();
    }

    private initSchema() {
        this.db.exec(`CREATE TABLE IF NOT EXISTS articles (
            id INTEGER PRIMARY KEY,
            title TEXT,
            html TEXT,
            hsize INTEGER,
            url TEXT,
            tags TEXT,
            author TEXT,
            date TEXT,
            en TEXT, base TEXT, zh TEXT, ko TEXT, ru TEXT, ja TEXT, hi TEXT, ar TEXT
        )`);

        try { this.db.exec(`ALTER TABLE articles ADD COLUMN hsize INTEGER`); } catch (_) {}

        this.db.exec(`CREATE TABLE IF NOT EXISTS images (key TEXT PRIMARY KEY, url TEXT, data BLOB)`);
        this.db.exec(`CREATE TABLE IF NOT EXISTS authors (url TEXT PRIMARY KEY, checked INTEGER DEFAULT 0)`);

        const hasTopic = (this.db.prepare(`SELECT COUNT(*) as cnt FROM pragma_table_info('authors') WHERE name = 'topic'`).get() as any).cnt as number;
        if (hasTopic === 0) {
            this.db.exec(`ALTER TABLE authors ADD COLUMN topic TEXT`);
        }
    }

    private initPreparedStatements() {
        this.updateHtmlStmt = this.db.prepare(`UPDATE articles SET html = ?, hsize = ? WHERE id = ?`) as unknown as DbStmt;
        this.insertImageStmt = this.db.prepare(`INSERT OR IGNORE INTO images (key, url) VALUES (?, ?)`) as unknown as DbStmt;
        this.getArticleStmt = this.db.prepare(`SELECT id, url FROM articles WHERE id > ? AND html IS NULL ORDER BY id LIMIT 1`) as unknown as DbStmt;
        this.getUnprocessedCountStmt = this.db.prepare(`SELECT COUNT(*) AS total FROM articles WHERE html IS NULL`) as unknown as DbStmt;

        this.checkArticleExistsStmt = this.db.prepare(`SELECT 1 FROM articles WHERE id = ?`) as unknown as DbStmt;
        this.insertArticleStmt = this.db.prepare(`INSERT OR IGNORE INTO articles (id, title, url) VALUES (?, ?, ?)`) as unknown as DbStmt;
        this.updateAuthorCheckedStmt = this.db.prepare(`UPDATE authors SET checked = CAST(strftime('%s', 'now') AS INTEGER), count = ? WHERE url = ?`) as unknown as DbStmt;
        this.getAuthorsToRecheckStmt = this.db.prepare(`SELECT url, checked FROM authors WHERE (CAST(strftime('%s', 'now') AS INTEGER) - checked) > ?`) as unknown as DbStmt;

        this.insertAuthorStmt = this.db.prepare(`INSERT INTO authors (url, topic, checked) VALUES (?, ?, 0) ON CONFLICT(url) DO UPDATE SET topic = excluded.topic, checked = 0`) as unknown as DbStmt;

        this.getBatchStmt = this.db.prepare(`SELECT key, url FROM images WHERE data IS NULL LIMIT ?`) as unknown as DbStmt;
        this.updateImageStmt = this.db.prepare(`UPDATE images SET data = ? WHERE key = ?`) as unknown as DbStmt;
        this.totalCountStmt = this.db.prepare(`SELECT COUNT(*) AS c FROM images`) as unknown as DbStmt;
        this.remainingCountStmt = this.db.prepare(`SELECT COUNT(*) AS c FROM images WHERE data IS NULL`) as unknown as DbStmt;
    }

    getUnprocessedCount(): number {
        const row = this.getUnprocessedCountStmt.get() as { total: number } | undefined;
        return row?.total ?? 0;
    }

    getNextArticle(afterId: number): { id: number; url: string } | undefined {
        let row = this.getArticleStmt.get(afterId) as { id: number; url: string } | undefined;
        if (!row && afterId !== 0) {
            row = this.getArticleStmt.get(0) as { id: number; url: string } | undefined;
        }
        return row;
    }

    updateHtml(id: number, html: string): void {
        this.updateHtmlStmt.run(html, html.length, id);
    }

    markArticleEmpty(id: number): void {
        this.updateHtmlStmt.run("", 0, id);
    }

    insertImages(imageUrls: string[]): void {
        if (imageUrls.length === 0) return;
        const md5 = (text: string) => crypto.createHash("md5").update(text).digest("hex");
        const insert = this.db.transaction((items: { key: string; url: string }[]) => {
            for (const item of items) {
                this.insertImageStmt.run(item.key, item.url);
            }
        });
        insert(imageUrls.map((url) => ({ key: md5(url), url })));
    }

    getAuthorsToRecheck(seconds: number): Array<{ url: string; checked: number }> {
        return this.getAuthorsToRecheckStmt.all(seconds) as Array<{ url: string; checked: number }>;
    }

    articleExists(id: number): boolean {
        return !!this.checkArticleExistsStmt.get(id);
    }

    insertArticle(id: number, title: string, url: string): void {
        this.insertArticleStmt.run(id, title, url);
    }

    updateAuthorChecked(url: string, count: number): void {
        this.updateAuthorCheckedStmt.run(count, url);
    }

    insertAuthors(authors: Array<{ url: string; topic: string }>): { inserted: number } {
        const insert = this.db.transaction((items: Array<{ url: string; topic: string }>) => {
            let localInserted = 0;
            for (const a of items) {
                const result = this.insertAuthorStmt.run(a.url, a.topic);
                localInserted += result.changes || 0;
            }
            return localInserted;
        });
        return { inserted: insert(authors) };
    }

    getImageBatch(limit: number): Array<{ key: string; url: string }> {
        return this.getBatchStmt.all(limit) as Array<{ key: string; url: string }>;
    }

    updateImageData(key: string, data: Buffer): void {
        this.updateImageStmt.run(data, key);
    }

    getImageCounts(): { total: number; remaining: number } {
        const total = (this.totalCountStmt.get() as any).c as number;
        const remaining = (this.remainingCountStmt.get() as any).c as number;
        return { total, remaining };
    }

    close(): void {
        this.db.close();
    }
}
