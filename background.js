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

// Initialise storage on install
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get('features', (result) => {
    if (!result.features) {
      chrome.storage.local.set({ features: DEFAULT_STATE });
    }
  });
  updateBadge(true);
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

// Content script asks for current state on load
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_STATE') {
    chrome.storage.local.get('features', (result) => {
      sendResponse(result.features || DEFAULT_STATE);
    });
    return true; // async sendResponse
  }
});
