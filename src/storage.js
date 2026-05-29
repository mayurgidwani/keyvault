// ── storage.js ────────────────────────────────────────────────────────────────
// Thin persistence layer. Uses the Tauri Store plugin when running inside the
// desktop app (data lives in an encrypted-at-rest app-data file), and falls
// back to localStorage in a plain web browser. Both only ever hold ciphertext.

const isTauri = typeof window !== "undefined" && !!window.__TAURI__;

let tauriStore = null;
async function getTauriStore() {
  if (tauriStore) return tauriStore;
  const { Store } = await import("@tauri-apps/plugin-store");
  tauriStore = await Store.load("vault.json");
  return tauriStore;
}

export async function sGet(key) {
  try {
    if (isTauri) {
      const store = await getTauriStore();
      const v = await store.get(key);
      return v ?? null;
    }
    const raw = localStorage.getItem(key);
    return raw == null ? null : JSON.parse(raw);
  } catch (e) {
    console.warn("storage get failed", key, e);
    return null;
  }
}

export async function sSet(key, val) {
  try {
    if (isTauri) {
      const store = await getTauriStore();
      await store.set(key, val);
      await store.save();
      return;
    }
    localStorage.setItem(key, JSON.stringify(val));
  } catch (e) {
    console.warn("storage set failed", key, e);
  }
}

export async function sDel(key) {
  try {
    if (isTauri) {
      const store = await getTauriStore();
      await store.delete(key);
      await store.save();
      return;
    }
    localStorage.removeItem(key);
  } catch (e) {
    console.warn("storage delete failed", key, e);
  }
}
