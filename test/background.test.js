const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const backgroundSource = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

function createChromeHarness(initialFeatures) {
    const listeners = {
        onInstalled: [],
        onStartup: [],
        onChanged: [],
        onMessage: []
    };
    const badgeState = {
        text: null,
        backgroundColor: null,
        textColor: null
    };
    let storedFeatures = initialFeatures;

    const chrome = {
        runtime: {
            onInstalled: {
                addListener(listener) {
                    listeners.onInstalled.push(listener);
                }
            },
            onStartup: {
                addListener(listener) {
                    listeners.onStartup.push(listener);
                }
            },
            onMessage: {
                addListener(listener) {
                    listeners.onMessage.push(listener);
                }
            }
        },
        storage: {
            local: {
                get(key, callback) {
                    callback({ features: storedFeatures });
                },
                set(value, callback) {
                    if (value && Object.prototype.hasOwnProperty.call(value, 'features')) {
                        storedFeatures = value.features;
                    }
                    callback?.();
                }
            },
            onChanged: {
                addListener(listener) {
                    listeners.onChanged.push(listener);
                }
            }
        },
        tabs: {
            query(_queryInfo, callback) {
                callback([]);
            }
        },
        action: {
            setBadgeText({ text }) {
                badgeState.text = text;
            },
            setBadgeBackgroundColor({ color }) {
                badgeState.backgroundColor = color;
            },
            setBadgeTextColor({ color }) {
                badgeState.textColor = color;
            }
        }
    };

    return {
        chrome,
        listeners,
        badgeState,
        getStoredFeatures() {
            return storedFeatures;
        }
    };
}

function executeBackgroundScript(initialFeatures) {
    const harness = createChromeHarness(initialFeatures);
    const context = vm.createContext({
        chrome: harness.chrome,
        console
    });

    vm.runInContext(backgroundSource, context);
    return harness;
}

test('badge syncs from persisted disabled state when the worker starts', () => {
    const harness = executeBackgroundScript({ enabled: false });

    assert.equal(harness.badgeState.text, 'OFF');
    assert.equal(harness.badgeState.backgroundColor, '#ff1744');
    assert.equal(harness.badgeState.textColor, '#ffffff');
});

test('install path preserves an existing disabled state instead of forcing ON', () => {
    const harness = executeBackgroundScript({ enabled: false });

    for (const listener of harness.listeners.onInstalled) {
        listener();
    }

    assert.equal(harness.badgeState.text, 'OFF');
});

test('startup listener rehydrates the badge from storage', () => {
    const harness = executeBackgroundScript({ enabled: true });

    harness.chrome.storage.local.set({ features: { enabled: false } });

    for (const listener of harness.listeners.onStartup) {
        listener();
    }

    assert.equal(harness.badgeState.text, 'OFF');
});
