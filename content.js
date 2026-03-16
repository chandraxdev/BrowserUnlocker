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
    let scrollRestoreState = null;

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
        if (features.dragDropUnlock) unlockExistingDraggables();
        if (features.printUnlock) cleanPrintStyles();
    }

    function removeAll() {
        removeSelectionCSS();
        removeScrollCSS();
        cleanupPasswordFields();
    }

    function removeSelectionCSS() {
        if (injectedStyleEl) { injectedStyleEl.remove(); injectedStyleEl = null; }
    }
    function removeScrollCSS() {
        if (scrollStyleEl) { scrollStyleEl.remove(); scrollStyleEl = null; }
        if (!scrollRestoreState) return;

        for (const state of scrollRestoreState) {
            const { el, removedClasses } = state;
            if (!el) continue;
            restoreInlineProperty(el, 'overflow', state.overflow, state.overflowPriority);
            restoreInlineProperty(el, 'overflow-y', state.overflowY, state.overflowYPriority);
            restoreInlineProperty(el, 'overflow-x', state.overflowX, state.overflowXPriority);
            removedClasses.forEach((className) => el.classList.add(className));
        }

        scrollRestoreState = null;
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
    function captureScrollRestoreState() {
        if (scrollRestoreState) return;

        scrollRestoreState = [document.documentElement, document.body]
            .filter(Boolean)
            .map((el) => ({
                el,
                overflow: el.style.getPropertyValue('overflow'),
                overflowPriority: el.style.getPropertyPriority('overflow'),
                overflowY: el.style.getPropertyValue('overflow-y'),
                overflowYPriority: el.style.getPropertyPriority('overflow-y'),
                overflowX: el.style.getPropertyValue('overflow-x'),
                overflowXPriority: el.style.getPropertyPriority('overflow-x'),
                removedClasses: SCROLL_LOCK_CLASSES.filter((className) => el.classList.contains(className))
            }));
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
            if (node.getAttribute('draggable') === 'false') node.removeAttribute('draggable');
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
    /**
     * BrowserUnlocker uses the Capture Phase (true) for event listeners
     * to intercept and stop 'paste' / 'copy' events before the website's
     * own listeners can reach them.
     */
    function setupForcePaste() {
        document.addEventListener('paste', (e) => {
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
            if (!features.enabled || !features.forceCopy || !e.key) return;
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
        document.querySelectorAll('[draggable="false"]').forEach((el) => {
            el.removeAttribute('draggable');
        });
    }

    function unlockDragDrop() {
        document.addEventListener('dragstart', (e) => {
            if (!features.enabled || !features.dragDropUnlock) return;
            e.stopImmediatePropagation();
        }, true);
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
