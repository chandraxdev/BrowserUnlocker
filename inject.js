// BrowserUnlocker - Page-Context Injected Script
//
// ARCHITECTURE NOTE:
// This script is injected directly into the main page context (DOM).
// Content scripts live in an isolated sandbox, but BrowserUnlocker needs to
// override native browser APIs (like EventTarget.prototype.addEventListener)
// to prevent sites from detecting or blocking user interactions.

(function () {
    'use strict';

    // Communication:
    // This script receives configuration flags via the dataset of the script tag
    // that injected it (set by content.js).
    const scriptTag = document.currentScript;
    if (!scriptTag) return;

    const flags = JSON.parse(scriptTag.dataset.flags || '{}');

    // --- Utility ------------------------------------------------
    const noop = () => { };

    function killEventProperty(proto, prop) {
        try {
            Object.defineProperty(proto, prop, {
                get() { return noop; },
                set() { /* swallow */ },
                configurable: false,
                enumerable: true
            });
        } catch (_) { }
    }

    // --- Stealth Protections ------------------------------------
    //
    // SAFETY: We only block specific, known restriction-related properties.
    // The previous broad prop.startsWith('on') silently broke frameworks
    // (Angular, React) that use Object.defineProperty for data binding.
    //
    const origDefineProperty = Object.defineProperty;

    // Build a set of blocked document properties based on active feature flags
    const blockedDocProps = new Set();
    if (flags.visibilityBypass) {
        blockedDocProps.add('hidden');
        blockedDocProps.add('visibilityState');
        blockedDocProps.add('onvisibilitychange');
    }
    if (flags.forcePaste) blockedDocProps.add('onpaste');
    if (flags.forceCopy) {
        blockedDocProps.add('oncopy');
        blockedDocProps.add('oncut');
    }
    if (flags.rightClick) blockedDocProps.add('oncontextmenu');
    if (flags.unlockSelection) blockedDocProps.add('onselectstart');
    if (flags.dragDropUnlock) blockedDocProps.add('ondragstart');
    if (flags.beforeUnloadBypass) {
        blockedDocProps.add('onbeforeunload');
        blockedDocProps.add('onunload');
    }

    try {
        Object.defineProperty = new Proxy(origDefineProperty, {
            apply(target, thisArg, argumentsList) {
                const [obj, prop] = argumentsList;
                // Only block properties we explicitly care about
                if (obj === document && blockedDocProps.has(prop)) {
                    return obj;
                }
                if (obj === window && prop === 'print' && flags.printUnlock) return obj;
                return Reflect.apply(target, thisArg, argumentsList);
            }
        });
    } catch (_) { /* Frozen prototype - skip gracefully */ }

    // --- Global Event Interception ------------------------------
    //
    // By Proxying EventTarget.prototype.addEventListener, we can silently
    // ignore specific event listeners (like 'paste' or 'contextmenu')
    // before they are even registered by the page's scripts.
    //
    const blockedEvents = new Set();

    try {
        const origAddEventListener = EventTarget.prototype.addEventListener;
        EventTarget.prototype.addEventListener = new Proxy(origAddEventListener, {
            apply(target, thisArg, argumentsList) {
                const type = argumentsList[0];
                if (blockedEvents.has(type)) return;
                return Reflect.apply(target, thisArg, argumentsList);
            }
        });
    } catch (_) { /* Frozen prototype - skip gracefully */ }

    // --- Force Paste --------------------------------------------
    if (flags.forcePaste) {
        blockedEvents.add('paste');
        killEventProperty(HTMLInputElement.prototype, 'onpaste');
        killEventProperty(HTMLTextAreaElement.prototype, 'onpaste');
        killEventProperty(HTMLElement.prototype, 'onpaste');
        killEventProperty(Document.prototype, 'onpaste');
    }

    // --- Force Copy and Cut -------------------------------------
    if (flags.forceCopy) {
        blockedEvents.add('copy');
        blockedEvents.add('cut');
        killEventProperty(HTMLElement.prototype, 'oncopy');
        killEventProperty(HTMLElement.prototype, 'oncut');
        killEventProperty(Document.prototype, 'oncopy');
        killEventProperty(Document.prototype, 'oncut');
    }

    // --- Unlock Selection ---------------------------------------
    if (flags.unlockSelection) {
        blockedEvents.add('selectstart');
        killEventProperty(Document.prototype, 'onselectstart');
        killEventProperty(HTMLElement.prototype, 'onselectstart');
    }

    // --- Right-Click --------------------------------------------
    if (flags.rightClick) {
        blockedEvents.add('contextmenu');
        killEventProperty(Document.prototype, 'oncontextmenu');
        killEventProperty(HTMLElement.prototype, 'oncontextmenu');
        killEventProperty(window, 'oncontextmenu');
    }

    // --- Drag and Drop Unlock -----------------------------------
    if (flags.dragDropUnlock) {
        blockedEvents.add('dragstart');
        killEventProperty(HTMLElement.prototype, 'ondragstart');
        killEventProperty(Document.prototype, 'ondragstart');
    }

    // --- Keyboard Shortcut Unblock ------------------------------
    if (flags.keyboardUnblock) {
        try {
            // Don't fully block keydown (pages need it), but neuter handlers that
            // detect dev-tools / view-source shortcuts and call preventDefault.
            const origPreventDefault = Event.prototype.preventDefault;
            const protectedKeys = new Set(['F12', 'F5', 'F7']);
            const protectedCombos = [
                { ctrl: true, key: 'u' },
                { ctrl: true, key: 's' },
                { ctrl: true, key: 'p' },
                { ctrl: true, key: 'a' },
                { ctrl: true, shift: true, key: 'i' },
                { ctrl: true, shift: true, key: 'j' },
                { ctrl: true, shift: true, key: 'c' },
            ];

            Event.prototype.preventDefault = new Proxy(origPreventDefault, {
                apply(target, thisArg, argumentsList) {
                    if (thisArg instanceof KeyboardEvent) {
                        const e = thisArg;
                        if (!e.key) return Reflect.apply(target, thisArg, argumentsList);
                        if (protectedKeys.has(e.key)) return;
                        for (const combo of protectedCombos) {
                            if ((e.ctrlKey || e.metaKey) === !!combo.ctrl &&
                                e.shiftKey === !!combo.shift &&
                                e.key.toLowerCase() === combo.key) {
                                return;
                            }
                        }
                    }
                    return Reflect.apply(target, thisArg, argumentsList);
                }
            });
        } catch (_) { /* Frozen prototype - skip gracefully */ }

        // Anti-Debugger Trap:
        // Some sites use infinite debugger loops to freeze the browser
        // if they detect DevTools. We neutralize these by proxying timers.
        try {
            const origSetInterval = window.setInterval;
            window.setInterval = new Proxy(origSetInterval, {
                apply(target, thisArg, argumentsList) {
                    const funcStr = String(argumentsList[0]);
                    if (funcStr.includes('debugger')) return -1;
                    return Reflect.apply(target, thisArg, argumentsList);
                }
            });
            const origSetTimeout = window.setTimeout;
            window.setTimeout = new Proxy(origSetTimeout, {
                apply(target, thisArg, argumentsList) {
                    const funcStr = String(argumentsList[0]);
                    if (funcStr.includes('debugger')) return -1;
                    return Reflect.apply(target, thisArg, argumentsList);
                }
            });
        } catch (_) { /* Frozen prototype - skip gracefully */ }
    }

    // --- Visibility API Bypass ----------------------------------
    if (flags.visibilityBypass) {
        try {
            origDefineProperty(document, 'hidden', {
                get() { return false; },
                configurable: false
            });
            origDefineProperty(document, 'visibilityState', {
                get() { return 'visible'; },
                configurable: false
            });
        } catch (_) { }
        blockedEvents.add('visibilitychange');
        killEventProperty(Document.prototype, 'onvisibilitychange');
    }

    // --- Print Unlock -------------------------------------------
    if (flags.printUnlock) {
        try {
            const nativePrint = window.print.bind(window);
            Object.defineProperty(window, 'print', {
                get() { return nativePrint; },
                set() { /* block overrides */ },
                configurable: false
            });
        } catch (_) { }

        blockedEvents.add('beforeprint');
        blockedEvents.add('afterprint');
    }

    // --- BeforeUnload Dialog Bypass -----------------------------
    if (flags.beforeUnloadBypass) {
        blockedEvents.add('beforeunload');
        blockedEvents.add('unload');
        killEventProperty(window, 'onbeforeunload');
        killEventProperty(window, 'onunload');
    }
})();
