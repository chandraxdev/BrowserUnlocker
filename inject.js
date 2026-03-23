// BrowserUnlocker - Page-context injected script
//
// This script runs in the page's main world so it can wrap native APIs that
// content scripts cannot reach directly.

(function () {
    'use strict';

    let incomingFlags = {};
    try {
        const scriptTag = document.currentScript;
        if (scriptTag && scriptTag.dataset.flags) {
            // Legacy path: external src injection (kept for compatibility)
            incomingFlags = JSON.parse(scriptTag.dataset.flags);
        } else if (window.__BU_INIT_FLAGS__) {
            // Inline injection path: flags delivered via window global
            incomingFlags = window.__BU_INIT_FLAGS__;
            delete window.__BU_INIT_FLAGS__;
        }
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
    const origFetch = typeof window.fetch === 'function' ? window.fetch.bind(window) : null;
    const origXHROpen = XMLHttpRequest.prototype.open;
    const origXHRSend = XMLHttpRequest.prototype.send;
    const propertyGateReplayers = [];

    const state = {
        flags: { ...incomingFlags },
        blockedEvents: new Set(),
        blockedDocumentProps: new Set(),
        blockedWindowProps: new Set(),
        pendingEventListeners: [],
        pendingDefineProperties: []
    };

    // Captured once at init from the script tag — never changes, not a user flag.
    const ownExtId = incomingFlags._extId || '';

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

    // ── Extension Hide ──────────────────────────────────────────────────────
    // Defends against extension detection and monitoring extension relays.
    //
    // AV1 – Monitoring extensions relay chrome.management.getAll() results to
    //        the page via postMessage. We intercept, sanitize (empty all extension
    //        arrays), and re-dispatch — the site's listener still fires, just with
    //        a clean payload reporting no extensions.
    //
    // AV2 – Sites WAR-probe for installed extensions via fetch / XHR.
    //        Requests to our own extension ID are rejected (hide us).
    //        Requests to any other extension ID return a fake 200 (appear installed).
    //        This means a site probing for a required monitoring extension will
    //        receive a success response even if that extension is not installed.
    //
    // AV3 – Sites enumerate injected DOM elements by src/href attribute.
    //        content.js strips IDs; here we filter querySelectorAll / querySelector.
    //
    // Trade-off (AV1): Heuristic is probabilistic (score ≥ 2). A false-positive on
    // a legitimate cross-origin message re-dispatches a sanitized copy — the listener
    // still fires, just with empty extension arrays instead of being silently dropped.
    //
    // Trade-off (AV2): Returning fake 200 for all non-self extension URLs means
    // the site cannot WAR-detect any extension, not just BrowserUnlocker.
    // Accepted — this provides the strongest stealth posture.

    // AV1 — postMessage interception: sanitize payload and re-dispatch
    try {
        const EXT_ID_RE = /\b[a-p]{32}\b/;
        let _reDispatching = false;

        function looksLikeExtensionPayload(data) {
            if (!data || typeof data !== 'object') return false;
            let score = 0;
            let str = '';
            try { str = JSON.stringify(data); } catch (_) { str = ''; }
            if (EXT_ID_RE.test(str)) score++;
            if (Array.isArray(data) && data.length > 0 && typeof data[0] === 'object' &&
                (data[0]?.id || data[0]?.extensionId)) score++;
            if ('extensions' in data || 'installedExtensions' in data || 'chromeExtensions' in data) score++;
            if (typeof data.id === 'string' && EXT_ID_RE.test(data.id) && typeof data.name === 'string') score++;
            return score >= 2;
        }

        function sanitizeExtensionPayload(data) {
            if (Array.isArray(data)) return [];
            const out = { ...data };
            for (const key of ['extensions', 'installedExtensions', 'chromeExtensions', 'addons', 'plugins']) {
                if (key in out) out[key] = [];
            }
            return out;
        }

        Reflect.apply(origAddEventListener, window, ['message', (e) => {
            if (!featureEnabled('extensionHide') || _reDispatching) return;
            try {
                if (looksLikeExtensionPayload(e.data)) {
                    e.stopImmediatePropagation();
                    const sanitized = sanitizeExtensionPayload(e.data);
                    _reDispatching = true;
                    try {
                        window.dispatchEvent(new MessageEvent('message', {
                            data: sanitized,
                            origin: e.origin,
                            source: e.source,
                            lastEventId: e.lastEventId
                        }));
                    } finally {
                        _reDispatching = false;
                    }
                }
            } catch (_) {}
        }, true]);
    } catch (_) { }

    // Returns a content-type-aware fake 200 Response for extension URL probes.
    // .js → empty script (avoids SyntaxError if site eval()s the response),
    // .css → empty stylesheet, everything else → {} JSON.
    function fakeExtensionResponse(url) {
        const isJs = /\.js(\?|$)/.test(url);
        const isCss = /\.css(\?|$)/.test(url);
        const body = isJs ? '' : (isCss ? '' : '{}');
        const type = isJs ? 'application/javascript' : (isCss ? 'text/css' : 'application/json');
        return Promise.resolve(new Response(body, { status: 200, headers: { 'Content-Type': type } }));
    }

    // AV2 — fetch proxy: reject own-extension probes, fake 200 for all others
    if (origFetch) {
        try {
            window.fetch = new Proxy(origFetch, {
                apply(target, thisArg, args) {
                    if (featureEnabled('extensionHide')) {
                        const raw = typeof args[0] === 'string' ? args[0] :
                            (args[0] instanceof URL ? args[0].href : String(args[0]?.url ?? ''));
                        if (/^(chrome|moz|safari)-extension:\/\//.test(raw)) {
                            if (ownExtId && raw.includes(ownExtId)) {
                                // Our own extension — reject so we stay invisible
                                return Promise.reject(new TypeError('Failed to fetch'));
                            }
                            // Any other extension — fake content-type-aware 200
                            return fakeExtensionResponse(raw);
                        }
                    }
                    return Reflect.apply(target, thisArg, args);
                }
            });
        } catch (_) { }
    }

    // AV2 — XHR proxy: reject own-extension probes, fake 200 for all others
    try {
        const _buXhrMode = Symbol('buXhrMode'); // 'reject' | 'fake200' | false
        const _buXhrUrl  = Symbol('buXhrUrl');  // stores URL for content-type detection

        XMLHttpRequest.prototype.open = new Proxy(origXHROpen, {
            apply(target, thisArg, args) {
                const url = String(args[1] ?? '');
                if (featureEnabled('extensionHide') &&
                    /^(chrome|moz|safari)-extension:\/\//.test(url)) {
                    thisArg[_buXhrMode] = (ownExtId && url.includes(ownExtId)) ? 'reject' : 'fake200';
                    thisArg[_buXhrUrl]  = url;
                    return;
                }
                thisArg[_buXhrMode] = false;
                return Reflect.apply(target, thisArg, args);
            }
        });

        XMLHttpRequest.prototype.send = new Proxy(origXHRSend, {
            apply(target, thisArg, args) {
                const mode = thisArg[_buXhrMode];
                if (mode === 'reject') {
                    Reflect.apply(origSetTimeout, window, [() => {
                        try { thisArg.dispatchEvent(new ProgressEvent('error')); } catch (_) {}
                    }, 0]);
                    return;
                }
                if (mode === 'fake200') {
                    const url = thisArg[_buXhrUrl] || '';
                    const isJs = /\.js(\?|$)/.test(url);
                    const isCss = /\.css(\?|$)/.test(url);
                    const body = isJs ? '' : (isCss ? '' : '{}');
                    Reflect.apply(origSetTimeout, window, [() => {
                        try {
                            origDefineProperty(thisArg, 'readyState', { get: () => 4, configurable: true });
                            origDefineProperty(thisArg, 'status', { get: () => 200, configurable: true });
                            origDefineProperty(thisArg, 'responseText', { get: () => body, configurable: true });
                            origDefineProperty(thisArg, 'response', { get: () => body, configurable: true });
                            thisArg.dispatchEvent(new ProgressEvent('load'));
                            thisArg.dispatchEvent(new ProgressEvent('loadend'));
                        } catch (_) {}
                    }, 0]);
                    return;
                }
                return Reflect.apply(target, thisArg, args);
            }
        });
    } catch (_) { }

    // AV3 — DOM trace defense: filter extension-origin elements from query results
    try {
        const origQSA = Document.prototype.querySelectorAll;
        const origQS = Document.prototype.querySelector;

        function isExtensionElement(el) {
            const src = el.getAttribute ? (el.getAttribute('src') || '') : '';
            const href = el.getAttribute ? (el.getAttribute('href') || '') : '';
            return /^(chrome|moz|safari)-extension:\/\//.test(src) ||
                /^(chrome|moz|safari)-extension:\/\//.test(href);
        }

        Document.prototype.querySelectorAll = new Proxy(origQSA, {
            apply(target, thisArg, args) {
                const results = Reflect.apply(target, thisArg, args);
                if (!featureEnabled('extensionHide')) return results;
                const arr = Array.from(results);
                const filtered = arr.filter((el) => !isExtensionElement(el));
                if (filtered.length === arr.length) return results;
                return Object.assign(filtered, { item: (i) => filtered[i] ?? null });
            }
        });

        Document.prototype.querySelector = new Proxy(origQS, {
            apply(target, thisArg, args) {
                const result = Reflect.apply(target, thisArg, args);
                if (!featureEnabled('extensionHide')) return result;
                if (result && isExtensionElement(result)) return null;
                return result;
            }
        });
    } catch (_) { }

    // AV4 — Performance API: filter extension-origin entries from timing data
    // Sites call performance.getEntries() / getEntriesByType('resource') to find
    // chrome-extension:// URLs that appear when an extension injects resources.
    // With inline injection inject.js never appears here — but other extensions or
    // future code might, so we filter proactively.
    try {
        const EXT_PERF_RE = /^(chrome|moz|safari)-extension:\/\//;

        function filterPerfEntries(entries) {
            const arr = Array.from(entries);
            return arr.filter(e => !EXT_PERF_RE.test(e.name));
        }

        const origGetEntries        = Performance.prototype.getEntries;
        const origGetEntriesByType  = Performance.prototype.getEntriesByType;
        const origGetEntriesByName  = Performance.prototype.getEntriesByName;

        Performance.prototype.getEntries = new Proxy(origGetEntries, {
            apply(target, thisArg, args) {
                const r = Reflect.apply(target, thisArg, args);
                return featureEnabled('extensionHide') ? filterPerfEntries(r) : r;
            }
        });

        Performance.prototype.getEntriesByType = new Proxy(origGetEntriesByType, {
            apply(target, thisArg, args) {
                const r = Reflect.apply(target, thisArg, args);
                return featureEnabled('extensionHide') ? filterPerfEntries(r) : r;
            }
        });

        Performance.prototype.getEntriesByName = new Proxy(origGetEntriesByName, {
            apply(target, thisArg, args) {
                const r = Reflect.apply(target, thisArg, args);
                return featureEnabled('extensionHide') ? filterPerfEntries(r) : r;
            }
        });
    } catch (_) { }

    // AV5 — Navigator probing: mask plugins / mimeTypes with empty frozen arrays
    // Modern Chrome already returns empty PluginArrays in most contexts, but
    // some detection scripts still enumerate navigator.plugins as a fingerprint.
    try {
        const _emptyPluginArray = Object.freeze(
            Object.assign([], { item: () => null, namedItem: () => null, refresh: () => {} })
        );
        const _emptyMimeTypeArray = Object.freeze(
            Object.assign([], { item: () => null, namedItem: () => null })
        );

        const pluginsDesc    = findDescriptor(Navigator.prototype, 'plugins') ||
                               findDescriptor(navigator, 'plugins');
        const mimeTypesDesc  = findDescriptor(Navigator.prototype, 'mimeTypes') ||
                               findDescriptor(navigator, 'mimeTypes');

        if (pluginsDesc) {
            origDefineProperty(Navigator.prototype, 'plugins', {
                get() {
                    if (!featureEnabled('extensionHide')) {
                        return pluginsDesc.get ? pluginsDesc.get.call(this) : pluginsDesc.value;
                    }
                    return _emptyPluginArray;
                },
                configurable: pluginsDesc.configurable ?? true,
                enumerable:   pluginsDesc.enumerable   ?? true
            });
        }

        if (mimeTypesDesc) {
            origDefineProperty(Navigator.prototype, 'mimeTypes', {
                get() {
                    if (!featureEnabled('extensionHide')) {
                        return mimeTypesDesc.get ? mimeTypesDesc.get.call(this) : mimeTypesDesc.value;
                    }
                    return _emptyMimeTypeArray;
                },
                configurable: mimeTypesDesc.configurable ?? true,
                enumerable:   mimeTypesDesc.enumerable   ?? true
            });
        }
    } catch (_) { }
})();
