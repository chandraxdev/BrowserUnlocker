const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { chromium } = require('playwright');

const extensionPath = path.resolve(__dirname, '..');

function createFeatures(overrides = {}) {
    return {
        forcePaste: true,
        forceCopy: true,
        unlockSelection: true,
        rightClick: true,
        showPassword: true,
        visibilityBypass: true,
        keyboardUnblock: true,
        overlayRemoval: true,
        dragDropUnlock: true,
        printUnlock: true,
        scrollUnlock: true,
        videoUnlock: true,
        autocompleteUnlock: true,
        beforeUnloadBypass: true,
        zapperUnlock: true,
        enabled: true,
        ...overrides
    };
}

function buildHtml(body, { htmlAttrs = '', bodyAttrs = '', head = '', scripts = '' } = {}) {
    return `<!DOCTYPE html>
<html ${htmlAttrs}>
  <head>
    <meta charset="utf-8">
    <title>BrowserUnlocker Test</title>
    ${head}
  </head>
  <body ${bodyAttrs}>
    ${body}
    ${scripts}
  </body>
</html>`;
}

function createServer() {
    const server = http.createServer((req, res) => {
        const route = new URL(req.url, 'http://127.0.0.1').pathname;
        let html = '';

        if (route === '/disabled.html') {
            html = buildHtml(`
                <div id="overlay" style="position: fixed; z-index: 1001; opacity: 0.1;"></div>
                <div id="drag" draggable="false"></div>
            `);
        } else if (route === '/rightclick.html') {
            html = buildHtml(`
                <div id="target">Right click target</div>
            `, {
                head: `
                    <script>
                        window.contextHits = 0;
                        document.addEventListener('contextmenu', () => {
                            window.contextHits += 1;
                        });
                    </script>
                `
            });
        } else if (route === '/scroll.html') {
            html = buildHtml(`
                <div style="height: 2000px;">Scrollable content</div>
            `, {
                htmlAttrs: 'class="locked" style="overflow: hidden;"',
                bodyAttrs: 'class="no-scroll" style="overflow-y: hidden; overflow-x: hidden;"'
            });
        } else if (route === '/copy-toggle.html') {
            html = buildHtml(`
                <div id="target">Copy target</div>
            `, {
                head: `
                    <script>
                        window.copyHits = 0;
                        window.attachCopyBlocker = () => {
                            window.addEventListener('copy', (event) => {
                                window.copyHits += 1;
                                event.preventDefault();
                            }, true);
                        };
                    </script>
                `
            });
        } else if (route === '/selection-toggle.html') {
            html = buildHtml(`
                <h1 id="target">Selectable heading for toggle tests</h1>
            `, {
                head: `
                    <style>
                        h1 {
                            margin: 40px;
                            font-size: 36px;
                        }
                    </style>
                    <script>
                        document.addEventListener('selectstart', (event) => {
                            event.preventDefault();
                        });
                    </script>
                `
            });
        } else {
            res.writeHead(404, { 'content-type': 'text/plain' });
            res.end('Not found');
            return;
        }

        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(html);
    });

    return server;
}

let server;
let baseUrl;
let context;
let serviceWorker;
let extensionId;
let userDataDir;

async function updateFeatures(features) {
    await serviceWorker.evaluate(async (nextFeatures) => {
        await new Promise((resolve) => chrome.storage.local.set({ features: nextFeatures }, resolve));
    }, features);
}

test.before(async () => {
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;

    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'browserunlocker-playwright-'));
    context = await chromium.launchPersistentContext(userDataDir, {
        channel: 'chromium',
        headless: false,
        args: [
            `--disable-extensions-except=${extensionPath}`,
            `--load-extension=${extensionPath}`
        ]
    });

    serviceWorker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    extensionId = new URL(serviceWorker.url()).host;
});

test.after(async () => {
    await context?.close();
    await fs.rm(userDataDir, { recursive: true, force: true });
    await new Promise((resolve) => server.close(resolve));
});

test.beforeEach(async () => {
    await updateFeatures(createFeatures());
});

