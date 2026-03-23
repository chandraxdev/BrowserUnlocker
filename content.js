// ── BrowserUnlocker – Content Script ──
/**
 * ARCHITECTURE NOTE:
 * The content script is the main coordinator. It runs in an isolated sandbox,
 * allowing it to communicate with the background worker and safely
 * manipulate the DOM via CSS and MutationObservers.
 */

(function () {
    'use strict';

    let features = {};
    let injectedStyleEl = null;
    let injectedScriptEl = null;
    let passwordObserver = null;
    let overlayObserver = null;
    let printStyleObserver = null;
    let enforcerObserver = null;
    let scrollStyleEl = null;

    let initialized = false;
    const SCROLL_LOCK_CLASSES = ['no-scroll', 'noscroll', 'scroll-lock', 'locked', 'overflow-hidden'];
    let scrollRestoreState = new Map();
    const overlayRestoreState = new Map();
    const dragDropRestoreState = new Map();
    const removedPrintRules = new Map();

    // Register the message interceptor immediately — before the async GET_STATE
    // round trip — so it's in place before monitoring extensions can relay their
    // extension list. The handler checks features dynamically, so it activates
    // as soon as GET_STATE populates features.extensionHide.
    setupExtensionHide();

    // ─── Initialization & Messaging ──────────────────────────
    chrome.runtime.sendMessage({ type: 'GET_STATE' }, (state) => {
        if (chrome.runtime.lastError) return;
        features = state || {};
        if (features.enabled) initOnce();
        syncDomState();
    });

    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.type === 'STATE_UPDATE') {
            const hadInjectedScript = !!injectedScriptEl;
            features = msg.features || {};
            if (features.enabled && !initialized) initOnce();
            syncDomState();
            if (hadInjectedScript) {
                document.dispatchEvent(new CustomEvent('BU_UPDATE_FLAGS', { detail: features }));
            }
        }
    });

    function initOnce() {
        if (initialized) return;
        initialized = true;

        // Register all listeners/observers exactly once.
        // They will dynamically check `features.enabled && features.xxx`.
        setupForcePaste();
        setupForceCopy();
        setupSelectionGuard();
        setupRightClick();
        unlockDragDrop();
        setupZapper();
        setupPasswordReveal();
        setupOverlayRemoval();
        setupPrintUnlock();
        setupEnforcer();

        // Perform late sweeps once the full DOM is established, but only if enabled
        window.addEventListener('load', () => {
            if (!features.enabled) return;
            if (features.scrollUnlock) injectScrollCSS();
            runEnforcerPass(document);
            if (features.overlayRemoval) scanAndRemoveOverlays();
            if (features.printUnlock) cleanPrintStyles();
        });
    }

    // Reconcile things that permanently alter the DOM without relying on live events
    function syncDomState() {
        if (!features.enabled) {
            removeAll();
            return;
        }
        
        injectPageScript();

        if (features.unlockSelection) injectSelectionCSS();
        else removeSelectionCSS();

        if (features.scrollUnlock) injectScrollCSS();
        else removeScrollCSS();
        
        if (features.showPassword) {
            processPasswordFields(document.querySelectorAll('input[type="password"]'));
        } else {
            cleanupPasswordFields();
        }

        // Perform sweeps for destructive features (only applies active ones)
        runEnforcerPass(document);
        if (features.overlayRemoval) scanAndRemoveOverlays();
        else restoreOverlayState();

        if (features.dragDropUnlock) unlockExistingDraggables();
        else restoreDraggableState();

        if (features.printUnlock) cleanPrintStyles();
        else restorePrintStyles();

        // Hide extension-injected element IDs from page scripts in stealth mode
        if (features.extensionHide) {
            if (injectedStyleEl) injectedStyleEl.removeAttribute('id');
            if (scrollStyleEl) scrollStyleEl.removeAttribute('id');
        } else {
            if (injectedStyleEl && !injectedStyleEl.id) injectedStyleEl.id = 'bu-unlock-selection';
            if (scrollStyleEl && !scrollStyleEl.id) scrollStyleEl.id = 'bu-unlock-scroll';
        }
    }

    function removeAll() {
        removeSelectionCSS();
        removeScrollCSS();
        cleanupPasswordFields();
        restoreOverlayState();
        restoreDraggableState();
        restorePrintStyles();
    }

    function removeSelectionCSS() {
        if (injectedStyleEl) { injectedStyleEl.remove(); injectedStyleEl = null; }
    }
    function removeScrollCSS() {
        if (scrollStyleEl) { scrollStyleEl.remove(); scrollStyleEl = null; }
        if (scrollRestoreState.size === 0) return;

        for (const state of scrollRestoreState.values()) {
            const { el, removedClasses } = state;
            if (!el) continue;
            restoreInlineProperty(el, 'overflow', state.overflow, state.overflowPriority);
            restoreInlineProperty(el, 'overflow-y', state.overflowY, state.overflowYPriority);
            restoreInlineProperty(el, 'overflow-x', state.overflowX, state.overflowXPriority);
            removedClasses.forEach((className) => el.classList.add(className));
        }

        scrollRestoreState.clear();
    }

    // ─── Inject page-context script ──────────────────────────
    // Inline injection: fetch inject.js via the content-script context (no WAR
    // needed) and set it as textContent. The resulting <script> tag has no src
    // attribute — it is indistinguishable from any other inline page script and
    // produces no chrome-extension:// entries in the DOM, network log, or
    // performance timeline.
    let _injectCodePromise = null;
    function fetchInjectCode() {
        if (!_injectCodePromise) {
            _injectCodePromise = fetch(chrome.runtime.getURL('inject.js')).then(r => r.text());
        }
        return _injectCodePromise;
    }

    function injectPageScript() {
        if (injectedScriptEl) return;
        fetchInjectCode().then(code => {
            if (injectedScriptEl) return; // Guard against concurrent calls during async gap
            window.__BU_INIT_FLAGS__ = { ...features };
            const s = document.createElement('script');
            s.textContent = code;
            (document.documentElement || document.head || document.body).prepend(s);
            injectedScriptEl = s;
            s.remove(); // Inline scripts execute synchronously on insertion; remove from DOM to leave no trace
            // Re-sync flags in case state changed while fetching (_extId already captured by inject.js at init)
            document.dispatchEvent(new CustomEvent('BU_UPDATE_FLAGS', { detail: features }));
        }).catch(() => {});
    }

    // ─── Unlock Selection CSS ────────────────────────────────
    function injectSelectionCSS() {
        if (injectedStyleEl) return;
        const css = `
      *, *::before, *::after {
        -webkit-user-select: text !important;
        user-select: text !important;
        -webkit-touch-callout: default !important;
      }
    `;
        injectedStyleEl = document.createElement('style');
        injectedStyleEl.id = 'bu-unlock-selection';
        injectedStyleEl.textContent = css;
        (document.head || document.documentElement).appendChild(injectedStyleEl);
    }

    function setupSelectionGuard() {
        addGlobalCaptureListener('selectstart', (e) => {
            if (!features.enabled || !features.unlockSelection) return;
            e.stopImmediatePropagation();
        });
    }

    // ─── Scroll Unlock CSS ───────────────────────────────────
    /**
     * SAFETY: Only override `overflow`. Do NOT force `position` or `height`
     * changes persistently — these destroy SPA layouts (banking sites, etc.).
     * Aggressive position/height fixes are applied reactively by the Zapper only.
     */
    function captureScrollRestoreStateFor(el) {
        if (!el || scrollRestoreState.has(el)) return;

        scrollRestoreState.set(el, {
            el,
            overflow: el.style.getPropertyValue('overflow'),
            overflowPriority: el.style.getPropertyPriority('overflow'),
            overflowY: el.style.getPropertyValue('overflow-y'),
            overflowYPriority: el.style.getPropertyPriority('overflow-y'),
            overflowX: el.style.getPropertyValue('overflow-x'),
            overflowXPriority: el.style.getPropertyPriority('overflow-x'),
            removedClasses: SCROLL_LOCK_CLASSES.filter((className) => el.classList.contains(className))
        });
    }

    function captureScrollRestoreState() {
        [document.documentElement, document.body].forEach(captureScrollRestoreStateFor);
    }

    function restoreInlineProperty(el, name, value, priority) {
        if (value) {
            el.style.setProperty(name, value, priority || '');
        } else {
            el.style.removeProperty(name);
        }
    }

    function injectScrollCSS() {
        captureScrollRestoreState();

        if (!scrollStyleEl) {
            const css = `
              html, body {
                overflow: auto !important;
                overflow-y: auto !important;
                overflow-x: auto !important;
              }
            `;
            scrollStyleEl = document.createElement('style');
            scrollStyleEl.id = 'bu-unlock-scroll';
            scrollStyleEl.textContent = css;
            (document.head || document.documentElement).appendChild(scrollStyleEl);
        }

        // Strip inline overflow locks and common scroll-lock classes
        requestAnimationFrame(() => {
            [document.documentElement, document.body].forEach(el => {
                if (!el) return;
                captureScrollRestoreStateFor(el);
                el.style.setProperty('overflow', 'auto', 'important');
                el.style.setProperty('overflow-y', 'auto', 'important');
                el.style.setProperty('overflow-x', 'auto', 'important');
                // Remove common scroll-lock classes used by frameworks (Bootstrap, Tailwind, etc.)
                el.classList.remove(...SCROLL_LOCK_CLASSES);
            });
        });
    }

    /**
     * Aggressive scroll recovery - only called by the Zapper after removing
     * a modal/overlay. This is safe because the user explicitly triggered it.
     */
    function forceAggressiveScrollUnlock() {
        injectScrollCSS();
        requestAnimationFrame(() => {
            [document.documentElement, document.body].forEach(el => {
                if (!el) return;
                if (el.style.position === 'fixed') {
                    el.style.setProperty('position', 'relative', 'important');
                }
            });
        });
    }

    // ─── Late-Binding Recovery (Enforcer) ────────────────────
    function enforceNode(node) {
        if (node.nodeType !== 1) return;
        if (features.forcePaste) node.removeAttribute('onpaste');
        if (features.forceCopy) {
            node.removeAttribute('oncopy');
            node.removeAttribute('oncut');
        }
        if (features.rightClick) node.removeAttribute('oncontextmenu');
        if (features.unlockSelection) node.removeAttribute('onselectstart');
        if (features.dragDropUnlock) {
            node.removeAttribute('ondragstart');
            if (node.getAttribute('draggable') === 'false') {
                if (!dragDropRestoreState.has(node)) {
                    dragDropRestoreState.set(node, node.getAttribute('draggable'));
                }
                node.removeAttribute('draggable');
            }
        }
        if (features.videoUnlock && node.tagName === 'VIDEO') {
            node.controls = true;
            node.style.pointerEvents = 'auto'; // Re-enable clicking if overlaid
        }
        if (features.autocompleteUnlock &&
            (node.tagName === 'FORM' || node.tagName === 'INPUT') &&
            node.getAttribute('autocomplete') === 'off') {
            node.setAttribute('autocomplete', 'on');
        }
    }

    function runEnforcerPass(root = document) {
        if (!features.enabled) return;

        if (root === document) {
            document.querySelectorAll('*').forEach(enforceNode);
            return;
        }

        if (!root || root.nodeType !== 1) return;
        enforceNode(root);
        root.querySelectorAll('*').forEach(enforceNode);
    }

    function setupEnforcer() {
        enforcerObserver = new MutationObserver((mutations) => {
            if (!features.enabled) return;
            let checkCss = false;

            for (const m of mutations) {
                // Enforce on new nodes
                for (const node of m.addedNodes) runEnforcerPass(node);

                // Enforce if an attribute was changed
                if (m.type === 'attributes') enforceNode(m.target);

                // Ensure our CSS remains the last stylesheet in <head>
                if (features.unlockSelection && injectedStyleEl && (m.target === document.head || m.target === document.body)) {
                    if (m.addedNodes.length > 0) checkCss = true;
                }
            }

            if (checkCss && injectedStyleEl && document.head) {
                if (document.head.lastElementChild !== injectedStyleEl) {
                    document.head.appendChild(injectedStyleEl);
                }
            }
        });

        enforcerObserver.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['onpaste', 'oncopy', 'oncut', 'oncontextmenu', 'onselectstart', 'ondragstart', 'draggable', 'autocomplete']
        });
    }

    // ─── Clipboard & Event Restoration ───────────────────────
    // window capture fires before document capture in the propagation chain,
    // so registering on window alone is sufficient to win the race against
    // any site listener at any level. Registering on document as well would
    // cause the handler to fire twice when stopImmediatePropagation is not
    // called (i.e. when the feature is disabled).
    function addGlobalCaptureListener(type, handler) {
        window.addEventListener(type, handler, true);
    }

    /**
     * BrowserUnlocker uses the Capture Phase (true) for event listeners
     * to intercept and stop 'paste' / 'copy' events before the website's
     * own listeners can reach them.
     */
    function setupForcePaste() {
        addGlobalCaptureListener('paste', (e) => {
            if (!features.enabled || !features.forcePaste) return;
            e.stopImmediatePropagation();
            e.preventDefault(); // CRUCIAL: Cancels browser default to prevent double-pasting

            // Get pasted text from clipboard
            const text = (e.clipboardData || window.clipboardData)?.getData('text');
            const target = e.target;

            if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' ||
                target.isContentEditable)) {
                if (target.isContentEditable) {
                    document.execCommand('insertText', false, text);
                } else {
                    const start = target.selectionStart ?? target.value.length;
                    const end = target.selectionEnd ?? target.value.length;
                    const before = target.value.substring(0, start);
                    const after = target.value.substring(end);
                    target.value = before + text + after;
                    target.selectionStart = target.selectionEnd = start + text.length;

                    // Fire input event for frameworks
                    target.dispatchEvent(new Event('input', { bubbles: true }));
                    target.dispatchEvent(new Event('change', { bubbles: true }));
                }
            }
        });
    }

    // ─── Force Copy & Cut ────────────────────────────────────
    function setupForceCopy() {
        addGlobalCaptureListener('copy', (e) => {
            if (!features.enabled || !features.forceCopy) return;
            e.stopImmediatePropagation();
        });

        addGlobalCaptureListener('cut', (e) => {
            if (!features.enabled || !features.forceCopy) return;
            e.stopImmediatePropagation();
        });

        // Also protect Ctrl+C / Ctrl+X / Ctrl+A from being swallowed
        addGlobalCaptureListener('keydown', (e) => {
            if (!features.enabled || !features.forceCopy || !e.key) return;
            const key = e.key.toLowerCase();
            if ((e.ctrlKey || e.metaKey) && (key === 'c' || key === 'x' || key === 'a')) {
                e.stopImmediatePropagation();
            }
        });
    }

    // ─── Right-Click ─────────────────────────────────────────
    function setupRightClick() {
        addGlobalCaptureListener('contextmenu', (e) => {
            if (!features.enabled || !features.rightClick) return;
            e.stopImmediatePropagation();
        });
    }

    // ─── Show Password on Hover / Focus ──────────────────────
    const revealedPasswords = new WeakSet();
    const passwordListeners = new WeakMap();

    function setupPasswordReveal() {
        passwordObserver = new MutationObserver((mutations) => {
            for (const m of mutations) {
                for (const node of m.addedNodes) {
                    if (node.nodeType !== 1) continue;
                    if (node.tagName === 'INPUT' && node.type === 'password') {
                        processPasswordFields([node]);
                    }
                    const nested = node.querySelectorAll?.('input[type="password"]');
                    if (nested?.length) processPasswordFields(nested);
                }
            }
        });
        passwordObserver.observe(document.documentElement, {
            childList: true, subtree: true
        });
    }

    function processPasswordFields(fields) {
        for (const field of fields) {
            if (revealedPasswords.has(field)) continue;
            revealedPasswords.add(field);

            const show = () => {
                if (features.enabled && features.showPassword) {
                    field.type = 'text';
                    field.style.outline = '2px solid rgba(0, 200, 83, 0.5)';
                    field.style.outlineOffset = '-1px';
                }
            };
            const hide = () => {
                field.type = 'password';
                field.style.outline = '';
                field.style.outlineOffset = '';
            };

            field.addEventListener('mouseenter', show);
            field.addEventListener('focus', show);
            field.addEventListener('mouseleave', () => {
                if (document.activeElement !== field) hide();
            });
            field.addEventListener('blur', hide);

            passwordListeners.set(field, { show, hide });
        }
    }

    function cleanupPasswordFields() {
        document.querySelectorAll('input').forEach((field) => {
            const listeners = passwordListeners.get(field);
            if (listeners) {
                listeners.hide();
            }
        });
    }

    // ─── Overlay Removal ─────────────────────────────────────
    function scanAndRemoveOverlays() {
        // Prune entries for elements that have since been removed from the DOM
        // to prevent the Map from holding strong references indefinitely.
        for (const el of overlayRestoreState.keys()) {
            if (!el.isConnected) overlayRestoreState.delete(el);
        }

        document.querySelectorAll('div, section, aside').forEach((el) => {
            const style = getComputedStyle(el);
            const isOverlay =
                (style.position === 'fixed' || style.position === 'absolute') &&
                parseInt(style.zIndex, 10) > 999 &&
                parseFloat(style.opacity) < 0.15 &&
                el.children.length === 0 &&
                el.textContent.trim() === '';

            if (isOverlay) {
                if (!overlayRestoreState.has(el)) {
                    overlayRestoreState.set(el, {
                        display: el.style.getPropertyValue('display'),
                        displayPriority: el.style.getPropertyPriority('display'),
                        pointerEvents: el.style.getPropertyValue('pointer-events'),
                        pointerEventsPriority: el.style.getPropertyPriority('pointer-events')
                    });
                }
                el.style.pointerEvents = 'none';
                el.style.display = 'none';
            }
        });
    }

    function restoreOverlayState() {
        for (const [el, state] of overlayRestoreState.entries()) {
            if (!el) continue;
            restoreInlineProperty(el, 'display', state.display, state.displayPriority);
            restoreInlineProperty(el, 'pointer-events', state.pointerEvents, state.pointerEventsPriority);
        }
        overlayRestoreState.clear();
    }

    function setupOverlayRemoval() {
        overlayObserver = new MutationObserver(() => {
            if (features.enabled && features.overlayRemoval) {
                scanAndRemoveOverlays();
            }
        });
        overlayObserver.observe(document.documentElement, {
            childList: true, subtree: true
        });
    }

    // ─── Drag & Drop Unlock ──────────────────────────────────
    function unlockExistingDraggables() {
        // Prune entries for elements no longer in the DOM.
        for (const el of dragDropRestoreState.keys()) {
            if (!el.isConnected) dragDropRestoreState.delete(el);
        }

        document.querySelectorAll('[draggable="false"]').forEach((el) => {
            if (!dragDropRestoreState.has(el)) {
                dragDropRestoreState.set(el, el.getAttribute('draggable'));
            }
            el.removeAttribute('draggable');
        });
    }

    function restoreDraggableState() {
        for (const [el, value] of dragDropRestoreState.entries()) {
            if (el && el.isConnected && !el.hasAttribute('draggable') && value !== null) {
                el.setAttribute('draggable', value);
            }
        }
        dragDropRestoreState.clear();
    }

    function unlockDragDrop() {
        addGlobalCaptureListener('dragstart', (e) => {
            if (!features.enabled || !features.dragDropUnlock) return;
            e.stopImmediatePropagation();
        });
    }

    // ─── Print Unlock ────────────────────────────────────────
    function cleanPrintStyles() {
        try {
            for (const sheet of document.styleSheets) {
                try {
                    const rules = sheet.cssRules || sheet.rules;
                    if (!rules) continue;
                    for (let i = rules.length - 1; i >= 0; i--) {
                        const rule = rules[i];
                        if (rule instanceof CSSMediaRule &&
                            rule.conditionText?.includes('print')) {
                            // Check if rules inside hide content
                            const ruleText = rule.cssText.toLowerCase();
                            if ((ruleText.includes('display') && ruleText.includes('none')) ||
                                (ruleText.includes('visibility') && ruleText.includes('hidden'))) {
                                if (!removedPrintRules.has(sheet)) {
                                    removedPrintRules.set(sheet, []);
                                }
                                const removedRules = removedPrintRules.get(sheet);
                                if (!removedRules.some((entry) => entry.index === i && entry.cssText === rule.cssText)) {
                                    removedRules.push({ index: i, cssText: rule.cssText });
                                }
                                sheet.deleteRule(i);
                            }
                        }
                    }
                } catch (_) { /* CORS-protected stylesheet */ }
            }
        } catch (_) { }
    }

    function restorePrintStyles() {
        for (const [sheet, rules] of removedPrintRules.entries()) {
            try {
                const orderedRules = [...rules].sort((a, b) => a.index - b.index);
                for (const rule of orderedRules) {
                    const targetIndex = Math.min(rule.index, sheet.cssRules?.length ?? 0);
                    sheet.insertRule(rule.cssText, targetIndex);
                }
            } catch (_) { }
        }
        removedPrintRules.clear();
    }

    function setupPrintUnlock() {
        window.addEventListener('load', () => {
            if (features.enabled && features.printUnlock) cleanPrintStyles();
        });

        printStyleObserver = new MutationObserver(() => {
            if (features.enabled && features.printUnlock) cleanPrintStyles();
        });
        printStyleObserver.observe(document.documentElement, {
            childList: true, subtree: true
        });
    }

    // ─── Extension Hide (Stealth Mode) ──────────────────────
    // Belt-and-suspenders: content-world capture listener for postMessage relays.
    // Registered before inject.js loads (async), so it guards the brief window
    // between page script execution and inject.js initialisation.
    // Mirrors inject.js AV1: intercept → sanitize → re-dispatch, so site listeners
    // still receive a response (empty extension list) rather than stalling.
    function setupExtensionHide() {
        const EXT_ID_RE = /\b[a-p]{32}\b/;
        let _reDispatching = false;

        window.addEventListener('message', (e) => {
            if (!features.enabled || !features.extensionHide || _reDispatching) return;
            try {
                const data = e.data;
                if (!data || typeof data !== 'object') return;
                let score = 0;
                let str = '';
                try { str = JSON.stringify(data); } catch (_) { str = ''; }
                if (EXT_ID_RE.test(str)) score++;
                if (Array.isArray(data) && data.length > 0 && typeof data[0] === 'object' &&
                    (data[0]?.id || data[0]?.extensionId)) score++;
                if ('extensions' in data || 'installedExtensions' in data) score++;
                if (score < 2) return;

                e.stopImmediatePropagation();
                const sanitized = Array.isArray(data) ? [] : { ...data };
                if (!Array.isArray(sanitized)) {
                    for (const key of ['extensions', 'installedExtensions', 'chromeExtensions', 'addons', 'plugins']) {
                        if (key in sanitized) sanitized[key] = [];
                    }
                }
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
            } catch (_) {}
        }, true);
    }

    // ─── Element Zapper (Alt + Shift + Click to Delete) ──────
    function setupZapper() {
        addGlobalCaptureListener('click', (e) => {
            if (!features.enabled || !features.zapperUnlock) return;
            // Native Alt + Shift + Click combination
            if (e.altKey && e.shiftKey) {
                e.preventDefault();
                e.stopImmediatePropagation();
                let target = e.target;
                
                if (!target || target === document.body || target === document.documentElement) return;

                // Auto-expand targeting: If user clicks an inline element (span, icon, text),
                // walk up the DOM to the nearest block-level container to zap chunks of the modal faster.
                const inlineTags = ['SPAN', 'B', 'I', 'STRONG', 'EM', 'A', 'SVG', 'PATH', 'IMG', 'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'];
                let depth = 0;
                while (target.parentElement && 
                       target.parentElement !== document.body && 
                       inlineTags.includes(target.tagName) && 
                       depth < 3) {
                    target = target.parentElement;
                    depth++;
                }

                target.remove();
                
                // Crucial: Removing a modal often leaves the body locked.
                // Use the aggressive version since the user explicitly triggered this.
                forceAggressiveScrollUnlock();
            }
        });
    }

})();
