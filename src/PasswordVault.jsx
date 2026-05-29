import { useState, useEffect, useRef, useCallback } from "react";
import { sGet, sSet } from "./storage";
import { deriveKey, encryptJSON, decryptJSON, newSalt } from "./crypto";

// ── storage keys ───────────────────────────────────────────────────────────────
const KEY_SALT  = "pvault_salt_v3";
const KEY_VAULT = "pvault_vault_v3"; // { iv, data } — AES-GCM ciphertext of the entries array

// ── tunables ────────────────────────────────────────────────────────────────────
const AUTO_LOCK_MS       = 3 * 60 * 1000; // lock after 3 min of inactivity
const CLIPBOARD_CLEAR_MS = 20 * 1000;     // wipe copied secret after 20s
const MAX_TRIES          = 5;             // failed unlock attempts before backoff
const LOCKOUT_MS         = 30 * 1000;     // backoff window once tries exhausted

function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ── PinDots ───────────────────────────────────────────────────────────────────
function PinDots({ filled }) {
  return (
    <div style={{ display:"flex", gap:16, justifyContent:"center", marginBottom:32 }}>
      {[0,1,2,3].map(i => (
        <div key={i} style={{
          width:18, height:18, borderRadius:"50%",
          border:"2px solid #c9a84c",
          background: i < filled ? "#c9a84c" : "transparent",
          transition:"background 0.12s, box-shadow 0.12s",
          boxShadow: i < filled ? "0 0 10px #c9a84c88" : "none",
        }}/>
      ))}
    </div>
  );
}

// ── NumPad ────────────────────────────────────────────────────────────────────
function NumPad({ onDigit, onDelete, disabled }) {
  const keys = ["1","2","3","4","5","6","7","8","9","","0","⌫"];
  return (
    <div style={{ display:"grid", gridTemplateColumns:"repeat(3,72px)", gap:14, justifyContent:"center" }}>
      {keys.map((k, i) => {
        if (k === "") return <div key={i}/>;
        const isDel = k === "⌫";
        return (
          <button key={i} type="button" disabled={disabled}
            onClick={() => isDel ? onDelete() : onDigit(k)}
            onMouseDown={e => { e.currentTarget.style.transform="scale(0.93)"; }}
            onMouseUp={e => { e.currentTarget.style.transform="scale(1)"; }}
            onMouseLeave={e => { e.currentTarget.style.transform="scale(1)"; e.currentTarget.style.background="linear-gradient(145deg,#1c1c2e,#141420)"; e.currentTarget.style.borderColor="#2a2a3a"; }}
            onMouseEnter={e => { if(!disabled){ e.currentTarget.style.background="linear-gradient(145deg,#252538,#1c1c2e)"; e.currentTarget.style.borderColor="#c9a84c55"; }}}
            style={{
              width:72, height:72, borderRadius:"50%",
              border:"1.5px solid #2a2a3a",
              background:"linear-gradient(145deg,#1c1c2e,#141420)",
              color: isDel ? "#c9a84c" : "#e8d5b0",
              fontSize: isDel ? 20 : 22,
              fontFamily:"'JetBrains Mono',monospace", fontWeight:600,
              cursor: disabled ? "not-allowed" : "pointer",
              transition:"all 0.14s", outline:"none",
              boxShadow:"0 4px 12px #00000066, inset 0 1px 0 #ffffff0a",
              display:"flex", alignItems:"center", justifyContent:"center",
            }}>
            {k}
          </button>
        );
      })}
    </div>
  );
}