test('extension remains inert when disabled before page load', async () => {
    await updateFeatures(createFeatures({ enabled: false }));

    const page = await context.newPage();
    try {
        await page.goto(`${baseUrl}/disabled.html`, { waitUntil: 'load' });

        const state = await page.evaluate(() => ({
            draggable: document.getElementById('drag').getAttribute('draggable'),
            display: document.getElementById('overlay').style.display,
            pointerEvents: document.getElementById('overlay').style.pointerEvents
        }));

        assert.deepEqual(state, {
            draggable: 'false',
            display: '',
            pointerEvents: ''
        });
    } finally {
        await page.close();
    }
});

test('blocked contextmenu listeners replay after right-click unlock is turned off', async () => {
    const page = await context.newPage();
    try {
        await page.goto(`${baseUrl}/rightclick.html`, { waitUntil: 'load' });

        const initiallyBlocked = await page.evaluate(() => {
            window.contextHits = 0;
            document.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
            return window.contextHits;
        });
        assert.equal(initiallyBlocked, 0);

        await updateFeatures(createFeatures({ rightClick: false }));

        await page.waitForFunction(() => {
            window.contextHits = 0;
            document.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
            return window.contextHits === 1;
        });
    } finally {
        await page.close();
    }
});

test('scroll unlock restores original inline state after being turned off', async () => {
    const page = await context.newPage();
    try {
        await page.goto(`${baseUrl}/scroll.html`, { waitUntil: 'load' });

        await page.waitForFunction(() => {
            return document.documentElement.style.getPropertyValue('overflow') === 'auto' &&
                document.body.style.getPropertyValue('overflow-y') === 'auto' &&
                !document.documentElement.classList.contains('locked') &&
                !document.body.classList.contains('no-scroll');
        });

        await updateFeatures(createFeatures({ scrollUnlock: false }));

        const restored = await page.waitForFunction(() => {
            return document.documentElement.style.getPropertyValue('overflow') === 'hidden' &&
                document.body.style.getPropertyValue('overflow-y') === 'hidden' &&
                document.body.style.getPropertyValue('overflow-x') === 'hidden' &&
                document.documentElement.classList.contains('locked') &&
                document.body.classList.contains('no-scroll');
        });

        assert.equal(await restored.jsonValue(), true);
    } finally {
        await page.close();
    }
});

test('force copy still blocks window capture listeners added while the feature was off', async () => {
    const page = await context.newPage();
    try {
        await page.goto(`${baseUrl}/copy-toggle.html`, { waitUntil: 'load' });

        await updateFeatures(createFeatures({ forceCopy: false }));
        await page.evaluate(() => {
            window.attachCopyBlocker();
            window.copyHits = 0;
            document.dispatchEvent(new Event('copy', { bubbles: true, cancelable: true }));
        });

        assert.equal(await page.evaluate(() => window.copyHits), 1);

        await updateFeatures(createFeatures({ forceCopy: true }));

        await page.waitForFunction(() => {
            window.copyHits = 0;
            document.dispatchEvent(new Event('copy', { bubbles: true, cancelable: true }));
            return window.copyHits === 0;
        });
    } finally {
        await page.close();
    }
});

test('selection works again after the master switch is turned off and back on', async () => {
    const page = await context.newPage();
    try {
        await page.goto(`${baseUrl}/selection-toggle.html`, { waitUntil: 'load' });

        async function dragSelect() {
            const box = await page.locator('#target').boundingBox();
            await page.evaluate(() => window.getSelection().removeAllRanges());
            await page.mouse.move(box.x + 8, box.y + box.height / 2);
            await page.mouse.down();
            await page.mouse.move(box.x + box.width - 8, box.y + box.height / 2, { steps: 12 });
            await page.mouse.up();
            await page.waitForTimeout(200);
            return await page.evaluate(() => window.getSelection().toString());
        }

        assert.equal(await dragSelect(), 'Selectable heading for toggle tests');

        await updateFeatures(createFeatures({ enabled: false }));
        assert.equal(await dragSelect(), '');

        await updateFeatures(createFeatures({ enabled: true }));

        await page.waitForFunction(() => {
            return !!document.getElementById('bu-unlock-selection');
        });

        assert.equal(await dragSelect(), 'Selectable heading for toggle tests');
    } finally {
        await page.close();
    }
});

test('extension id is available for popup and service-worker access', async () => {
    assert.match(extensionId, /^[a-z]{32}$/);
});
