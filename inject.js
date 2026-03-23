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
    const origRemoveEventListener = EventTarget.prototype.removeEventListener;
    const origPreventDefault = Event.prototype.preventDefault;
    const origSetInterval = window.setInterval;
    const origSetTimeout = window.setTimeout;
    const nativePrint = window.print.bind(window);
    const propertyGateReplayers = [];

    const state = {
        flags: { ...incomingFlags },
        blockedEvents: new Set(),
        blockedDocumentProps: new Set(),
        blockedWindowProps: new Set(),
        pendingEventListeners: [],
        pendingDefineProperties: []
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
            // Trade-off: blocks ALL visibilitychange listeners (analytics, video
            // pause-on-hide, etc.), not just anti-cheat or focus-tracking ones.
            // This is intentional — there is no reliable way to distinguish
            // legitimate from adversarial use of this event.
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
            // Trade-off: 'unload' is blocked in addition to 'beforeunload' to
            // prevent sites from firing exit dialogs via either event. This also
            // silences legitimate unload cleanup (e.g. SPA router teardown).
            // Accepted since SPAs primarily use pagehide/visibilitychange instead.
            state.blockedEvents.add('unload');
        }
    }

    function eventCaptureKey(options) {
        if (options === undefined) return false;
        if (typeof options === 'boolean') return options;
        return !!options?.capture;
    }

    function queuePendingEventListener(target, type, listener, options) {
        state.pendingEventListeners.push({
            target,
            type,
            listener,
            options,
            capture: eventCaptureKey(options)
        });
    }

    function removePendingEventListener(target, type, listener, options) {
        const capture = eventCaptureKey(options);
        state.pendingEventListeners = state.pendingEventListeners.filter((entry) => {
            return !(entry.target === target &&
                entry.type === type &&
                entry.listener === listener &&
                entry.capture === capture);
        });
    }

    function replayPendingEventListeners() {
        state.pendingEventListeners = state.pendingEventListeners.filter((entry) => {
            if (state.blockedEvents.has(entry.type)) return true;
            try {
                Reflect.apply(origAddEventListener, entry.target, [entry.type, entry.listener, entry.options]);
            } catch (_) { }
            return false;
        });
    }

    function isDefinePropertyBlocked(obj, prop) {
        return (obj === document && state.blockedDocumentProps.has(prop)) ||
            (obj === window && state.blockedWindowProps.has(prop));
    }

    function queuePendingDefineProperty(obj, prop, descriptor) {
        state.pendingDefineProperties = state.pendingDefineProperties.filter((entry) => {
            return !(entry.obj === obj && entry.prop === prop);
        });

        state.pendingDefineProperties.push({ obj, prop, descriptor });
    }

    function replayPendingDefineProperties() {
        state.pendingDefineProperties = state.pendingDefineProperties.filter((entry) => {
            if (isDefinePropertyBlocked(entry.obj, entry.prop)) return true;
            try {
                origDefineProperty(entry.obj, entry.prop, entry.descriptor);
            } catch (_) { }
            return false;
        });
    }

    function updateFlags(nextFlags = {}) {
        state.flags = { ...state.flags, ...nextFlags };
        syncBlockedGuards();
        replayPendingEventListeners();
        replayPendingDefineProperties();
        propertyGateReplayers.forEach((replay) => replay());
    }

    function installEventPropertyGate(target, prop, isBlocked) {
        if (!target) return;

        const descriptor = findDescriptor(target, prop);
        if (!descriptor) return;

        const fallbackValues = new Map();
        const blockedValues = new Map();

        function replayPendingAssignments() {
            if (isBlocked()) return;
            for (const [receiver, value] of blockedValues.entries()) {
                try {
                    if (typeof descriptor.set === 'function') {
                        descriptor.set.call(receiver, value);
                    } else {
                        fallbackValues.set(receiver, value);
                    }
                } catch (_) { }
                blockedValues.delete(receiver);
            }
        }

        propertyGateReplayers.push(replayPendingAssignments);

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
                    if (isBlocked()) {
                        blockedValues.set(this, value);
                        return true;
                    }

                    blockedValues.delete(this);
                    if (typeof descriptor.set === 'function') {
                        descriptor.set.call(this, value);
                        return true;
                    }
                    fallbackValues.set(this, value);
                    return true;
                },
                configurable: descriptor.configurable ?? true,
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
                if (isDefinePropertyBlocked(obj, prop)) {
                    queuePendingDefineProperty(obj, prop, argumentsList[2]);
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
                if (state.blockedEvents.has(type)) {
                    queuePendingEventListener(thisArg, type, argumentsList[1], argumentsList[2]);
                    return;
                }
                return Reflect.apply(target, thisArg, argumentsList);
            }
        });
    } catch (_) { }

    try {
        EventTarget.prototype.removeEventListener = new Proxy(origRemoveEventListener, {
            apply(target, thisArg, argumentsList) {
                removePendingEventListener(thisArg, argumentsList[0], argumentsList[1], argumentsList[2]);
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
                if (funcStr.includes('debugger')) return 0; // 0 is the no-op timer ID; clearTimeout(0) is safe
                return Reflect.apply(target, thisArg, argumentsList);
            }
        });

        window.setTimeout = new Proxy(origSetTimeout, {
            apply(target, thisArg, argumentsList) {
                if (!featureEnabled('keyboardUnblock')) {
                    return Reflect.apply(target, thisArg, argumentsList);
                }

                const funcStr = String(argumentsList[0]);
                if (funcStr.includes('debugger')) return 0; // 0 is the no-op timer ID; clearTimeout(0) is safe
                return Reflect.apply(target, thisArg, argumentsList);
            }
        });
    } catch (_) { }

    const hiddenDescriptor = findDescriptor(document, 'hidden');
    const visibilityStateDescriptor = findDescriptor(document, 'visibilityState');
    const printDescriptor = findDescriptor(window, 'print');

    try {
        if (hiddenDescriptor && typeof hiddenDescriptor.get === 'function') {
            origDefineProperty(document, 'hidden', {
                get() {
                    if (featureEnabled('visibilityBypass')) return false;
                    return hiddenDescriptor.get.call(document);
                },
                configurable: hiddenDescriptor.configurable ?? true,
                enumerable: hiddenDescriptor.enumerable ?? false
            });
        }

        if (visibilityStateDescriptor && typeof visibilityStateDescriptor.get === 'function') {
            origDefineProperty(document, 'visibilityState', {
                get() {
                    if (featureEnabled('visibilityBypass')) return 'visible';
                    return visibilityStateDescriptor.get.call(document);
                },
                configurable: visibilityStateDescriptor.configurable ?? true,
                enumerable: visibilityStateDescriptor.enumerable ?? false
            });
        }
    } catch (_) { }

    try {
        let assignedPrint = null;
        let blockedPrintAssignment = null;

        origDefineProperty(window, 'print', {
            get() {
                if (featureEnabled('printUnlock')) return nativePrint;
                return assignedPrint || nativePrint;
            },
            set(value) {
                if (featureEnabled('printUnlock')) {
                    blockedPrintAssignment = value;
                    return true;
                }
                assignedPrint = value;
                return true;
            },
            configurable: printDescriptor?.configurable ?? true,
            enumerable: printDescriptor?.enumerable ?? false
        });

        propertyGateReplayers.push(() => {
            if (!featureEnabled('printUnlock') && blockedPrintAssignment) {
                assignedPrint = blockedPrintAssignment;
                blockedPrintAssignment = null;
            }
        });
    } catch (_) { }
})();
