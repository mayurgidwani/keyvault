# KeyVault

A private, encrypted personal password vault. Same React codebase runs as a **website** and as a **native desktop app** (Windows / macOS / Linux) via [Tauri](https://tauri.app).

## Security model

- Your 4-digit PIN never gets stored. It's run through **PBKDF2** (250,000 iterations, SHA-256, random 16-byte salt) to derive an **AES-256-GCM** key.
- All entries are encrypted with that key before being written to disk. Storage only ever holds ciphertext — open DevTools and you'll see nothing readable.
- A wrong PIN simply fails to decrypt, so there's no plaintext PIN to compare against. After 5 failed attempts there's a 30-second lockout.
- The vault auto-locks after 3 minutes of inactivity, and immediately when the window/tab is hidden. The decryption key lives only in memory and is wiped on lock.
- Copied passwords are cleared from the OS clipboard after 20 seconds.

> Note: a 4-digit PIN is convenient but low-entropy. For stronger protection, raise the PIN length (the crypto layer works with any string) — see "Hardening" below.

## Project layout

```
keyvault/
├── index.html              # Vite entry
├── package.json
├── vite.config.js
├── src/
│   ├── main.jsx            # React bootstrap
│   ├── PasswordVault.jsx   # the app
│   ├── crypto.js           # PBKDF2 + AES-GCM (Web Crypto)
│   └── storage.js          # localStorage (web) / Tauri Store (desktop)
└── src-tauri/              # native shell
    ├── tauri.conf.json
    ├── Cargo.toml
    ├── build.rs
    ├── capabilities/default.json
    └── src/{main.rs,lib.rs}
```

`storage.js` auto-detects the environment: in the browser it uses `localStorage`, in the desktop app it uses the Tauri Store plugin (a file in the OS app-data directory).

## Prerequisites

- **Node.js** 18+ and npm
- For the desktop build only: **Rust** (https://rustup.rs) and the Tauri OS dependencies — see https://tauri.app/start/prerequisites/

## Run as a website

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # static bundle in dist/
npm run preview    # preview the production build
```

Deploy the `dist/` folder to any static host (Vercel, Netlify, Cloudflare Pages, GitHub Pages). Use **HTTPS** — the clipboard and Web Crypto APIs require a secure context (localhost is exempt for dev).

## Run as a desktop app

```bash
npm install
npm run tauri:dev      # launches the native dev window with hot reload
npm run tauri:build    # produces installers in src-tauri/target/release/bundle/
```

`tauri:build` outputs a `.msi`/`.exe` (Windows), `.dmg`/`.app` (macOS), or `.AppImage`/`.deb` (Linux).

### App icons

Drop a 1024×1024 PNG at `src-tauri/icons/icon.png`, then run `npm run tauri icon` to generate every required size. (The build references the standard icon set in `tauri.conf.json`.)

## Installable web app (PWA) — optional

For a lighter "app-like" install without Rust, add `vite-plugin-pwa`:

```bash
npm install -D vite-plugin-pwa
```

…register it in `vite.config.js`, and users can "Install" KeyVault from their browser.

## Hardening ideas

- Increase PIN length / allow a full passphrase (no code change needed in `crypto.js`).
- Add encrypted export/import for backups so a cleared browser store doesn't lose data.
- On desktop, store the salt in the OS keychain via `tauri-plugin-keyring` instead of the data file.
- Bump PBKDF2 iterations as hardware improves, or switch to Argon2.
```