// ── Icons ─────────────────────────────────────────────────────────────────────
const EyeOpen = () => (
  <svg width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
  </svg>
);
const EyeClosed = () => (
  <svg width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
    <line x1="1" y1="1" x2="23" y2="23"/>
  </svg>
);
const CopyIcon = () => (
  <svg width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
    <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
  </svg>
);
const CheckIcon = () => (
  <svg width="15" height="15" fill="none" stroke="#c9a84c" strokeWidth="2.5" viewBox="0 0 24 24">
    <polyline points="20 6 9 17 4 12"/>
  </svg>
);
const TrashIcon = () => (
  <svg width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" viewBox="0 0 24 24">
    <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
    <path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
  </svg>
);
const LockIcon = () => (
  <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
    <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
  </svg>
);
const VaultIcon = ({ size=22 }) => (
  <svg width={size} height={size} fill="none" stroke="#c9a84c" strokeWidth="1.5" viewBox="0 0 24 24">
    <rect x="3" y="3" width="18" height="18" rx="2"/>
    <circle cx="12" cy="12" r="4"/>
    <circle cx="12" cy="12" r="1.5" fill="#c9a84c"/>
    <line x1="16" y1="8" x2="18" y2="6"/>
  </svg>
);

// ── GLOBAL STYLES ─────────────────────────────────────────────────────────────
const GLOBAL_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap');
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0a0a0f; }
  ::-webkit-scrollbar { width: 4px; }
  ::-webkit-scrollbar-track { background: #0a0a0f; }
  ::-webkit-scrollbar-thumb { background: #2a2a3a; border-radius:2px; }
  input::placeholder { color: #363650 !important; }
  input:focus { outline: none !important; border-color: #c9a84c55 !important; box-shadow: 0 0 0 3px #c9a84c14 !important; }
  @keyframes shake {
    0%,100%{transform:translateX(0)}
    12%{transform:translateX(-12px)}
    28%{transform:translateX(12px)}
    44%{transform:translateX(-8px)}
    60%{transform:translateX(8px)}
    76%{transform:translateX(-4px)}
    90%{transform:translateX(4px)}
  }
  @keyframes fadeUp { from{opacity:0;transform:translateY(18px)} to{opacity:1;transform:translateY(0)} }
  @keyframes slideDown { from{opacity:0;transform:translateY(-10px)} to{opacity:1;transform:translateY(0)} }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.5} }
`;

// ═══════════════════════════════════════════════════════════════════════════════
//  MAIN APP
// ═══════════════════════════════════════════════════════════════════════════════
export default function PasswordVault() {
  // Modes: loading | setup | confirm | locked | unlocked
  const [mode, setMode]           = useState("loading");
  const [pinInput, setPinInput]   = useState("");
  const [tempPin, setTempPin]     = useState("");
  const [pinError, setPinError]   = useState("");
  const [shaking, setShaking]     = useState(false);
  const [tries, setTries]         = useState(0);
  const [lockedUntil, setLockedUntil] = useState(0);

  const [passwords, setPasswords] = useState([]);
  const [showAdd, setShowAdd]     = useState(false);
  const [revealed, setRevealed]   = useState({});
  const [copied, setCopied]       = useState(null);
  const [search, setSearch]       = useState("");
  const [askDel, setAskDel]       = useState(null);
  const [newEntry, setNewEntry]   = useState({ service:"", username:"", password:"" });
  const [revealNew, setRevealNew] = useState(false);
  const [booting, setBooting]     = useState(true);
  const [hasVault, setHasVault]   = useState(false);

  // refs so async / timer callbacks always read current values (no stale closures)
  const modeRef     = useRef(mode);
  const tempPinRef  = useRef(tempPin);
  const saltRef     = useRef(null);     // base64 salt loaded/created for this vault
  const keyRef      = useRef(null);     // in-memory CryptoKey for the unlocked session
  const lockTimer   = useRef(null);     // inactivity auto-lock timer
  const clipTimer   = useRef(null);     // clipboard-clear timer
  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { tempPinRef.current = tempPin; }, [tempPin]);

  // ─── init ────────────────────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      const salt  = await sGet(KEY_SALT);
      const vault = await sGet(KEY_VAULT);
      if (salt && vault) {
        saltRef.current = salt;
        setHasVault(true);
        setMode("locked");
      } else {
        setMode("setup");
      }
      setBooting(false);
    })();
  }, []);

  // ─── shake helper ────────────────────────────────────────────────────────────
  function shake(msg) {
    setShaking(true);
    setPinError(msg);
    setTimeout(() => setShaking(false), 550);
    setTimeout(() => setPinError(""), 2200);
  }

  // ─── lock the vault and wipe the in-memory key ───────────────────────────────
  const handleLock = useCallback(() => {
    keyRef.current = null;
    setPasswords([]);
    setMode("locked");
    setPinInput("");
    setRevealed({});
    setShowAdd(false);
    setSearch("");
    setAskDel(null);
    setPinError("");
  }, []);

  // ─── persist current entries (re-encrypt with the session key) ────────────────
  async function persist(entries) {
    if (!keyRef.current) return;
    const payload = await encryptJSON(keyRef.current, entries);
    await sSet(KEY_VAULT, payload);
  }

  // ─── process a completed 4-digit pin ─────────────────────────────────────────
  async function processPin(code) {
    const m = modeRef.current;

    if (m === "setup") {
      setTempPin(code);
      setPinInput("");
      setMode("confirm");
      return;
    }

    if (m === "confirm") {
      if (code === tempPinRef.current) {
        const salt = newSalt();
        const key  = await deriveKey(code, salt);
        saltRef.current = salt;
        keyRef.current  = key;
        const payload = await encryptJSON(key, []);
        await sSet(KEY_SALT, salt);
        await sSet(KEY_VAULT, payload);
        setHasVault(true);
        setPasswords([]);
        setTempPin("");
        setPinInput("");
        setMode("unlocked");
      } else {
        shake("PINs don't match — try again");
        setTimeout(() => {
          setPinInput("");
          setTempPin("");
          setMode("setup");
        }, 600);
      }
      return;
    }

    if (m === "locked") {
      if (Date.now() < lockedUntil) {
        shake("Too many attempts — wait a moment");
        setTimeout(() => setPinInput(""), 600);
        return;
      }
      try {
        const key = await deriveKey(code, saltRef.current);
        const vault = await sGet(KEY_VAULT);
        const entries = await decryptJSON(key, vault); // throws if PIN is wrong
        keyRef.current = key;
        setPasswords(Array.isArray(entries) ? entries : []);
        setTries(0);
        setPinInput("");
        setPinError("");
        setMode("unlocked");
      } catch {
        const next = tries + 1;
        setTries(next);
        if (next >= MAX_TRIES) {
          setLockedUntil(Date.now() + LOCKOUT_MS);
          setTries(0);
          shake("Too many attempts — locked for 30s");
        } else {
          shake(`Incorrect PIN (${MAX_TRIES - next} left)`);
        }
        setTimeout(() => setPinInput(""), 600);
      }
    }
  }

  // ─── digit / backspace ───────────────────────────────────────────────────────
  const handleDigit = useCallback((d) => {
    if (shaking) return;
    setPinInput(prev => {
      if (prev.length >= 4) return prev;
      const next = prev + d;
      if (next.length === 4) setTimeout(() => processPin(next), 120);
      return next;
    });
    setPinError("");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shaking]);

  const handleBackspace = useCallback(() => {
    if (shaking) return;
    setPinInput(p => p.slice(0, -1));
    setPinError("");
  }, [shaking]);

  // ─── physical keyboard support on the PIN screen ─────────────────────────────
  useEffect(() => {
    if (mode === "unlocked" || mode === "loading") return;
    function onKey(e) {
      if (e.key >= "0" && e.key <= "9") { e.preventDefault(); handleDigit(e.key); }
      else if (e.key === "Backspace")   { e.preventDefault(); handleBackspace(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, handleDigit, handleBackspace]);

  // ─── inactivity auto-lock (only while unlocked) ──────────────────────────────
  useEffect(() => {
    if (mode !== "unlocked") return;
    const reset = () => {
      if (lockTimer.current) clearTimeout(lockTimer.current);
      lockTimer.current = setTimeout(handleLock, AUTO_LOCK_MS);
    };
    const events = ["mousemove", "keydown", "click", "touchstart", "scroll"];
    events.forEach(ev => window.addEventListener(ev, reset, { passive: true }));
    reset();
    return () => {
      events.forEach(ev => window.removeEventListener(ev, reset));
      if (lockTimer.current) clearTimeout(lockTimer.current);
    };
  }, [mode, handleLock]);

  // ─── lock when the window/tab loses focus or is hidden ───────────────────────
  useEffect(() => {
    if (mode !== "unlocked") return;
    const onHide = () => { if (document.hidden) handleLock(); };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, [mode, handleLock]);

  // ─── clear any pending clipboard timer on unmount ────────────────────────────
  useEffect(() => () => { if (clipTimer.current) clearTimeout(clipTimer.current); }, []);

  // ─── vault actions ───────────────────────────────────────────────────────────
  async function handleAdd() {
    const s = newEntry.service.trim();
    const p = newEntry.password;
    if (!s || !p) return;
    const entry = { id: uid(), service:s, username:newEntry.username.trim(), password:p, at: new Date().toISOString() };
    const updated = [entry, ...passwords];
    setPasswords(updated);
    await persist(updated);
    setNewEntry({ service:"", username:"", password:"" });
    setRevealNew(false);
    setShowAdd(false);
  }

  async function handleDelete(id) {
    const updated = passwords.filter(p => p.id !== id);
    setPasswords(updated);
    await persist(updated);
    setAskDel(null);
  }

  function handleCopy(text, key) {
    navigator.clipboard?.writeText(text).catch(()=>{});
    setCopied(key);
    setTimeout(() => setCopied(null), 1800);
    // auto-wipe the secret from the OS clipboard after a short delay
    if (clipTimer.current) clearTimeout(clipTimer.current);
    clipTimer.current = setTimeout(() => {
      navigator.clipboard?.writeText("").catch(()=>{});
    }, CLIPBOARD_CLEAR_MS);
  }

  // ─── filtered list ───────────────────────────────────────────────────────────
  const q = search.toLowerCase();
  const filtered = passwords.filter(p =>
    p.service.toLowerCase().includes(q) ||
    (p.username||"").toLowerCase().includes(q)
  );

  // ── RENDER: LOADING ──────────────────────────────────────────────────────────
  if (booting) return (
    <div style={S.root}>
      <style>{GLOBAL_CSS}</style>
      <div style={{ color:"#c9a84c", fontFamily:"'JetBrains Mono',monospace", fontSize:13, animation:"pulse 1.2s infinite" }}>
        Initialising vault…
      </div>
    </div>
  );

  // ── RENDER: PIN SCREEN (setup | confirm | locked) ────────────────────────────
  if (mode !== "unlocked") {
    const title    = mode==="setup" ? "Create PIN" : mode==="confirm" ? "Confirm PIN" : "Vault Locked";
    const subtitle = mode==="setup" ? "Choose a 4-digit PIN to protect your vault"
                   : mode==="confirm" ? "Re-enter your PIN to confirm"
                   : "Enter your PIN to continue";

    return (
      <div style={S.root}>
        <style>{GLOBAL_CSS}</style>
        <div style={{ ...S.pinCard, animation: shaking ? "shake 0.55s ease" : "fadeUp 0.4s ease" }}>
          <div style={S.emblem}><VaultIcon size={38}/></div>
          <div style={S.appName}>KeyVault</div>
          <h2 style={S.pinTitle}>{title}</h2>
          <p style={S.pinSub}>{subtitle}</p>

          <PinDots filled={pinInput.length}/>

          {pinError
            ? <p style={S.errMsg}>{pinError}</p>
            : <p style={{ ...S.errMsg, opacity:0, userSelect:"none" }}>_</p>}

          <NumPad onDigit={handleDigit} onDelete={handleBackspace} disabled={shaking}/>
        </div>
      </div>
    );
  }

  // ── RENDER: UNLOCKED VAULT ───────────────────────────────────────────────────
  return (
    <div style={{ ...S.root, alignItems:"stretch", justifyContent:"flex-start", padding:0, minHeight:"100vh" }}>
      <style>{GLOBAL_CSS}</style>

      <header style={S.header}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <VaultIcon size={20}/>
          <span style={S.headerTitle}>KeyVault</span>
        </div>
        <div style={{ display:"flex", gap:10, alignItems:"center" }}>
          <span style={S.badge}>{passwords.length} {passwords.length===1?"entry":"entries"}</span>
          <button type="button" onClick={handleLock} style={S.lockBtn}
            onMouseEnter={e=>e.currentTarget.style.borderColor="#c9a84c88"}
            onMouseLeave={e=>e.currentTarget.style.borderColor="#2a2a3a"}>
            <LockIcon/> Lock
          </button>
        </div>
      </header>

      <main style={S.main}>
        <div style={S.toolbar}>
          <div style={S.searchBox}>
            <svg width="14" height="14" fill="none" stroke="#4a4a6a" strokeWidth="2" viewBox="0 0 24 24" style={{flexShrink:0}}>
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            <input value={search} onChange={e=>setSearch(e.target.value)}
              placeholder="Search service or username…" style={S.searchInput}/>
            {search && <button type="button" onClick={()=>setSearch("")} style={S.clearBtn}>✕</button>}
          </div>
          <button type="button" onClick={()=>{ setShowAdd(true); setNewEntry({service:"",username:"",password:""}); setRevealNew(false); }}
            style={S.addBtn}
            onMouseEnter={e=>e.currentTarget.style.opacity="0.88"}
            onMouseLeave={e=>e.currentTarget.style.opacity="1"}>
            + Add
          </button>
        </div>

        {showAdd && (
          <div style={S.addCard}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
              <h3 style={S.addTitle}>New Password Entry</h3>
              <button type="button" onClick={()=>setShowAdd(false)} style={{ background:"none", border:"none", color:"#5a5a7a", cursor:"pointer", fontSize:18, lineHeight:1 }}>×</button>
            </div>
            <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
              <Field label="Service / App *" value={newEntry.service}
                onChange={v=>setNewEntry(p=>({...p,service:v}))} placeholder="e.g. Gmail, Netflix, AWS" autoFocus/>
              <Field label="Username / Email" value={newEntry.username}
                onChange={v=>setNewEntry(p=>({...p,username:v}))} placeholder="e.g. you@email.com"/>
              <PwdField label="Password *" value={newEntry.password}
                onChange={v=>setNewEntry(p=>({...p,password:v}))}
                reveal={revealNew} onToggle={()=>setRevealNew(p=>!p)} placeholder="Enter password"/>
            </div>
            <div style={{ display:"flex", gap:10, marginTop:18 }}>
              <button type="button" onClick={handleAdd}
                disabled={!newEntry.service.trim() || !newEntry.password}
                style={{ ...S.saveBtn, opacity: (!newEntry.service.trim()||!newEntry.password) ? 0.45 : 1 }}>
                Save Entry
              </button>
              <button type="button" onClick={()=>setShowAdd(false)} style={S.cancelBtn}>Cancel</button>
            </div>
          </div>
        )}

        {filtered.length === 0 ? (
          <div style={S.empty}>
            <svg width="52" height="52" fill="none" stroke="#1e1e30" strokeWidth="1" viewBox="0 0 24 24">
              <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
            </svg>
            <p style={{ color:"#2e2e46", fontFamily:"'Playfair Display',serif", fontSize:16, marginTop:14 }}>
              {passwords.length===0 ? "Your vault is empty" : "No matches found"}
            </p>
            {passwords.length===0 && (
              <p style={{ color:"#232336", fontSize:12, marginTop:6, fontFamily:"'JetBrains Mono',monospace" }}>
                Press + Add to store your first password
              </p>
            )}
          </div>
        ) : (
          <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
            {filtered.map(entry => (
              <EntryCard
                key={entry.id}
                entry={entry}
                revealed={!!revealed[entry.id]}
                onReveal={()=>setRevealed(p=>({...p,[entry.id]:!p[entry.id]}))}
                copied={copied}
                onCopy={handleCopy}
                askDel={askDel===entry.id}
                onAskDel={()=>setAskDel(entry.id)}
                onCancelDel={()=>setAskDel(null)}
                onDelete={()=>handleDelete(entry.id)}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

// ── Field ──────────────────────────────────────────────────────────────────────
function Field({ label, value, onChange, placeholder, autoFocus }) {
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:5 }}>
      <label style={S.label}>{label}</label>
      <input value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder}
        autoFocus={!!autoFocus} style={S.input}/>
    </div>
  );
}

// ── PwdField ──────────────────────────────────────────────────────────────────
function PwdField({ label, value, onChange, reveal, onToggle, placeholder }) {
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:5 }}>
      <label style={S.label}>{label}</label>
      <div style={{ position:"relative" }}>
        <input type={reveal?"text":"password"} value={value} onChange={e=>onChange(e.target.value)}
          placeholder={placeholder}
          style={{ ...S.input, paddingRight:42, fontFamily: reveal?"'JetBrains Mono',monospace":"inherit" }}/>
        <button type="button" onClick={onToggle} style={S.eyeBtn}>{reveal ? <EyeOpen/> : <EyeClosed/>}</button>
      </div>
    </div>
  );
}

// ── EntryCard ─────────────────────────────────────────────────────────────────
function EntryCard({ entry, revealed, onReveal, copied, onCopy, askDel, onAskDel, onCancelDel, onDelete }) {
  const initials = entry.service.slice(0,2).toUpperCase();
  const pwdCopyKey = `pwd-${entry.id}`;
  const unCopyKey  = `un-${entry.id}`;

  return (
    <div style={S.card}
      onMouseEnter={e=>e.currentTarget.style.borderColor="#2a2a3e"}
      onMouseLeave={e=>e.currentTarget.style.borderColor="#191926"}>
      <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:10 }}>
        <div style={S.avatar}>{initials}</div>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={S.serviceName}>{entry.service}</div>
          {entry.username && (
            <div style={{ display:"flex", alignItems:"center", gap:6 }}>
              <span style={S.usernameText}>{entry.username}</span>
              <button type="button" onClick={()=>onCopy(entry.username,unCopyKey)} style={S.miniCopyBtn} title="Copy username">
                {copied===unCopyKey ? <CheckIcon/> : <CopyIcon/>}
              </button>
            </div>
          )}
        </div>
        {askDel ? (
          <div style={{ display:"flex", gap:6, alignItems:"center" }}>
            <span style={{ color:"#ff5555", fontSize:11, fontFamily:"'JetBrains Mono',monospace", whiteSpace:"nowrap" }}>Delete?</span>
            <button type="button" onClick={onDelete} style={S.yesBtn}>Yes</button>
            <button type="button" onClick={onCancelDel} style={S.noBtn}>No</button>
          </div>
        ) : (
          <button type="button" onClick={onAskDel} style={S.trashBtn}
            onMouseEnter={e=>e.currentTarget.style.color="#ff5555"}
            onMouseLeave={e=>e.currentTarget.style.color="#2e2e4a"}>
            <TrashIcon/>
          </button>
        )}
      </div>

      <div style={S.pwdRow}>
        <span style={{
          fontFamily:"'JetBrains Mono',monospace", fontSize:13,
          color: revealed ? "#ddc87a" : "#5a5a7a",
          letterSpacing: revealed ? "0.04em" : "0.22em",
          flex:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap",
        }}>
          {revealed ? entry.password : "••••••••••••"}
        </span>
        <div style={{ display:"flex", gap:4, flexShrink:0 }}>
          <button type="button" onClick={onReveal} style={S.iconBtn} title={revealed?"Hide":"Show"}>
            {revealed ? <EyeOpen/> : <EyeClosed/>}
          </button>
          <button type="button" onClick={()=>onCopy(entry.password,pwdCopyKey)} style={{...S.iconBtn, color: copied===pwdCopyKey ? "#c9a84c" : undefined}} title="Copy password">
            {copied===pwdCopyKey ? <CheckIcon/> : <CopyIcon/>}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── STYLES ────────────────────────────────────────────────────────────────────
const S = {
  root: {
    minHeight:"100vh", background:"#0a0a0f",
    display:"flex", flexDirection:"column",
    alignItems:"center", justifyContent:"center",
    fontFamily:"'JetBrains Mono',monospace", color:"#e8d5b0",
  },
  pinCard: {
    background:"linear-gradient(160deg,#111120,#0d0d1a)",
    border:"1px solid #1c1c2c",
    borderRadius:24, padding:"38px 48px 44px",
    width:336, textAlign:"center",
    boxShadow:"0 32px 80px #00000099, inset 0 1px 0 #ffffff07",
  },
  emblem: {
    width:68, height:68, borderRadius:"50%",
    background:"linear-gradient(135deg,#18182e,#0f0f1e)",
    border:"1.5px solid #c9a84c33",
    display:"flex", alignItems:"center", justifyContent:"center",
    margin:"0 auto 12px",
    boxShadow:"0 0 30px #c9a84c14",
  },
  appName: {
    fontFamily:"'Playfair Display',serif", fontSize:13, fontWeight:600,
    color:"#c9a84c", letterSpacing:"0.22em", textTransform:"uppercase",
    marginBottom:18,
  },
  pinTitle: {
    fontFamily:"'Playfair Display',serif", fontSize:22, fontWeight:700,
    color:"#e8d5b0", marginBottom:6, letterSpacing:"-0.01em",
  },
  pinSub: { fontSize:11, color:"#4a4a6a", lineHeight:1.5, marginBottom:28 },
  errMsg: {
    color:"#ff6b6b", fontSize:11, height:16,
    lineHeight:"16px", marginBottom:18, animation:"slideDown 0.2s ease",
  },
  header: {
    width:"100%", padding:"14px 24px",
    display:"flex", alignItems:"center", justifyContent:"space-between",
    borderBottom:"1px solid #181824", background:"#0a0a0f", flexShrink:0,
  },
  headerTitle: {
    fontFamily:"'Playfair Display',serif", fontSize:19, fontWeight:700,
    color:"#e8d5b0", letterSpacing:"0.02em",
  },
  badge: {
    fontSize:10, color:"#4a4a6a", background:"#141420", borderRadius:20,
    padding:"3px 10px", letterSpacing:"0.06em",
  },
  lockBtn: {
    display:"flex", alignItems:"center", gap:6,
    background:"transparent", border:"1px solid #2a2a3a",
    color:"#c9a84c", borderRadius:20, padding:"6px 14px",
    fontSize:11, cursor:"pointer", fontFamily:"'JetBrains Mono',monospace",
    transition:"border-color 0.2s",
  },
  main: {
    flex:1, width:"100%", maxWidth:700, alignSelf:"center",
    padding:"20px 24px 40px", animation:"fadeUp 0.35s ease",
  },
  toolbar: { display:"flex", gap:10, marginBottom:16, alignItems:"center" },
  searchBox: {
    flex:1, display:"flex", alignItems:"center", gap:10,
    background:"#0e0e1b", border:"1px solid #1a1a28",
    borderRadius:10, padding:"0 14px", height:42,
  },
  searchInput: {
    flex:1, background:"transparent", border:"none",
    color:"#d8c8a0", fontSize:13, fontFamily:"'JetBrains Mono',monospace", outline:"none",
  },
  clearBtn: {
    background:"none", border:"none", color:"#4a4a6a",
    cursor:"pointer", fontSize:12, padding:2, lineHeight:1, flexShrink:0,
  },
  addBtn: {
    background:"linear-gradient(135deg,#c9a84c,#a8863c)",
    color:"#0a0a0f", border:"none", borderRadius:10, padding:"0 20px", height:42,
    fontSize:13, fontWeight:700, fontFamily:"'JetBrains Mono',monospace",
    cursor:"pointer", boxShadow:"0 4px 16px #c9a84c2e",
    whiteSpace:"nowrap", transition:"opacity 0.15s",
  },
  addCard: {
    background:"#0e0e1c", border:"1px solid #c9a84c28",
    borderRadius:14, padding:"20px 22px", marginBottom:14,
    animation:"slideDown 0.22s ease", boxShadow:"0 8px 40px #00000055, 0 0 50px #c9a84c06",
  },
  addTitle: { fontFamily:"'Playfair Display',serif", fontSize:15, fontWeight:600, color:"#d8c8a0" },
  label: { fontSize:9, color:"#4a4a66", letterSpacing:"0.14em", textTransform:"uppercase" },
  input: {
    background:"#0a0a14", border:"1px solid #1a1a28",
    borderRadius:8, padding:"9px 12px", color:"#e8d5b0", fontSize:13,
    fontFamily:"'JetBrains Mono',monospace",
    transition:"border-color 0.2s, box-shadow 0.2s", width:"100%",
  },
  eyeBtn: {
    position:"absolute", right:10, top:"50%", transform:"translateY(-50%)",
    background:"none", border:"none", color:"#4a4a6a", cursor:"pointer",
    padding:4, display:"flex", alignItems:"center",
  },
  saveBtn: {
    background:"linear-gradient(135deg,#c9a84c,#a8863c)",
    color:"#0a0a0f", border:"none", borderRadius:8,
    padding:"9px 22px", fontSize:12, fontWeight:700,
    fontFamily:"'JetBrains Mono',monospace", cursor:"pointer", transition:"opacity 0.15s",
  },
  cancelBtn: {
    background:"transparent", border:"1px solid #2a2a3a",
    color:"#5a5a7a", borderRadius:8, padding:"9px 16px", fontSize:12,
    fontFamily:"'JetBrains Mono',monospace", cursor:"pointer",
  },
  empty: {
    display:"flex", flexDirection:"column", alignItems:"center",
    justifyContent:"center", padding:"70px 20px", textAlign:"center",
  },
  card: {
    background:"linear-gradient(145deg,#0e0e1c,#0c0c18)",
    border:"1px solid #191926", borderRadius:12, padding:"14px 16px",
    transition:"border-color 0.2s",
  },
  avatar: {
    width:38, height:38, borderRadius:10, flexShrink:0,
    background:"linear-gradient(135deg,#1a1a2e,#131322)",
    border:"1px solid #252535",
    display:"flex", alignItems:"center", justifyContent:"center",
    fontFamily:"'Playfair Display',serif", fontSize:13, fontWeight:700, color:"#c9a84c",
  },
  serviceName: {
    fontFamily:"'Playfair Display',serif", fontSize:14, fontWeight:600,
    color:"#e0d0a8", marginBottom:2,
  },
  usernameText: {
    fontSize:11, color:"#4a4a6a", overflow:"hidden",
    textOverflow:"ellipsis", whiteSpace:"nowrap",
  },
  miniCopyBtn: {
    background:"none", border:"none", color:"#4a4a6a",
    cursor:"pointer", padding:2, display:"flex", alignItems:"center",
    flexShrink:0, transition:"color 0.15s",
  },
  trashBtn: {
    background:"none", border:"none", color:"#2e2e4a", cursor:"pointer",
    padding:5, borderRadius:6, display:"flex", transition:"color 0.2s", flexShrink:0,
  },
  pwdRow: {
    display:"flex", alignItems:"center", gap:8,
    background:"#080812", borderRadius:8, padding:"8px 12px", minHeight:38,
  },
  iconBtn: {
    background:"none", border:"none", color:"#4a4a6a", cursor:"pointer",
    padding:5, borderRadius:6, display:"flex", alignItems:"center", transition:"color 0.15s",
  },
  yesBtn: {
    background:"#cc3333", border:"none", color:"#fff",
    borderRadius:5, padding:"3px 10px", fontSize:11,
    fontFamily:"'JetBrains Mono',monospace", cursor:"pointer",
  },
  noBtn: {
    background:"#1a1a2a", border:"1px solid #2a2a3a",
    color:"#7a7a9a", borderRadius:5, padding:"3px 10px", fontSize:11,
    fontFamily:"'JetBrains Mono',monospace", cursor:"pointer",
  },
};
