# BrowserUnlocker

**Take back control of your browsing experience.**

BrowserUnlocker is a professional productivity suite for Chrome (Manifest V3) designed to restore native browser functionalities on websites that alter or disable them. From re-enabling simple paste-and-copy actions to bypassing intrusive focus-tracking and visibility detection, BrowserUnlocker ensures you have full command over your browser.

## 🚀 Key Features

### 🛠 Core Restorations
- **Force Paste & Copy**: Re-enables clipboard actions on sites that attempt to block them.
- **Unlock Text Selection**: Strips away `user-select: none` and other CSS/JS selection blocks.
- **Context Menu Restoration**: Ensures your right-click menu is always accessible.
- **Password Visibility**: Inspect password fields on hover or focus.

### ⚡ Power Tools
- **Element Zapper**: Instantly remove intrusive overlays and modals with `Alt + Shift + Click`.
- **Scroll Enforcer**: Automatically restores page scrolling on sites that lock the scroll wheel behind invisible layers.
- **Visibility Shield**: Protects your privacy by preventing sites from detecting when you switch tabs or lose focus.
- **Keyboard Shortcut Enabler**: Restores standard shortcuts like `F12`, `Ctrl+U`, and `Ctrl+S`.
- **Exit Dialog Manager**: Silences annoying "Are you sure you want to leave?" popups.

## 🏗 Architecture

BrowserUnlocker utilizes a multi-layered interceptor strategy:

1.  **Background Service Worker**: Manages global extension state and persistent storage.
2.  **Content Script**: Orchestrates DOM manipulations and manages the high-level coordination of features.
3.  **Injected Script (Main World)**: Directly overrides native prototypes (like `addEventListener` and `Object.defineProperty`) to provide deep-level restoration that content script sandboxes cannot reach.
4.  **MutationObservers**: Continuously monitors the DOM to strip late-binding restrictions in real-time.

## 🛠 Installation

### For Users
1. Download the latest release from the [Chrome Web Store](https://chrome.google.com/webstore). (Coming Soon)

### For Developers
1. Clone this repository.
2. Open Chrome and navigate to `chrome://extensions/`.
3. Enable **Developer mode** in the top right.
4. Click **Load unpacked** and select the project directory.

## 🤝 Contributing

Contributions are welcome! Whether it's adding a new restoration feature or improving the stealth of current interceptors, feel free to open a Pull Request.

1. Fork the Project
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Commit your Changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the Branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## ⚖️ License

Distributed under the MIT License. See `LICENSE` for more information.

---
*Your browser. Your rules.*
