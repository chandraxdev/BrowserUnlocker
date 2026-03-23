// ── BrowserUnlocker – Popup Logic ──
// DEFAULT_STATE is provided by constants.js, loaded before this script.

(function () {
    'use strict';

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
    // Read the current state directly from the DOM — the checkboxes already
    // reflect persisted storage (populated in applyToggles). This avoids the
    // async get→set race that could lose a rapid consecutive toggle change.
    toggles.forEach((el) => {
        el.addEventListener('change', () => {
            const key = el.dataset.feature;
            if (key === 'enabled') updateDisabledState(el.checked);

            const features = {};
            toggles.forEach((t) => { features[t.dataset.feature] = t.checked; });
            chrome.storage.local.set({ features });
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
