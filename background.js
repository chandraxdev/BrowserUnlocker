// ── BrowserUnlocker – Background Service Worker ──
/**
 * The background worker acts as the central state manager for the extension.
 * It handles persistent storage and broadcasts state changes to all active tabs.
 */

const DEFAULT_STATE = {
  // Core Unlocks
  forcePaste: true,
  forceCopy: true,
  unlockSelection: true,
  rightClick: true,
  showPassword: true,
  
  // Advanced Interceptors
  visibilityBypass: true,
  keyboardUnblock: true,
  overlayRemoval: true,
  dragDropUnlock: true,
  printUnlock: true,
  
  // Power Tools
  scrollUnlock: true,
  videoUnlock: true,
  autocompleteUnlock: true,
  beforeUnloadBypass: true,
  zapperUnlock: true,    // Alt+Shift+Click element deleter
  
  enabled: true          // Main Master Switch
};

function getStoredFeatures(callback) {
  chrome.storage.local.get('features', (result) => {
    callback(result.features || DEFAULT_STATE);
  });
}

function syncBadgeFromStorage() {
  getStoredFeatures((features) => {
    updateBadge(features.enabled);
  });
}

// Initialise storage on install
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get('features', (result) => {
    if (!result.features) {
      chrome.storage.local.set({ features: DEFAULT_STATE }, () => {
        updateBadge(DEFAULT_STATE.enabled);
      });
      return;
    }

    updateBadge(result.features.enabled);
  });
});

chrome.runtime.onStartup.addListener(() => {
  syncBadgeFromStorage();
});

// ── State Synchronization ──
/**
 * Synchronizes state Changes:
 * 1. Updates the browser action badge (ON/OFF)
 * 2. Broadcasts the new settings to all active content scripts
 */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.features) return;
  const newFeatures = changes.features.newValue;
  updateBadge(newFeatures.enabled);
  broadcastState(newFeatures);
});

// Relay state to every tab's content scripts
function broadcastState(features) {
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (tab.id && tab.url && !tab.url.startsWith('chrome://')) {
        chrome.tabs.sendMessage(tab.id, {
          type: 'STATE_UPDATE',
          features
        }).catch(() => { /* tab may not have content script yet */ });
      }
    }
  });
}

// Badge shows ON / OFF
function updateBadge(enabled) {
  chrome.action.setBadgeText({ text: enabled ? 'ON' : 'OFF' });
  chrome.action.setBadgeBackgroundColor({
    color: enabled ? '#00c853' : '#ff1744'
  });
  chrome.action.setBadgeTextColor({ color: '#ffffff' });
}

// Refresh the badge whenever the worker wakes up so browser restarts pick up
// the persisted state even before the popup is opened or a toggle changes.
syncBadgeFromStorage();

// Content script asks for current state on load
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_STATE') {
    chrome.storage.local.get('features', (result) => {
      sendResponse(result.features || DEFAULT_STATE);
    });
    return true; // async sendResponse
  }
});
