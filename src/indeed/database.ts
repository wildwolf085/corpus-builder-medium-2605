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
    private static DB_PATH = path.resolve(__dirname, "../../../indeed.db");
    private db: DbInstance;

    private insertCompaniesStmt!: DbStmt;

    constructor() {
        this.db = new Database(DatabaseManager.DB_PATH);
        this.db.pragma("journal_mode = WAL");
        this.db.pragma("synchronous = NORMAL");
        this.db.pragma("cache_size = 1000");

        this.initSchema();
    }

    private initSchema() {
        this.db.exec(`CREATE TABLE IF NOT EXISTS companies (
            key TEXT PRIMARY KEY,
            country TEXT,
            url TEXT,
            json TEXT,
            updated INTEGER DEFAULT 0
            created INTEGER DEFAULT 0
        )`);

        this.insertCompaniesStmt = this.db.prepare(`INSERT OR IGNORE INTO companies (key, country, url, json, updated, created) VALUES (?, ?, ?, ?, ?, ?)`) as unknown as DbStmt;
    }

    insertCompanies(companies: Array<{ country: string; url: string; json: string }>): { changes: number } {
        const created = Math.round(Date.now() / 1000);
        const stmt = this.insertCompaniesStmt;
        const transaction = this.db.transaction(() => {
            let totalChanges = 0;
            
            for (const company of companies) {
                const key = crypto.createHash("md5").update(company.url).digest("hex");
                const result = stmt.run(
                    key,
                    company.country,
                    company.url,
                    company.json,
                    0,
                    created
                );
                totalChanges += result.changes;
            }
            
            return totalChanges;
        });
        
        return { changes: transaction() };
    }

    close(): void {
        this.db.close();
    }
}
