const test = require('node:test');
const assert = require('node:assert/strict');

const { createInjectHarness } = require('../test-support/helpers');

function createFlags(overrides = {}) {
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

test('blocked event listeners can be added again after the feature is disabled', () => {
    const { document, updateFlags, window } = createInjectHarness(createFlags({ rightClick: true }));
    let fired = 0;

    document.addEventListener('contextmenu', () => {
        fired += 1;
    });

    document.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true }));
    assert.equal(fired, 0);

    updateFlags(createFlags({ rightClick: false }));

    document.addEventListener('contextmenu', () => {
        fired += 1;
    });

    document.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true }));
    assert.equal(fired, 2);
});

test('blocked event listeners are replayed after the feature is disabled', () => {
    const { document, updateFlags, window } = createInjectHarness(createFlags({ rightClick: true }));
    let fired = 0;

    document.addEventListener('contextmenu', () => {
        fired += 1;
    });

    updateFlags(createFlags({ rightClick: false }));

    document.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true }));
    assert.equal(fired, 1);
});

test('disabled flags do not block listeners in the first place', () => {
    const { document, window } = createInjectHarness(createFlags({ enabled: false, rightClick: true }));
    let fired = 0;

    document.addEventListener('contextmenu', () => {
        fired += 1;
    });

    document.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true }));
    assert.equal(fired, 1);
});

test('window.print can be reassigned once print unlock is turned off', () => {
    const { updateFlags, window } = createInjectHarness(createFlags({ printUnlock: true }));
    const replacement = () => 'custom-print';

    window.print = replacement;
    assert.notEqual(window.print, replacement);

    updateFlags(createFlags({ printUnlock: false }));

    assert.equal(window.print, replacement);
});
