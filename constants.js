// ── BrowserUnlocker – Shared Defaults ──
// Loaded by background.js via importScripts() and by popup/popup.html via <script>.
// Edit feature defaults here only — do NOT duplicate this object elsewhere.

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
  zapperUnlock: true,   // Alt+Shift+Click element deleter

  enabled: true         // Master switch
};
