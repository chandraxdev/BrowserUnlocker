// ── BrowserUnlocker – Popup Logic ──

(function () {
    'use strict';

    const DEFAULT_STATE = {
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
        enabled: true
    };

    const container = document.querySelector('.popup-container');
    const toggles = document.querySelectorAll('input[data-feature]');
    const resetBtn = document.getElementById('resetBtn');

    // ── Load state ────────────────────────────────
    chrome.storage.local.get('features', (result) => {
        const features = result.features || DEFAULT_STATE;
        applyToggles(features);
    });

    function applyToggles(features) {
        toggles.forEach((el) => {
            const key = el.dataset.feature;
            el.checked = !!features[key];
        });
        updateDisabledState(features.enabled);
    }

    function updateDisabledState(enabled) {
        if (enabled) {
            container.classList.remove('disabled');
        } else {
            container.classList.add('disabled');
        }
    }

    // ── Save on change ────────────────────────────
    toggles.forEach((el) => {
        el.addEventListener('change', () => {
            const key = el.dataset.feature;

            chrome.storage.local.get('features', (result) => {
                const features = result.features || { ...DEFAULT_STATE };
                features[key] = el.checked;

                // If master switch changed, update disabled state
                if (key === 'enabled') {
                    updateDisabledState(el.checked);
                }

                chrome.storage.local.set({ features });
            });
        });
    });

    // ── Reset button ──────────────────────────────
    resetBtn.addEventListener('click', () => {
        chrome.storage.local.set({ features: DEFAULT_STATE }, () => {
            applyToggles(DEFAULT_STATE);

            // Quick visual feedback
            resetBtn.textContent = '✓ Reset';
            resetBtn.style.color = 'var(--accent-green)';
            resetBtn.style.borderColor = 'var(--accent-green)';
            setTimeout(() => {
                resetBtn.textContent = '↺ Reset';
                resetBtn.style.color = '';
                resetBtn.style.borderColor = '';
            }, 1200);
        });
    });

})();
