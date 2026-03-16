// BrowserUnlocker - Page-context injected script
//
// This script runs in the page's main world so it can wrap native APIs that
// content scripts cannot reach directly.

(function () {
    'use strict';

    const scriptTag = document.currentScript;
    if (!scriptTag) return;

    let incomingFlags = {};
    try {
        incomingFlags = JSON.parse(scriptTag.dataset.flags || '{}');
    } catch (_) { }

    const STATE_KEY = '__browserUnlockerMainWorld';
    const existingState = window[STATE_KEY];
    if (existingState && typeof existingState.updateFlags === 'function') {
        existingState.updateFlags(incomingFlags);
        return;
    }

    const noop = () => { };
    const origDefineProperty = Object.defineProperty;
    const origAddEventListener = EventTarget.prototype.addEventListener;
    const origPreventDefault = Event.prototype.preventDefault;
    const origSetInterval = window.setInterval;
    const origSetTimeout = window.setTimeout;
    const nativePrint = window.print.bind(window);

    const state = {
        flags: { ...incomingFlags },
        blockedEvents: new Set(),
        blockedDocumentProps: new Set(),
        blockedWindowProps: new Set()
    };

    function featureEnabled(flagName) {
        return !!state.flags.enabled && !!state.flags[flagName];
    }

    function findDescriptor(target, prop) {
        let cursor = target;
        while (cursor) {
            const descriptor = Object.getOwnPropertyDescriptor(cursor, prop);
            if (descriptor) return descriptor;
            cursor = Object.getPrototypeOf(cursor);
        }
        return null;
    }

    function syncBlockedGuards() {
        state.blockedEvents.clear();
        state.blockedDocumentProps.clear();
        state.blockedWindowProps.clear();

        if (!state.flags.enabled) return;

        if (state.flags.visibilityBypass) {
            state.blockedDocumentProps.add('hidden');
            state.blockedDocumentProps.add('visibilityState');
            state.blockedDocumentProps.add('onvisibilitychange');
            state.blockedEvents.add('visibilitychange');
        }

        if (state.flags.forcePaste) {
            state.blockedDocumentProps.add('onpaste');
            state.blockedEvents.add('paste');
        }

        if (state.flags.forceCopy) {
            state.blockedDocumentProps.add('oncopy');
            state.blockedDocumentProps.add('oncut');
            state.blockedEvents.add('copy');
            state.blockedEvents.add('cut');
        }

        if (state.flags.rightClick) {
            state.blockedDocumentProps.add('oncontextmenu');
            state.blockedWindowProps.add('oncontextmenu');
            state.blockedEvents.add('contextmenu');
        }

        if (state.flags.unlockSelection) {
            state.blockedDocumentProps.add('onselectstart');
            state.blockedEvents.add('selectstart');
        }

        if (state.flags.dragDropUnlock) {
            state.blockedDocumentProps.add('ondragstart');
            state.blockedEvents.add('dragstart');
        }

        if (state.flags.printUnlock) {
            state.blockedWindowProps.add('print');
            state.blockedEvents.add('beforeprint');
            state.blockedEvents.add('afterprint');
        }

        if (state.flags.beforeUnloadBypass) {
            state.blockedWindowProps.add('onbeforeunload');
            state.blockedWindowProps.add('onunload');
            state.blockedEvents.add('beforeunload');
            state.blockedEvents.add('unload');
        }
    }

    function updateFlags(nextFlags = {}) {
        state.flags = { ...state.flags, ...nextFlags };
        syncBlockedGuards();
    }

    function installEventPropertyGate(target, prop, isBlocked) {
        if (!target) return;

        const descriptor = findDescriptor(target, prop);
        if (!descriptor) return;

        const fallbackValues = new WeakMap();

        try {
            origDefineProperty(target, prop, {
                get() {
                    if (isBlocked()) return noop;
                    if (typeof descriptor.get === 'function') {
                        return descriptor.get.call(this);
                    }
                    if (fallbackValues.has(this)) {
                        return fallbackValues.get(this);
                    }
                    return descriptor.value;
                },
                set(value) {
                    if (isBlocked()) return true;
                    if (typeof descriptor.set === 'function') {
                        descriptor.set.call(this, value);
                        return true;
                    }
                    fallbackValues.set(this, value);
                    return true;
                },
                configurable: false,
                enumerable: descriptor.enumerable ?? true
            });
        } catch (_) { }
    }

    syncBlockedGuards();

    document.addEventListener('BU_UPDATE_FLAGS', (event) => {
        updateFlags(event.detail || {});
    });

    try {
        origDefineProperty(window, STATE_KEY, {
            value: { updateFlags },
            configurable: false,
            enumerable: false,
            writable: false
        });
    } catch (_) {
        window[STATE_KEY] = { updateFlags };
    }

    try {
        Object.defineProperty = new Proxy(origDefineProperty, {
            apply(target, thisArg, argumentsList) {
                const [obj, prop] = argumentsList;
                if (obj === document && state.blockedDocumentProps.has(prop)) {
                    return obj;
                }
                if (obj === window && state.blockedWindowProps.has(prop)) {
                    return obj;
                }
                return Reflect.apply(target, thisArg, argumentsList);
            }
        });
    } catch (_) { }

    try {
        EventTarget.prototype.addEventListener = new Proxy(origAddEventListener, {
            apply(target, thisArg, argumentsList) {
                const type = argumentsList[0];
                if (state.blockedEvents.has(type)) return;
                return Reflect.apply(target, thisArg, argumentsList);
            }
        });
    } catch (_) { }

    installEventPropertyGate(HTMLInputElement.prototype, 'onpaste', () => featureEnabled('forcePaste'));
    installEventPropertyGate(HTMLTextAreaElement.prototype, 'onpaste', () => featureEnabled('forcePaste'));
    installEventPropertyGate(HTMLElement.prototype, 'onpaste', () => featureEnabled('forcePaste'));
    installEventPropertyGate(Document.prototype, 'onpaste', () => featureEnabled('forcePaste'));

    installEventPropertyGate(HTMLElement.prototype, 'oncopy', () => featureEnabled('forceCopy'));
    installEventPropertyGate(HTMLElement.prototype, 'oncut', () => featureEnabled('forceCopy'));
    installEventPropertyGate(Document.prototype, 'oncopy', () => featureEnabled('forceCopy'));
    installEventPropertyGate(Document.prototype, 'oncut', () => featureEnabled('forceCopy'));

    installEventPropertyGate(Document.prototype, 'onselectstart', () => featureEnabled('unlockSelection'));
    installEventPropertyGate(HTMLElement.prototype, 'onselectstart', () => featureEnabled('unlockSelection'));

    installEventPropertyGate(Document.prototype, 'oncontextmenu', () => featureEnabled('rightClick'));
    installEventPropertyGate(HTMLElement.prototype, 'oncontextmenu', () => featureEnabled('rightClick'));
    installEventPropertyGate(window, 'oncontextmenu', () => featureEnabled('rightClick'));

    installEventPropertyGate(HTMLElement.prototype, 'ondragstart', () => featureEnabled('dragDropUnlock'));
    installEventPropertyGate(Document.prototype, 'ondragstart', () => featureEnabled('dragDropUnlock'));

    installEventPropertyGate(Document.prototype, 'onvisibilitychange', () => featureEnabled('visibilityBypass'));
    installEventPropertyGate(window, 'onbeforeunload', () => featureEnabled('beforeUnloadBypass'));
    installEventPropertyGate(window, 'onunload', () => featureEnabled('beforeUnloadBypass'));

    try {
        const protectedKeys = new Set(['F12', 'F5', 'F7']);
        const protectedCombos = [
            { ctrl: true, key: 'u' },
            { ctrl: true, key: 's' },
            { ctrl: true, key: 'p' },
            { ctrl: true, key: 'a' },
            { ctrl: true, shift: true, key: 'i' },
            { ctrl: true, shift: true, key: 'j' },
            { ctrl: true, shift: true, key: 'c' }
        ];

        Event.prototype.preventDefault = new Proxy(origPreventDefault, {
            apply(target, thisArg, argumentsList) {
                if (!featureEnabled('keyboardUnblock') || !(thisArg instanceof KeyboardEvent)) {
                    return Reflect.apply(target, thisArg, argumentsList);
                }

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

                return Reflect.apply(target, thisArg, argumentsList);
            }
        });
    } catch (_) { }

    try {
        window.setInterval = new Proxy(origSetInterval, {
            apply(target, thisArg, argumentsList) {
                if (!featureEnabled('keyboardUnblock')) {
                    return Reflect.apply(target, thisArg, argumentsList);
                }

                const funcStr = String(argumentsList[0]);
                if (funcStr.includes('debugger')) return -1;
                return Reflect.apply(target, thisArg, argumentsList);
            }
        });

        window.setTimeout = new Proxy(origSetTimeout, {
            apply(target, thisArg, argumentsList) {
                if (!featureEnabled('keyboardUnblock')) {
                    return Reflect.apply(target, thisArg, argumentsList);
                }

                const funcStr = String(argumentsList[0]);
                if (funcStr.includes('debugger')) return -1;
                return Reflect.apply(target, thisArg, argumentsList);
            }
        });
    } catch (_) { }

    const hiddenDescriptor = findDescriptor(document, 'hidden');
    const visibilityStateDescriptor = findDescriptor(document, 'visibilityState');

    try {
        if (hiddenDescriptor && typeof hiddenDescriptor.get === 'function') {
            origDefineProperty(document, 'hidden', {
                get() {
                    if (featureEnabled('visibilityBypass')) return false;
                    return hiddenDescriptor.get.call(document);
                },
                configurable: false
            });
        }

        if (visibilityStateDescriptor && typeof visibilityStateDescriptor.get === 'function') {
            origDefineProperty(document, 'visibilityState', {
                get() {
                    if (featureEnabled('visibilityBypass')) return 'visible';
                    return visibilityStateDescriptor.get.call(document);
                },
                configurable: false
            });
        }
    } catch (_) { }

    try {
        let assignedPrint = null;

        origDefineProperty(window, 'print', {
            get() {
                if (featureEnabled('printUnlock')) return nativePrint;
                return assignedPrint || nativePrint;
            },
            set(value) {
                if (featureEnabled('printUnlock')) return true;
                assignedPrint = value;
                return true;
            },
            configurable: false
        });
    } catch (_) { }
})();
