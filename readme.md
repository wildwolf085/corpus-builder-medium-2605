 1. you did not perform an installation before running the script (e.g. `npx puppeteer browsers install chrome`) or
 2. your cache path is incorrectly configured (which is: C:\Users\Administrator\.cache\puppeteer).


for console progress, you can use the following vscode configuration:
```json
{
    ...
    "console": "integratedTerminal", 
    "outputCapture": "std",
    ...
}
```
cd C:\fenhongbao\freecity-crawl-51fengliu
node -r ts-node/register/transpile-only src/app.ts

pm2 start "node -r ts-node/register/transpile-only src/app.ts" --name crawl