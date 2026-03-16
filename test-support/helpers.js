const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const repoRoot = path.resolve(__dirname, '..');
const contentSource = fs.readFileSync(path.join(repoRoot, 'content.js'), 'utf8');
const injectSource = fs.readFileSync(path.join(repoRoot, 'inject.js'), 'utf8');

function createDom(html = '') {
    const dom = new JSDOM(
        `<!DOCTYPE html><html><head></head><body>${html}</body></html>`,
        {
            pretendToBeVisual: true,
            runScripts: 'dangerously',
            url: 'https://example.com/'
        }
    );

    dom.window.requestAnimationFrame = (callback) => {
        callback();
        return 1;
    };
    dom.window.cancelAnimationFrame = () => { };
    dom.window.document.execCommand = () => true;

    return dom;
}

function executeInlineScript(window, source, configureScript) {
    const script = window.document.createElement('script');
    if (configureScript) {
        configureScript(script);
    }
    script.textContent = source;
    window.document.documentElement.appendChild(script);
    return script;
}

function createChromeStub(initialState) {
    const runtimeListeners = [];

    return {
        chrome: {
            runtime: {
                lastError: null,
                getURL: (file) => `chrome-extension://browserunlocker/${file}`,
                sendMessage: (message, callback) => {
                    if (message?.type === 'GET_STATE') {
                        callback?.(structuredClone(initialState));
                    }
                },
                onMessage: {
                    addListener(listener) {
                        runtimeListeners.push(listener);
                    }
                }
            }
        },
        runtimeListeners
    };
}

function createContentHarness({ html = '', initialState, beforeLoad } = {}) {
    const dom = createDom(html);
    const { chrome, runtimeListeners } = createChromeStub(initialState);
    dom.window.chrome = chrome;

    beforeLoad?.(dom.window);
    executeInlineScript(dom.window, contentSource);

    return {
        dom,
        window: dom.window,
        document: dom.window.document,
        sendStateUpdate(nextState) {
            for (const listener of runtimeListeners) {
                listener({ type: 'STATE_UPDATE', features: structuredClone(nextState) });
            }
        }
    };
}

function createInjectHarness(initialFlags) {
    const dom = createDom();
    executeInlineScript(dom.window, injectSource, (script) => {
        script.dataset.flags = JSON.stringify(initialFlags);
    });

    return {
        dom,
        window: dom.window,
        document: dom.window.document,
        updateFlags(nextFlags) {
            dom.window.document.dispatchEvent(
                new dom.window.CustomEvent('BU_UPDATE_FLAGS', {
                    detail: structuredClone(nextFlags)
                })
            );
        }
    };
}

function tick() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

module.exports = {
    createContentHarness,
    createInjectHarness,
    tick
};
