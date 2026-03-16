const test = require('node:test');
const assert = require('node:assert/strict');

const { createContentHarness, tick } = require('../test-support/helpers');

function createBaseState(overrides = {}) {
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

test('disabled-on-load leaves draggable and overlay state untouched', async () => {
    const { document } = createContentHarness({
        html: `
            <div id="overlay" style="position: fixed; z-index: 1001; opacity: 0.1;"></div>
            <div id="drag" draggable="false"></div>
        `,
        initialState: createBaseState({ enabled: false })
    });

    await tick();

    assert.equal(document.getElementById('drag').getAttribute('draggable'), 'false');
    assert.equal(document.getElementById('overlay').style.display, '');
    assert.equal(document.getElementById('overlay').style.pointerEvents, '');
});

test('overlay and draggable changes restore when toggled back off', async () => {
    const initialState = createBaseState({ enabled: false });
    const { document, sendStateUpdate } = createContentHarness({
        html: `
            <div id="overlay" style="position: fixed; z-index: 1001; opacity: 0.1;"></div>
            <div id="drag" draggable="false"></div>
        `,
        initialState
    });

    sendStateUpdate(createBaseState({ enabled: true, overlayRemoval: true, dragDropUnlock: true }));
    await tick();

    assert.equal(document.getElementById('drag').hasAttribute('draggable'), false);
    assert.equal(document.getElementById('overlay').style.display, 'none');
    assert.equal(document.getElementById('overlay').style.pointerEvents, 'none');

    sendStateUpdate(createBaseState({ enabled: true, overlayRemoval: false, dragDropUnlock: false }));
    await tick();

    assert.equal(document.getElementById('drag').getAttribute('draggable'), 'false');
    assert.equal(document.getElementById('overlay').style.display, '');
    assert.equal(document.getElementById('overlay').style.pointerEvents, '');
});

test('scroll unlock restores prior inline overflow state and lock classes', async () => {
    const { document, sendStateUpdate } = createContentHarness({
        initialState: createBaseState({ scrollUnlock: true }),
        beforeLoad(window) {
            window.document.documentElement.classList.add('locked');
            window.document.body.classList.add('no-scroll');
            window.document.documentElement.style.setProperty('overflow', 'hidden', 'important');
            window.document.body.style.setProperty('overflow-y', 'hidden', 'important');
            window.document.body.style.setProperty('overflow-x', 'hidden', 'important');
        }
    });

    await tick();

    assert.equal(document.documentElement.style.getPropertyValue('overflow'), 'auto');
    assert.equal(document.body.style.getPropertyValue('overflow-y'), 'auto');
    assert.equal(document.body.classList.contains('no-scroll'), false);

    sendStateUpdate(createBaseState({ scrollUnlock: false }));
    await tick();

    assert.equal(document.documentElement.style.getPropertyValue('overflow'), 'hidden');
    assert.equal(document.body.style.getPropertyValue('overflow-y'), 'hidden');
    assert.equal(document.body.style.getPropertyValue('overflow-x'), 'hidden');
    assert.equal(document.body.classList.contains('no-scroll'), true);
    assert.equal(document.documentElement.classList.contains('locked'), true);
});

test('print rules are restored when print unlock is disabled again', async () => {
    let sheet;

    const { sendStateUpdate } = createContentHarness({
        initialState: createBaseState({ printUnlock: true }),
        beforeLoad(window) {
            class FakeMediaRule {
                constructor(conditionText, cssText) {
                    this.conditionText = conditionText;
                    this.cssText = cssText;
                }
            }

            window.CSSMediaRule = FakeMediaRule;

            sheet = {
                cssRules: [
                    new FakeMediaRule('screen', '@media screen { body { color: black; } }'),
                    new FakeMediaRule('print', '@media print { body { display: none; } }')
                ],
                deleteRule(index) {
                    this.cssRules.splice(index, 1);
                },
                insertRule(cssText, index) {
                    this.cssRules.splice(index, 0, new FakeMediaRule('print', cssText));
                }
            };

            Object.defineProperty(window.document, 'styleSheets', {
                configurable: true,
                get() {
                    return [sheet];
                }
            });
        }
    });

    await tick();

    assert.equal(sheet.cssRules.length, 1);
    assert.equal(sheet.cssRules.some((rule) => rule.cssText.includes('display: none')), false);

    sendStateUpdate(createBaseState({ printUnlock: false }));
    await tick();

    assert.equal(sheet.cssRules.length, 2);
    assert.equal(sheet.cssRules.some((rule) => rule.cssText.includes('display: none')), true);
});

test('force copy continues to block late window capture listeners after a toggle cycle', async () => {
    const { document, sendStateUpdate, window } = createContentHarness({
        initialState: createBaseState({ forceCopy: true })
    });
    let copyHits = 0;

    sendStateUpdate(createBaseState({ forceCopy: false }));
    await tick();

    window.addEventListener('copy', (event) => {
        copyHits += 1;
        event.preventDefault();
    }, true);

    document.dispatchEvent(new window.Event('copy', { bubbles: true, cancelable: true }));
    assert.equal(copyHits, 1);

    sendStateUpdate(createBaseState({ forceCopy: true }));
    await tick();

    document.dispatchEvent(new window.Event('copy', { bubbles: true, cancelable: true }));
    assert.equal(copyHits, 1);
});

test('unlock selection still blocks replayed selectstart listeners after master toggle', async () => {
    const { document, sendStateUpdate, window } = createContentHarness({
        html: '<h1 id="target">Selectable text</h1>',
        initialState: createBaseState({ enabled: true, unlockSelection: true })
    });
    let selectHits = 0;

    document.addEventListener('selectstart', (event) => {
        selectHits += 1;
        event.preventDefault();
    });

    document.getElementById('target').dispatchEvent(new window.Event('selectstart', {
        bubbles: true,
        cancelable: true
    }));
    assert.equal(selectHits, 0);

    sendStateUpdate(createBaseState({ enabled: false, unlockSelection: true }));
    await tick();

    document.getElementById('target').dispatchEvent(new window.Event('selectstart', {
        bubbles: true,
        cancelable: true
    }));
    assert.equal(selectHits, 1);

    sendStateUpdate(createBaseState({ enabled: true, unlockSelection: true }));
    await tick();

    document.getElementById('target').dispatchEvent(new window.Event('selectstart', {
        bubbles: true,
        cancelable: true
    }));
    assert.equal(selectHits, 1);
});
