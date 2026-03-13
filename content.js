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

    // ─── Initialization & Messaging ──────────────────────────
    // Request initial state from the background service worker
    chrome.runtime.sendMessage({ type: 'GET_STATE' }, (state) => {
        if (chrome.runtime.lastError) return;
        features = state || {};
        if (features.enabled) applyAll();
    });

    // Live updates from background
    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.type === 'STATE_UPDATE') {
            const prev = features;
            features = msg.features;
            if (features.enabled) {
                applyAll();
            } else {
                removeAll();
            }
        }
    });

    // ─── Apply all features ──────────────────────────────────
    function applyAll() {
        try {
            injectPageScript();
            if (features.unlockSelection) injectSelectionCSS();
            if (features.forcePaste) setupForcePaste();
            if (features.forceCopy) setupForceCopy();
            if (features.rightClick) setupRightClick();
            if (features.showPassword) setupPasswordReveal();
            if (features.overlayRemoval) setupOverlayRemoval();
            if (features.dragDropUnlock) unlockDragDrop();
            if (features.printUnlock) setupPrintUnlock();
            if (features.scrollUnlock) injectScrollCSS();
            if (features.zapperUnlock) setupZapper();
            setupEnforcer();
        } catch (_) { /* Isolate errors so individual feature failures don't break the page */ }
    }

    function removeAll() {
        if (injectedStyleEl) { injectedStyleEl.remove(); injectedStyleEl = null; }
        if (scrollStyleEl) { scrollStyleEl.remove(); scrollStyleEl = null; }
        if (passwordObserver) { passwordObserver.disconnect(); passwordObserver = null; }
        if (overlayObserver) { overlayObserver.disconnect(); overlayObserver = null; }
        if (printStyleObserver) { printStyleObserver.disconnect(); printStyleObserver = null; }
        if (enforcerObserver) { enforcerObserver.disconnect(); enforcerObserver = null; }
        cleanupPasswordFields();
        // Note: injected script can't easily be "un-injected" since prototypes
        // are already overridden, but toggling off the master switch prevents
        // re-injection on next navigation.
    }

    // ─── Inject page-context script ──────────────────────────
    function injectPageScript() {
        if (injectedScriptEl) return;
        try {
            const s = document.createElement('script');
            s.src = chrome.runtime.getURL('inject.js');
            s.dataset.flags = JSON.stringify(features);
            s.onload = () => s.remove();
            (document.documentElement || document.head || document.body).prepend(s);
            injectedScriptEl = s;
        } catch (_) { }
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

    // ─── Scroll Unlock CSS ───────────────────────────────────
    /**
     * SAFETY: Only override `overflow`. Do NOT force `position` or `height`
     * changes persistently — these destroy SPA layouts (banking sites, etc.).
     * Aggressive position/height fixes are applied reactively by the Zapper only.
     */
    function injectScrollCSS() {
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
                el.style.setProperty('overflow', 'auto', 'important');
                // Remove common scroll-lock classes used by frameworks (Bootstrap, Tailwind, etc.)
                el.classList.remove('no-scroll', 'noscroll', 'scroll-lock', 'locked', 'overflow-hidden');
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
    /**
     * Many modern sites use "late-binding" where they apply restrictions
     * (like onpaste="return false") dynamically after the page has loaded.
     * The Enforcer uses a MutationObserver to instantly strip these attributes
     * as soon as they are added to the DOM.
     */
    function setupEnforcer() {
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
                if (node.getAttribute('draggable') === 'false') node.removeAttribute('draggable');
            }
            if (features.videoUnlock && node.tagName === 'VIDEO') {
                node.controls = true;
                node.style.pointerEvents = 'auto'; // Re-enable clicking if overlaid
            }
            if (features.autocompleteUnlock) {
                if (node.tagName === 'FORM' || node.tagName === 'INPUT') {
                    if (node.getAttribute('autocomplete') === 'off') {
                        node.setAttribute('autocomplete', 'on');
                    }
                }
            }
        }

        // Process existing body
        document.querySelectorAll('*').forEach(enforceNode);

        enforcerObserver = new MutationObserver((mutations) => {
            if (!features.enabled) return;
            let checkCss = false;

            for (const m of mutations) {
                // Enforce on new nodes
                for (const node of m.addedNodes) enforceNode(node);

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
            attributeFilter: ['onpaste', 'oncopy', 'oncut', 'oncontextmenu', 'onselectstart', 'ondragstart', 'draggable']
        });
    }

    // ─── Clipboard & Event Restoration ───────────────────────
    /**
     * BrowserUnlocker uses the Capture Phase (true) for event listeners
     * to intercept and stop 'paste' / 'copy' events before the website's
     * own listeners can reach them.
     */
    function setupForcePaste() {
        document.addEventListener('paste', (e) => {
            if (!features.enabled || !features.forcePaste) return;
            e.stopImmediatePropagation();

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
        }, true); // capture phase
    }

    // ─── Force Copy & Cut ────────────────────────────────────
    function setupForceCopy() {
        document.addEventListener('copy', (e) => {
            if (!features.enabled || !features.forceCopy) return;
            e.stopImmediatePropagation();
        }, true);

        document.addEventListener('cut', (e) => {
            if (!features.enabled || !features.forceCopy) return;
            e.stopImmediatePropagation();
        }, true);

        // Also protect Ctrl+C / Ctrl+X / Ctrl+A from being swallowed
        document.addEventListener('keydown', (e) => {
            if (!features.enabled || !features.forceCopy) return;
            const key = e.key.toLowerCase();
            if ((e.ctrlKey || e.metaKey) && (key === 'c' || key === 'x' || key === 'a')) {
                e.stopImmediatePropagation();
            }
        }, true);
    }

    // ─── Right-Click ─────────────────────────────────────────
    function setupRightClick() {
        document.addEventListener('contextmenu', (e) => {
            if (!features.enabled || !features.rightClick) return;
            e.stopImmediatePropagation();
        }, true);
    }

    // ─── Show Password on Hover / Focus ──────────────────────
    const revealedPasswords = new WeakSet();
    const passwordListeners = new WeakMap();

    function setupPasswordReveal() {
        processPasswordFields(document.querySelectorAll('input[type="password"]'));

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
    function setupOverlayRemoval() {
        function scanAndRemoveOverlays() {
            document.querySelectorAll('div, section, aside').forEach((el) => {
                const style = getComputedStyle(el);
                const isOverlay =
                    (style.position === 'fixed' || style.position === 'absolute') &&
                    parseInt(style.zIndex, 10) > 999 &&
                    parseFloat(style.opacity) < 0.15 &&
                    el.children.length === 0 &&
                    el.textContent.trim() === '';

                if (isOverlay) {
                    el.style.pointerEvents = 'none';
                    el.style.display = 'none';
                }
            });
        }

        scanAndRemoveOverlays();

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
    function unlockDragDrop() {
        document.addEventListener('dragstart', (e) => {
            if (!features.enabled || !features.dragDropUnlock) return;
            e.stopImmediatePropagation();
        }, true);

        // Remove draggable="false" from all elements
        document.querySelectorAll('[draggable="false"]').forEach((el) => {
            el.removeAttribute('draggable');
        });
    }

    // ─── Print Unlock ────────────────────────────────────────
    function setupPrintUnlock() {
        // Remove @media print { display: none } rules
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
                                if (ruleText.includes('display') && ruleText.includes('none') ||
                                    ruleText.includes('visibility') && ruleText.includes('hidden')) {
                                    sheet.deleteRule(i);
                                }
                            }
                        }
                    } catch (_) { /* CORS-protected stylesheet */ }
                }
            } catch (_) { }
        }

        if (document.readyState === 'complete') {
            cleanPrintStyles();
        } else {
            window.addEventListener('load', cleanPrintStyles);
        }

        printStyleObserver = new MutationObserver(() => {
            if (features.enabled && features.printUnlock) cleanPrintStyles();
        });
        printStyleObserver.observe(document.documentElement, {
            childList: true, subtree: true
        });
    }

    // ─── Element Zapper (Alt + Shift + Click to Delete) ──────
    function setupZapper() {
        document.addEventListener('click', (e) => {
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
        }, true);
    }

})();
