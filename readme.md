# CorpusBuilder

A powerful Node.js tool for building large-scale web content datasets. CorpusBuilder automates the collection, processing, and archival of web pages, converting them to markdown format and managing associated media assets.

## Features

- **Web Scraping**: Uses Puppeteer with stealth mode to fetch content from websites
- **Content Conversion**: Automatically converts HTML to Markdown format
- **Image Management**: Downloads and stores images in SQLite database
- **Multi-threaded Processing**: Leverages worker processes for parallel data collection
- **Database Storage**: Uses SQLite with WAL mode for efficient data management
- **Progress Tracking**: Real-time progress visualization during operations
- **Author & List Management**: Organize content by authors and categories

## Prerequisites

- Node.js 16+ 
- npm or yarn
- Chrome/Chromium browser (for Puppeteer)

## Installation

```bash
npm install
npx puppeteer browsers install chrome
```

## Project Structure

```
src/
├── app.ts                 # Main application entry point
├── app1.ts               # Alternative application variant
├── fetch_page.ts         # Web page fetching logic
├── fetch_list.ts         # List fetching and processing
├── fetch_authors.ts      # Author data collection
├── image_downloader.ts   # Image download and storage
├── worker.ts             # Worker process handler
├── topics.json           # Topic configuration

opencode/
├── auth.json            # Authentication credentials
└── opencode.jsonc       # Configuration file

test/                    # Test files and samples
```

## Usage

### Run the main crawler

```bash
npm run crawl
# or
node -r ts-node/register/transpile-only src/app.ts
```

### Fetch pages

```bash
node -r ts-node/register/transpile-only src/fetch_page.ts
```

### Download images

```bash
node -r ts-node/register/transpile-only src/image_downloader.ts
```

### Fetch author data

```bash
node -r ts-node/register/transpile-only src/fetch_authors.ts
```

### Fetch lists

```bash
node -r ts-node/register/transpile-only src/fetch_list.ts
```

## Configuration

Configure the crawler using `opencode/opencode.jsonc`:

```jsonc
{
  // Your configuration options here
}
```

Add authentication details in `opencode/auth.json`:

```json
{
  "apiKey": "your-api-key",
  "credentials": {}
}
```

## Database

The project uses SQLite for data storage with optimizations:

- **Journal Mode**: WAL (Write-Ahead Logging) for better concurrency
- **Cache Size**: 1000 pages
- **Synchronous Mode**: NORMAL for balance between safety and performance

## Dependencies

### Core
- **puppeteer**: Headless browser automation
- **cheerio**: HTML parsing and manipulation
- **better-sqlite3**: SQL database client
- **axios**: HTTP client

### Content Processing
- **node-html-markdown**: HTML to Markdown conversion
- **turndown**: Alternative HTML to Markdown converter
- **turndown-plugin-gfm**: GitHub Flavored Markdown support

### Utilities
- **colors**: Terminal color output
- **progress**: Progress bar visualization
- **mongodb**: Optional MongoDB integration

## Development

### Prerequisites
- TypeScript knowledge
- Node.js development experience

### Build & Run

```bash
# Install dependencies
npm install

# Run TypeScript directly with ts-node
node -r ts-node/register/transpile-only src/app.ts

# Using PM2 for production
pm2 start "node -r ts-node/register/transpile-only src/app.ts" --name crawl
```

### Debugging

For VS Code debugging, use the following console configuration:

```json
{
  "console": "integratedTerminal", 
  "outputCapture": "std"
}
```

## Performance Tips

- Use integrated terminal for console output
- Monitor database size and periodically cleanup old data
- Adjust Puppeteer cache path: `~/.cache/puppeteer`
- Use worker processes to parallelize data collection
- Configure appropriate delays between requests to avoid rate limiting

## Troubleshooting

### Puppeteer Issues
If you encounter "Browser not found" errors:

```bash
npx puppeteer browsers install chrome
```

### Cache Path Problems
Ensure your cache path is correctly configured:
- Default: `C:\Users\{username}\.cache\puppeteer` (Windows)
- Adjust via Puppeteer environment variables if needed

### Database Locks
If you encounter database locks:
- Ensure only one process is writing to the database
- WAL mode should handle concurrent reads
- Check that previous processes have terminated

## Contributing

Contributions are welcome. Please ensure:
- Code follows TypeScript conventions
- All dependencies are listed in package.json
- Tests pass before submitting changes

## License

[Add your license information here]

## Support

For issues, questions, or suggestions, please check the project structure and configuration files.

---

**Last Updated**: May 2026
