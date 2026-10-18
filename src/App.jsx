import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createClient } from '@supabase/supabase-js';
import { AnimatePresence, motion, useMotionValue, useSpring } from 'framer-motion';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';

/* =====================================================================
   CONFIGURACIÓN
   ===================================================================== */
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || 'https://wzeycwyumbsbeytypzal.supabase.co';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind6ZXljd3l1bWJzYmV5dHlwemFsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIzNDUyMjIsImV4cCI6MjEwNzkyMTIyMn0.0XtsUOx90wQrCI1t5el848fvRzx66LeP3yMtsEkiPPM';
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

// Todas las operaciones pasan por funciones RPC que validan la sesión (usuario/contraseña propios)
async function rpc(fn, args) {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) {
    if (/SESION_EXPIRADA/.test(error.message)) window.dispatchEvent(new Event('vp-logout'));
    throw new Error(error.message);
  }
  return data;
}
const mergeById = (prev, next, key) => {
  const map = new Map(prev.map((x) => [x.id, x]));
  next.forEach((x) => map.set(x.id, x));
  return [...map.values()].sort((a, b) => String(b[key]).localeCompare(String(a[key])));
};

const AUTHORIZED = {
  in: 'notificaciones@nequi.com.co',
  out: 'somos@nequi.com.co',
};
const TZ = 'America/Bogota';
const PALETTE = ['#ff2d95', '#a855f7', '#22d3ee', '#facc15', '#34d399', '#fb7185', '#60a5fa', '#f97316'];

/* =====================================================================
   UTILIDADES
   ===================================================================== */
const fmtCOP = (v) => '$' + Math.round(Number(v) || 0).toLocaleString('es-CO');
const norm = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
  .replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const titleCase = (s) => (s || '').toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());

function bogota(iso) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(iso)).reduce((a, p) => ({ ...a, [p.type]: p.value }), {});
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}`, hour: Number(parts.hour) };
}
const fmtDateTime = (iso) => new Date(iso).toLocaleString('es-CO', { timeZone: TZ, dateStyle: 'medium', timeStyle: 'short' });
const toBogotaISO = (date, time) => (date && time ? new Date(`${date}T${time}:00-05:00`).toISOString() : null);

function lev(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
    dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return dp[m][n];
}
// Fracción de palabras del nombre esperado que aparecen (tolerando 1 error de OCR) en los textos
function nameScore(expected, ...texts) {
  const tokens = norm(expected).split(' ').filter((t) => t.length > 2);
  if (!tokens.length) return 0;
  const hay = norm(texts.join(' ')).split(' ');
  const hits = tokens.filter((t) => hay.some((h) => h === t || (t.length > 4 && Math.abs(h.length - t.length) <= 1 && lev(h, t) <= 1)));
  return hits.length / tokens.length;
}

async function sha256(file) {
  const buf = await file.arrayBuffer();
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const MONTHS = { ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6, jul: 7, ago: 8, sep: 9, set: 9, oct: 10, nov: 11, dic: 12 };
const parseMoney = (s) => {
  const clean = (s || '').replace(/[^0-9.,]/g, '');
  const dec = clean.match(/,(\d{2})$/);
  const int = clean.replace(/,\d{2}$/, '').replace(/[.,]/g, '');
  return int ? Number(int + (dec ? '.' + dec[1] : '')) : null;
};

/* Lee el texto OCR del pantallazo del comprobante */
function parseReceipt(raw) {
  const text = (raw || '').replace(/\r/g, '');
  const flat = text.replace(/\s+/g, ' ');
  const out = { amount: '', name: '', date: '', time: '', reference: '' };

  const labeled = flat.match(/(?:¿?cu[aá]nto\??|valor|monto|total)\s*:?\s*(?:\$|S)\s?([0-9]{1,3}(?:[.\s][0-9]{3})+(?:,[0-9]{2})?|[0-9]+(?:,[0-9]{2})?)/i);
  const all = [...flat.matchAll(/\$\s?([0-9]{1,3}(?:[.\s][0-9]{3})+(?:,[0-9]{2})?|[0-9]{4,}(?:,[0-9]{2})?)/g)].map((m) => parseMoney(m[1]));
  const amount = labeled ? parseMoney(labeled[1]) : (all.length ? Math.max(...all) : null);
  if (amount) out.amount = String(amount);

  const d = flat.match(/(\d{1,2})\s+(?:de\s+)?([a-záéíóú]{3,})\.?\s+(?:de\s+)?(\d{4})/i);
  if (d && MONTHS[norm(d[2]).slice(0, 3).toLowerCase()]) {
    out.date = `${d[3]}-${String(MONTHS[norm(d[2]).slice(0, 3).toLowerCase()]).padStart(2, '0')}-${d[1].padStart(2, '0')}`;
  } else {
    const d2 = flat.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
    if (d2) out.date = `${d2[3]}-${d2[2].padStart(2, '0')}-${d2[1].padStart(2, '0')}`;
  }

  const t = flat.match(/(\d{1,2})[:.](\d{2})(?::\d{2})?\s*([ap])\.?\s*m/i) || flat.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (t) {
    let h = Number(t[1]);
    if (t[3]?.toLowerCase() === 'p' && h < 12) h += 12;
    if (t[3]?.toLowerCase() === 'a' && h === 12) h = 0;
    out.time = `${String(h).padStart(2, '0')}:${t[2]}`;
  }

  const r = flat.match(/(?:referencia|n[uú]mero de (?:movimiento|aprobaci[oó]n|transacci[oó]n|comprobante)|movimiento|comprobante|cus|id de transacci[oó]n)\s*(?:no\.?)?\s*[:#]?\s*([A-Z0-9-]{5,})/i)
    || flat.match(/\b(M\d{6,})\b/);
  if (r) out.reference = r[1].toUpperCase();

  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(?:de|para|nombre|remitente|enviado por|origen|qui[eé]n env[ií]a)\s*:?\s*(.*)$/i);
    if (m) {
      const cand = (m[1] && /[a-z]{3,}/i.test(m[1]) ? m[1] : lines[i + 1]) || '';
      if (/[a-z]{3,}/i.test(cand) && !/\d{3,}/.test(cand)) { out.name = cand; break; }
    }
  }
  return out;
}

/* ---------------- Voz ---------------- */
function speak(text) {
  try {
    const synth = window.speechSynthesis;
    if (!synth) return;
    const u = new SpeechSynthesisUtterance(text);
    const voices = synth.getVoices();
    u.voice = voices.find((v) => /es[-_]CO/i.test(v.lang)) || voices.find((v) => /^es/i.test(v.lang)) || null;
    u.lang = u.voice?.lang || 'es-CO';
    u.rate = 1;
    synth.speak(u);
  } catch { /* sin voz */ }
}
const speakAmount = (a) => `${Math.round(Number(a)).toLocaleString('es-CO')} pesos`;
const voiceText = (n) => (n.direction === 'in'
  ? `Recibiste ${speakAmount(n.amount)} de ${titleCase(n.counterparty || 'remitente desconocido')}`
  : `Hiciste un pago por valor de ${speakAmount(n.amount)} a ${titleCase(n.counterparty || 'destinatario desconocido')}`);

async function systemNotify(title, body) {
  try {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) reg.showNotification(title, { body, icon: './icon-192.png', badge: './icon-192.png', vibrate: [200, 100, 200] });
    else new Notification(title, { body, icon: './icon-192.png' });
  } catch { /* ignorar */ }
}

/* =====================================================================
   ESTILOS
   ===================================================================== */
const CSS = `
:root{--bg:#14061a;--card:rgba(255,255,255,.06);--line:rgba(255,255,255,.1);--txt:#f5ecf7;--mut:#b9a6c2;
--pink:#ff2d95;--violet:#a855f7;--ok:#34d399;--bad:#fb7185;--warn:#facc15;color-scheme:dark}
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
body{background:var(--bg);color:var(--txt);font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;min-height:100vh;overflow-x:hidden}
.blob{position:fixed;border-radius:50%;filter:blur(80px);opacity:.45;z-index:0;pointer-events:none}
.wrap{position:relative;z-index:1;max-width:1100px;margin:0 auto;padding:16px 16px 110px}
.top{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:18px}
.brand{display:flex;align-items:center;gap:10px;font-weight:800;font-size:20px;letter-spacing:-.02em}
.logo{width:38px;height:38px;border-radius:12px;background:linear-gradient(135deg,var(--pink),var(--violet));display:grid;place-items:center;font-size:20px;box-shadow:0 8px 24px rgba(255,45,149,.35)}
.card{background:var(--card);border:1px solid var(--line);border-radius:20px;padding:16px;backdrop-filter:blur(14px)}
.grid{display:grid;gap:14px}
.kpis{grid-template-columns:repeat(2,1fr)}
@media(min-width:800px){.kpis{grid-template-columns:repeat(4,1fr)}.two{grid-template-columns:1fr 1fr}}
.kpi .lab{font-size:12px;color:var(--mut);text-transform:uppercase;letter-spacing:.06em}
.kpi .val{font-size:22px;font-weight:800;margin-top:6px;letter-spacing:-.02em}
.kpi .sub{font-size:12px;color:var(--mut);margin-top:4px}
h3{font-size:15px;margin-bottom:12px;display:flex;align-items:center;gap:8px}
.muted{color:var(--mut);font-size:13px}
.chips{display:flex;gap:8px;flex-wrap:wrap}
.chip{padding:8px 14px;border-radius:999px;border:1px solid var(--line);background:transparent;color:var(--txt);font-size:13px;cursor:pointer}
.chip.on{background:linear-gradient(135deg,var(--pink),var(--violet));border-color:transparent;font-weight:700}
.btn{border:0;border-radius:14px;padding:12px 16px;font-weight:700;font-size:14px;cursor:pointer;color:#fff;background:linear-gradient(135deg,var(--pink),var(--violet));display:inline-flex;align-items:center;justify-content:center;gap:8px}
.btn.ghost{background:transparent;border:1px solid var(--line)}
.btn:disabled{opacity:.5;cursor:not-allowed}
.btn.full{width:100%}
input,textarea,select{width:100%;background:rgba(0,0,0,.3);border:1px solid var(--line);border-radius:12px;padding:11px 12px;color:var(--txt);font-size:14px;outline:none}
input:focus,textarea:focus{border-color:var(--pink)}
label.f{display:block;font-size:12px;color:var(--mut);margin:10px 0 5px}
.row{display:flex;gap:10px;align-items:center}
.between{justify-content:space-between}
.nav{position:fixed;bottom:12px;left:50%;transform:translateX(-50%);z-index:10;display:flex;gap:4px;padding:6px;border-radius:22px;background:rgba(30,10,38,.85);border:1px solid var(--line);backdrop-filter:blur(16px);width:calc(100% - 24px);max-width:520px}
.nav button{flex:1;position:relative;border:0;background:transparent;color:var(--mut);padding:10px 4px;border-radius:16px;font-size:11px;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:3px}
.nav button.on{color:#fff}
.nav .pill{position:absolute;inset:0;border-radius:16px;background:linear-gradient(135deg,rgba(255,45,149,.35),rgba(168,85,247,.35));z-index:-1}
.nav .ic{font-size:19px}
.mv{display:flex;align-items:center;gap:12px;padding:12px 4px;border-bottom:1px solid var(--line)}
.mv:last-child{border-bottom:0}
.av{width:40px;height:40px;border-radius:12px;display:grid;place-items:center;font-size:18px;flex-shrink:0}
.mv .who{font-weight:700;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mv .meta{font-size:12px;color:var(--mut)}
.amt{font-weight:800;white-space:nowrap}
.badge{font-size:10px;padding:3px 7px;border-radius:999px;font-weight:700;letter-spacing:.03em;white-space:nowrap}
.b-ok{background:rgba(52,211,153,.15);color:var(--ok)}.b-bad{background:rgba(251,113,133,.15);color:var(--bad)}.b-warn{background:rgba(250,204,21,.15);color:var(--warn)}.b-mut{background:rgba(255,255,255,.08);color:var(--mut)}
.drop{border:2px dashed rgba(255,45,149,.5);border-radius:20px;padding:26px;text-align:center;cursor:pointer}
.preview{width:100%;max-height:380px;object-fit:contain;border-radius:14px;background:#000}
.bar{height:8px;border-radius:99px;background:rgba(255,255,255,.08);overflow:hidden}
.bar>div{height:100%;background:linear-gradient(90deg,var(--pink),var(--violet))}
.check{display:flex;gap:10px;align-items:flex-start;padding:10px 0;border-bottom:1px solid var(--line)}
.check:last-child{border-bottom:0}
.dot{width:26px;height:26px;border-radius:50%;display:grid;place-items:center;font-size:14px;flex-shrink:0;font-weight:800}
.verdict{border-radius:20px;padding:20px;text-align:center}
.toast{position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:50;display:flex;flex-direction:column;gap:8px;width:calc(100% - 24px);max-width:440px}
.toast>div{padding:12px 14px;border-radius:14px;background:rgba(30,10,38,.95);border:1px solid var(--line);font-size:14px;box-shadow:0 10px 30px rgba(0,0,0,.4)}
.perm{display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--line)}
.perm:last-child{border-bottom:0}
code{background:rgba(0,0,0,.35);padding:2px 6px;border-radius:6px;font-size:12px}
ol.steps{padding-left:18px;font-size:13px;color:var(--mut);line-height:1.6}
.pulse{width:9px;height:9px;border-radius:50%;background:var(--ok);box-shadow:0 0 0 0 rgba(52,211,153,.7);animation:pl 1.8s infinite}
@keyframes pl{70%{box-shadow:0 0 0 10px rgba(52,211,153,0)}100%{box-shadow:0 0 0 0 rgba(52,211,153,0)}}
.recharts-tooltip-wrapper .recharts-default-tooltip{background:#1e0a26!important;border:1px solid rgba(255,255,255,.1)!important;border-radius:12px}
`;

/* =====================================================================
   COMPONENTES BÁSICOS
   ===================================================================== */
function AnimatedNumber({ value, format = fmtCOP }) {
  const mv = useMotionValue(0);
  const spring = useSpring(mv, { stiffness: 70, damping: 18 });
  const fmt = useRef(format);
  fmt.current = format;
  const [display, setDisplay] = useState(format(0));
  useEffect(() => { mv.set(Number(value) || 0); }, [value, mv]);
  useEffect(() => spring.on('change', (v) => setDisplay(fmt.current(v))), [spring]);
  return <span>{display}</span>;
}

const Card = ({ children, delay = 0, style, className = '' }) => (
  <motion.div className={`card ${className}`} style={style}
    initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ delay, type: 'spring', stiffness: 120, damping: 18 }}>
    {children}
  </motion.div>
);

function Blobs() {
  const blobs = [
    { c: '#ff2d95', s: 360, x: ['-10%', '20%', '-10%'], y: ['-10%', '10%', '-10%'] },
    { c: '#7c3aed', s: 420, x: ['70%', '50%', '70%'], y: ['30%', '60%', '30%'] },
    { c: '#06b6d4', s: 260, x: ['10%', '40%', '10%'], y: ['80%', '60%', '80%'] },
  ];
  return blobs.map((b, i) => (
    <motion.div key={i} className="blob" style={{ background: b.c, width: b.s, height: b.s }}
      animate={{ left: b.x, top: b.y }} transition={{ duration: 18 + i * 4, repeat: Infinity, ease: 'easeInOut' }} />
  ));
}

function Badge({ n }) {
  if (n.verified) return <span className="badge b-ok">✓ CORREO VERIFICADO</span>;
  if (n.channels?.includes('sms') || n.channel === 'sms') return <span className="badge b-warn">SMS</span>;
  return <span className="badge b-mut">{(n.channel || 'manual').toUpperCase()}</span>;
}

function MovementRow({ n, i = 0 }) {
  const isIn = n.direction === 'in';
  return (
    <motion.div className="mv" layout initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 20 }} transition={{ delay: Math.min(i * 0.03, 0.4) }}>
      <div className="av" style={{ background: isIn ? 'rgba(52,211,153,.15)' : 'rgba(251,113,133,.15)' }}>{isIn ? '↓' : '↑'}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="who">{titleCase(n.counterparty) || 'Sin nombre'}</div>
        <div className="meta">{fmtDateTime(n.occurred_at)} · {n.bank || 'Nequi'}{n.reference ? ` · ${n.reference}` : ''}</div>
        <div className="row" style={{ gap: 6, marginTop: 4 }}>
          <Badge n={n} />
          {isIn && (n.validated ? <span className="badge b-ok">VALIDADO</span> : <span className="badge b-mut">SIN COMPROBANTE</span>)}
        </div>
      </div>
      <div className="amt" style={{ color: isIn ? 'var(--ok)' : 'var(--bad)' }}>{isIn ? '+' : '−'}{fmtCOP(n.amount)}</div>
    </motion.div>
  );
}

/* =====================================================================
   LOGIN
   ===================================================================== */
function Login({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setMsg('');
    try {
      const d = await rpc('app_login', { p_username: username, p_password: password });
      if (d?.ok) onLogin(d); else setMsg(d?.error || 'No se pudo iniciar sesión');
    } catch (err) { setMsg(err.message); }
    setBusy(false);
  };
  return (
    <div className="wrap" style={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}>
      <Card style={{ width: '100%', maxWidth: 400 }}>
        <motion.div className="logo" style={{ width: 64, height: 64, fontSize: 32, margin: '0 auto 14px' }}
          animate={{ rotate: [0, 8, -8, 0] }} transition={{ duration: 3, repeat: Infinity }}>✓</motion.div>
        <h2 style={{ textAlign: 'center', marginBottom: 4 }}>Validar Pagos</h2>
        <p className="muted" style={{ textAlign: 'center', marginBottom: 12 }}>Analítica y validación de pagos Nequi</p>
        <form onSubmit={submit}>
          <label className="f">Usuario</label>
          <input required value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoCapitalize="none" />
          <label className="f">Contraseña</label>
          <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          <button className="btn full" style={{ marginTop: 16 }} disabled={busy}>{busy ? 'Un momento…' : 'Entrar'}</button>
        </form>
        <AnimatePresence>
          {msg && <motion.p className="muted" style={{ marginTop: 10, color: 'var(--bad)' }} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: [0, -6, 6, 0] }} exit={{ opacity: 0 }}>{msg}</motion.p>}
        </AnimatePresence>
      </Card>
    </div>
  );
}

/* =====================================================================
   DASHBOARD / ANALÍTICA
   ===================================================================== */
const RANGES = [['hoy', 'Hoy', 1], ['7d', '7 días', 7], ['30d', '30 días', 30], ['90d', '90 días', 90]];

function Dashboard({ notifs, vals }) {
  const [range, setRange] = useState('7d');
  const days = RANGES.find((r) => r[0] === range)[2];

  const data = useMemo(() => {
    const today = bogota(new Date().toISOString()).date;
    const start = range === 'hoy' ? new Date(`${today}T00:00:00-05:00`) : new Date(Date.now() - days * 864e5);
    const list = notifs.filter((n) => new Date(n.occurred_at) >= start);
    const ins = list.filter((n) => n.direction === 'in');
    const outs = list.filter((n) => n.direction === 'out');
    const sum = (a) => a.reduce((s, n) => s + Number(n.amount), 0);

    const byBank = Object.values(ins.reduce((acc, n) => {
      const k = titleCase(n.bank || 'Sin banco');
      acc[k] = acc[k] || { name: k, total: 0, count: 0 };
      acc[k].total += Number(n.amount); acc[k].count += 1;
      return acc;
    }, {})).sort((a, b) => b.total - a.total);

    const byPayee = Object.values(outs.reduce((acc, n) => {
      const k = titleCase(n.counterparty || 'Sin nombre');
      acc[k] = acc[k] || { name: k.length > 18 ? k.slice(0, 18) + '…' : k, total: 0 };
      acc[k].total += Number(n.amount);
      return acc;
    }, {})).sort((a, b) => b.total - a.total).slice(0, 6);

    let series;
    if (range === 'hoy') {
      series = Array.from({ length: 24 }, (_, h) => ({ label: `${h}h`, entra: 0, sale: 0 }));
      list.forEach((n) => { series[bogota(n.occurred_at).hour][n.direction === 'in' ? 'entra' : 'sale'] += Number(n.amount); });
    } else {
      const map = {};
      for (let i = days - 1; i >= 0; i--) {
        const d = bogota(new Date(Date.now() - i * 864e5).toISOString()).date;
        map[d] = { label: d.slice(8, 10) + '/' + d.slice(5, 7), entra: 0, sale: 0 };
      }
      list.forEach((n) => { const d = bogota(n.occurred_at).date; if (map[d]) map[d][n.direction === 'in' ? 'entra' : 'sale'] += Number(n.amount); });
      series = Object.values(map);
    }

    const hours = Array.from({ length: 24 }, (_, h) => ({ label: `${h}`, pagos: 0 }));
    ins.forEach((n) => { hours[bogota(n.occurred_at).hour].pagos += 1; });

    const vlist = vals.filter((v) => new Date(v.created_at) >= start);
    const vstats = ['aprobado', 'revisar', 'rechazado'].map((s) => ({ name: s, value: vlist.filter((v) => v.status === s).length }));
    const validatedPct = ins.length ? (ins.filter((n) => n.validated).length / ins.length) * 100 : 0;
    const verifiedPct = ins.length ? (ins.filter((n) => n.verified).length / ins.length) * 100 : 0;

    return { ins, outs, totalIn: sum(ins), totalOut: sum(outs), byBank, byPayee, series, hours, vstats, validatedPct, verifiedPct, recent: list.slice(0, 8) };
  }, [notifs, vals, range, days]);

  const axis = { stroke: '#b9a6c2', fontSize: 11, tickLine: false, axisLine: false };
  return (
    <div className="grid">
      <div className="chips">
        {RANGES.map(([k, l]) => <button key={k} className={`chip ${range === k ? 'on' : ''}`} onClick={() => setRange(k)}>{l}</button>)}
      </div>

      <div className="grid kpis">
        <Card className="kpi" delay={0}><div className="lab">Recibido</div><div className="val" style={{ color: 'var(--ok)' }}><AnimatedNumber value={data.totalIn} /></div><div className="sub">{data.ins.length} pagos</div></Card>
        <Card className="kpi" delay={0.05}><div className="lab">Pagado</div><div className="val" style={{ color: 'var(--bad)' }}><AnimatedNumber value={data.totalOut} /></div><div className="sub">{data.outs.length} pagos</div></Card>
        <Card className="kpi" delay={0.1}><div className="lab">Neto</div><div className="val"><AnimatedNumber value={data.totalIn - data.totalOut} /></div><div className="sub">entradas − salidas</div></Card>
        <Card className="kpi" delay={0.15}><div className="lab">Validados</div><div className="val"><AnimatedNumber value={data.validatedPct} format={(v) => `${Math.round(v)}%`} /></div><div className="sub">{Math.round(data.verifiedPct)}% con correo verificado</div></Card>
      </div>

      <Card delay={0.2}>
        <h3>📈 Flujo de dinero</h3>
        <div style={{ height: 230 }}>
          <ResponsiveContainer>
            <AreaChart data={data.series}>
              <defs>
                <linearGradient id="gIn" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#34d399" stopOpacity={0.6} /><stop offset="1" stopColor="#34d399" stopOpacity={0} /></linearGradient>
                <linearGradient id="gOut" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#ff2d95" stopOpacity={0.6} /><stop offset="1" stopColor="#ff2d95" stopOpacity={0} /></linearGradient>
              </defs>
              <CartesianGrid stroke="rgba(255,255,255,.06)" vertical={false} />
              <XAxis dataKey="label" {...axis} />
              <YAxis {...axis} tickFormatter={(v) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${Math.round(v / 1e3)}k` : v)} width={40} />
              <Tooltip formatter={(v) => fmtCOP(v)} />
              <Area type="monotone" dataKey="entra" name="Recibido" stroke="#34d399" fill="url(#gIn)" strokeWidth={2} animationDuration={1200} />
              <Area type="monotone" dataKey="sale" name="Pagado" stroke="#ff2d95" fill="url(#gOut)" strokeWidth={2} animationDuration={1200} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <div className="grid two">
        <Card delay={0.25}>
          <h3>🏦 Pagos recibidos por banco</h3>
          {data.byBank.length === 0 ? <p className="muted">Sin datos en este periodo.</p> : (
            <>
              <div style={{ height: 200 }}>
                <ResponsiveContainer>
                  <PieChart>
                    <Pie data={data.byBank} dataKey="total" nameKey="name" innerRadius={50} outerRadius={85} paddingAngle={3} animationDuration={1000}>
                      {data.byBank.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} stroke="none" />)}
                    </Pie>
                    <Tooltip formatter={(v) => fmtCOP(v)} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              {data.byBank.map((b, i) => (
                <div key={b.name} style={{ marginTop: 10 }}>
                  <div className="row between" style={{ fontSize: 13 }}>
                    <span className="row" style={{ gap: 8 }}><span style={{ width: 10, height: 10, borderRadius: 3, background: PALETTE[i % PALETTE.length] }} />{b.name} <span className="muted">· {b.count}</span></span>
                    <b>{fmtCOP(b.total)}</b>
                  </div>
                  <div className="bar" style={{ marginTop: 6 }}>
                    <motion.div initial={{ width: 0 }} animate={{ width: `${(b.total / data.totalIn) * 100}%` }} transition={{ duration: 1, delay: i * 0.1 }}
                      style={{ background: PALETTE[i % PALETTE.length] }} />
                  </div>
                </div>
              ))}
            </>
          )}
        </Card>

        <Card delay={0.3}>
          <h3>🕒 Horas con más pagos recibidos</h3>
          <div style={{ height: 200 }}>
            <ResponsiveContainer>
              <BarChart data={data.hours}>
                <XAxis dataKey="label" {...axis} interval={2} />
                <YAxis {...axis} allowDecimals={false} width={24} />
                <Tooltip />
                <Bar dataKey="pagos" radius={[6, 6, 0, 0]} animationDuration={1000}>
                  {data.hours.map((h, i) => <Cell key={i} fill={h.pagos ? '#a855f7' : 'rgba(255,255,255,.08)'} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <h3 style={{ marginTop: 14 }}>🧾 Validaciones de comprobantes</h3>
          <div className="row" style={{ gap: 10 }}>
            {data.vstats.map((s) => (
              <div key={s.name} className="card" style={{ flex: 1, padding: 12, textAlign: 'center' }}>
                <div style={{ fontSize: 22, fontWeight: 800, color: s.name === 'aprobado' ? 'var(--ok)' : s.name === 'rechazado' ? 'var(--bad)' : 'var(--warn)' }}>
                  <AnimatedNumber value={s.value} format={(v) => Math.round(v)} />
                </div>
                <div className="muted" style={{ textTransform: 'capitalize' }}>{s.name}</div>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {data.byPayee.length > 0 && (
        <Card delay={0.35}>
          <h3>💸 ¿A quién le pagaste?</h3>
          <div style={{ height: 220 }}>
            <ResponsiveContainer>
              <BarChart data={data.byPayee} layout="vertical" margin={{ left: 10 }}>
                <XAxis type="number" {...axis} hide />
                <YAxis type="category" dataKey="name" {...axis} width={120} />
                <Tooltip formatter={(v) => fmtCOP(v)} />
                <Bar dataKey="total" fill="#ff2d95" radius={[0, 8, 8, 0]} animationDuration={1000} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      )}

      <Card delay={0.4}>
        <h3><span className="pulse" /> Movimientos recientes</h3>
        {data.recent.length === 0 && <p className="muted">Aún no hay movimientos. Configura Gmail o comparte un SMS en la pestaña Permisos.</p>}
        <AnimatePresence initial={false}>
          {data.recent.map((n, i) => <MovementRow key={n.id} n={n} i={i} />)}
        </AnimatePresence>
      </Card>
    </div>
  );
}

/* =====================================================================
   VALIDAR PANTALLAZO
   ===================================================================== */
function Validator({ session, sharedFile, onConsumed, toast }) {
  const isAdmin = session.role === 'admin';
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState('');
  const [progress, setProgress] = useState(0);
  const [ocrText, setOcrText] = useState('');
  const [hash, setHash] = useState('');
  const [fields, setFields] = useState({ amount: '', name: '', date: '', time: '', reference: '' });
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const pickRef = useRef(null);
  const camRef = useRef(null);

  const verify = useCallback(async (f, imgHash, text) => {
    const amount = Number(f.amount);
    const occurredISO = toBogotaISO(f.date, f.time);
    if (!amount || !occurredISO) {
      setResult({ status: 'revisar', score: 0, checks: [{ ok: null, t: 'Datos incompletos', d: 'Completa valor, fecha y hora del comprobante.' }] });
      return;
    }
    const minute = new Date(occurredISO).getTime();

    let lookup;
    try {
      lookup = await rpc('validation_lookup', {
        p_token: session.token, p_amount: amount, p_occurred_at: occurredISO,
        p_image_hash: imgHash || null, p_reference: f.reference || null,
      });
    } catch (e) { toast('Error consultando: ' + e.message); return; }

    const ranked = (lookup.candidates || []).map((n) => {
      const t = new Date(n.occurred_at).getTime();
      return { n, exact: t >= minute && t < minute + 60000, name: nameScore(n.counterparty, f.name, text) };
    }).sort((a, b) => (b.exact - a.exact) || (a.n.validated - b.n.validated) || (b.name - a.name));
    const best = ranked[0];
    const dupImg = lookup.dup_image;
    const dupRef = lookup.dup_reference;

    const checks = [];
    checks.push(!best
      ? { ok: false, t: 'Notificación de Nequi', d: `No hay un pago recibido de ${fmtCOP(amount)} cerca de ${f.time}` }
      : best.n.verified
        ? { ok: true, t: 'Origen de la notificación', d: `Correo de ${AUTHORIZED.in} con firma DKIM/DMARC válida` }
        : best.n.trusted
          ? { ok: null, t: 'Origen de la notificación', d: 'Confirmado por SMS de Nequi; el correo verificado aún no llega' }
          : { ok: isAdmin ? null : false, t: 'Origen de la notificación', d: 'Registrado manualmente, sin confirmación oficial de Nequi todavía' });
    if (best) {
      checks.push({ ok: Number(best.n.amount) === amount, t: 'Valor exacto', d: `Comprobante ${fmtCOP(amount)} · Nequi ${fmtCOP(best.n.amount)}` });
      checks.push({ ok: best.exact, t: 'Hora exacta', d: `Comprobante ${f.date} ${f.time} · Nequi ${bogota(best.n.occurred_at).date} ${bogota(best.n.occurred_at).time}` });
      checks.push({ ok: best.name >= 0.6 ? true : best.name > 0 ? null : false, t: 'Nombre del pagador',
        d: `${titleCase(best.n.counterparty)} · coincidencia ${Math.round(best.name * 100)}%` });
      checks.push({ ok: !best.n.validated, t: 'Pago no usado antes', d: best.n.validated ? 'Este pago ya fue validado con otro comprobante' : 'Disponible' });
      if (best.n.reference && f.reference) {
        checks.push({ ok: norm(best.n.reference) === norm(f.reference), t: 'Número de movimiento', d: `Comprobante ${f.reference} · Nequi ${best.n.reference}` });
      }
    }
    checks.push(f.reference
      ? { ok: !dupRef, t: 'Número de movimiento único', d: dupRef ? `${f.reference} ya fue usado` : `${f.reference} no se ha usado` }
      : { ok: null, t: 'Número de movimiento', d: 'No se detectó en el pantallazo' });
    checks.push({ ok: !dupImg, t: 'Pantallazo nuevo', d: dupImg ? 'Esta misma imagen ya fue presentada' : 'Imagen nunca antes usada' });

    const hardFail = checks.some((c) => c.ok === false);
    const score = Math.round((checks.filter((c) => c.ok === true).length / checks.length) * 100);
    const status = hardFail ? 'rechazado' : checks.every((c) => c.ok === true) ? 'aprobado' : 'revisar';
    setResult({ status, score, checks, best: best?.n, occurredISO });
  }, [toast, session.token, isAdmin]);

  const processFile = useCallback(async (f) => {
    if (!f) return;
    setFile(f); setResult(null); setOcrText(''); setProgress(0);
    setPreview(URL.createObjectURL(f));
    const h = await sha256(f);
    setHash(h);
    try {
      const Tesseract = (await import('tesseract.js')).default;
      const { data } = await Tesseract.recognize(f, 'spa', {
        logger: (m) => m.status === 'recognizing text' && setProgress(Math.round(m.progress * 100)),
      });
      setProgress(100);
      setOcrText(data.text);
      const parsed = parseReceipt(data.text);
      setFields(parsed);
      await verify(parsed, h, data.text);
    } catch (e) {
      toast('No se pudo leer la imagen: ' + e.message);
    }
  }, [verify, toast]);

  useEffect(() => {
    if (sharedFile) { processFile(sharedFile); onConsumed(); }
  }, [sharedFile, processFile, onConsumed]);

  const register = async (status) => {
    setBusy(true);
    const { error } = await supabase.rpc('register_validation', {
      p_token: session.token,
      p_notification_id: result?.best?.id || null,
      p_status: status,
      p_score: result?.score || 0,
      p_image_hash: hash || null,
      p_reference: fields.reference || null,
      p_amount: Number(fields.amount) || null,
      p_payer_name: fields.name || result?.best?.counterparty || null,
      p_occurred_at: result?.occurredISO || null,
      p_ocr_text: ocrText,
      p_parsed: fields,
      p_checks: result?.checks || [],
    });
    setBusy(false);
    if (error) { toast('⚠️ ' + error.message); return; }
    toast(status === 'aprobado' ? '✅ Pago validado y registrado' : '📝 Validación registrada como ' + status);
    if (status === 'aprobado') speak(`Pago validado. ${voiceText(result.best)}`);
    setFile(null); setPreview(''); setResult(null); setOcrText(''); setFields({ amount: '', name: '', date: '', time: '', reference: '' });
  };

  const set = (k) => (e) => setFields((p) => ({ ...p, [k]: e.target.value }));
  const color = { aprobado: 'var(--ok)', rechazado: 'var(--bad)', revisar: 'var(--warn)' };

  return (
    <div className="grid">
      <Card>
        <h3>🧾 Validar pantallazo de pago</h3>
        <p className="muted" style={{ marginBottom: 12 }}>
          Se compara con la notificación oficial de <code>{AUTHORIZED.in}</code>: valor exacto, hora exacta, nombre y número de movimiento.
        </p>
        {!preview ? (
          <motion.div className="drop" whileHover={{ scale: 1.01 }} whileTap={{ scale: 0.98 }} onClick={() => pickRef.current?.click()}
            onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); processFile(e.dataTransfer.files[0]); }}>
            <motion.div style={{ fontSize: 44 }} animate={{ y: [0, -8, 0] }} transition={{ duration: 2, repeat: Infinity }}>📲</motion.div>
            <p style={{ fontWeight: 700, marginTop: 8 }}>Toca para subir el pantallazo</p>
            <p className="muted">o compártelo desde WhatsApp → “Validar Pagos”</p>
          </motion.div>
        ) : (
          <motion.img className="preview" src={preview} alt="Comprobante" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} />
        )}
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn ghost" style={{ flex: 1 }} onClick={() => pickRef.current?.click()}>🖼️ Galería</button>
          <button className="btn ghost" style={{ flex: 1 }} onClick={() => camRef.current?.click()}>📷 Cámara</button>
        </div>
        <input ref={pickRef} type="file" accept="image/*" hidden onChange={(e) => processFile(e.target.files[0])} />
        <input ref={camRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => processFile(e.target.files[0])} />
        {file && progress < 100 && (
          <div style={{ marginTop: 14 }}>
            <div className="row between muted"><span>Leyendo comprobante (OCR)…</span><span>{progress}%</span></div>
            <div className="bar" style={{ marginTop: 6 }}><motion.div animate={{ width: `${progress}%` }} /></div>
          </div>
        )}
      </Card>

      {ocrText && (
        <Card delay={0.05}>
          <h3>✏️ Datos detectados <span className="muted">(corrige si es necesario)</span></h3>
          <div className="grid two">
            <div><label className="f">Valor exacto (COP)</label><input inputMode="decimal" value={fields.amount} onChange={set('amount')} /></div>
            <div><label className="f">Nombre del pagador</label><input value={fields.name} onChange={set('name')} /></div>
            <div><label className="f">Fecha</label><input type="date" value={fields.date} onChange={set('date')} /></div>
            <div><label className="f">Hora exacta</label><input type="time" value={fields.time} onChange={set('time')} /></div>
            <div><label className="f">Número de movimiento / referencia</label><input value={fields.reference} onChange={set('reference')} /></div>
          </div>
          <button className="btn ghost full" style={{ marginTop: 14 }} onClick={() => verify(fields, hash, ocrText)}>🔁 Volver a verificar</button>
          <details style={{ marginTop: 10 }}><summary className="muted">Texto leído</summary><pre className="muted" style={{ whiteSpace: 'pre-wrap', marginTop: 8, fontSize: 11 }}>{ocrText}</pre></details>
        </Card>
      )}

      <AnimatePresence>
        {result && (
          <motion.div key={result.status + result.score} initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="grid">
            <div className="verdict" style={{ background: `linear-gradient(135deg, ${color[result.status]}33, transparent)`, border: `1px solid ${color[result.status]}` }}>
              <motion.div style={{ fontSize: 54 }} initial={{ scale: 0, rotate: -90 }} animate={{ scale: 1, rotate: 0 }} transition={{ type: 'spring', stiffness: 200 }}>
                {result.status === 'aprobado' ? '✅' : result.status === 'rechazado' ? '⛔' : '⚠️'}
              </motion.div>
              <div style={{ fontSize: 22, fontWeight: 800, color: color[result.status], textTransform: 'uppercase' }}>{result.status}</div>
              <div className="muted">Confianza {result.score}%</div>
            </div>
            <div className="card">
              {result.checks.map((c, i) => (
                <motion.div className="check" key={i} initial={{ opacity: 0, x: -14 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.08 }}>
                  <div className="dot" style={{ background: c.ok === true ? 'rgba(52,211,153,.2)' : c.ok === false ? 'rgba(251,113,133,.2)' : 'rgba(250,204,21,.2)', color: c.ok === true ? 'var(--ok)' : c.ok === false ? 'var(--bad)' : 'var(--warn)' }}>
                    {c.ok === true ? '✓' : c.ok === false ? '✕' : '!'}
                  </div>
                  <div><div style={{ fontWeight: 700, fontSize: 14 }}>{c.t}</div><div className="muted">{c.d}</div></div>
                </motion.div>
              ))}
            </div>
            <div className="row">
              {result.status !== 'rechazado' && result.best && (
                <button className="btn" style={{ flex: 1 }} disabled={busy} onClick={() => register('aprobado')}>✅ Confirmar pago</button>
              )}
              <button className="btn ghost" style={{ flex: 1 }} disabled={busy} onClick={() => register(result.status === 'aprobado' ? 'revisar' : result.status)}>
                Guardar como {result.status === 'aprobado' ? 'revisar' : result.status}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* =====================================================================
   MOVIMIENTOS + INGRESO MANUAL DE SMS / CORREO
   ===================================================================== */
function Movements({ session, notifs, toast, sharedText, onConsumed }) {
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const ingest = useCallback(async (raw, channel) => {
    if (!raw?.trim()) return;
    setBusy(true);
    try {
      const data = await rpc('ingest_notification', { p_raw: raw, p_channel: channel, p_token: session.token });
      if (!data?.ok) toast('⚠️ ' + data?.error);
      else { toast(data.new ? '✅ Movimiento registrado' : 'ℹ️ Ya estaba registrado'); setText(''); }
    } catch (e) { toast('⚠️ ' + e.message); }
    setBusy(false);
  }, [toast, session.token]);

  useEffect(() => {
    if (sharedText) { setText(sharedText); ingest(sharedText, 'share'); onConsumed(); }
  }, [sharedText, ingest, onConsumed]);

  const paste = async () => {
    try { const t = await navigator.clipboard.readText(); setText(t); } catch { toast('Permite el acceso al portapapeles en Permisos'); }
  };

  const list = notifs.filter((n) => (filter === 'all' || n.direction === filter)
    && (!q || norm(`${n.counterparty} ${n.bank} ${n.reference} ${n.amount}`).includes(norm(q))));

  return (
    <div className="grid">
      <Card>
        <h3>📩 Registrar SMS o correo de Nequi</h3>
        <p className="muted" style={{ marginBottom: 10 }}>Pega el texto o compártelo desde la app de mensajes. Los registros manuales quedan como “no verificados” hasta que llegue el correo oficial.</p>
        <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder="Recibiste 70.000 de ... el 17 de octubre de 2026 a las 9:13 a.m, desde el banco Nubank." />
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn ghost" style={{ flex: 1 }} onClick={paste}>📋 Pegar</button>
          <button className="btn" style={{ flex: 1 }} disabled={busy || !text.trim()} onClick={() => ingest(text, 'manual')}>Registrar</button>
        </div>
      </Card>
      <Card delay={0.05}>
        <div className="row between" style={{ marginBottom: 10, flexWrap: 'wrap' }}>
          <div className="chips">
            {[['all', 'Todos'], ['in', 'Recibidos'], ['out', 'Pagados']].map(([k, l]) => (
              <button key={k} className={`chip ${filter === k ? 'on' : ''}`} onClick={() => setFilter(k)}>{l}</button>
            ))}
          </div>
        </div>
        <input placeholder="Buscar nombre, banco, referencia o valor…" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 6 }} />
        <AnimatePresence initial={false}>
          {list.slice(0, 200).map((n, i) => <MovementRow key={n.id} n={n} i={i} />)}
        </AnimatePresence>
        {!list.length && <p className="muted" style={{ marginTop: 10 }}>Sin movimientos.</p>}
      </Card>
    </div>
  );
}

/* =====================================================================
   PERMISOS Y CONEXIONES
   ===================================================================== */
function Permissions({ voiceOn, setVoiceOn, toast, installEvt, session, onLogout }) {
  const [state, setState] = useState({});
  const wakeRef = useRef(null);

  const refresh = useCallback(async () => {
    const s = {};
    s.notifications = 'Notification' in window ? Notification.permission : 'no soportado';
    for (const [k, name] of [['camera', 'camera'], ['clipboard', 'clipboard-read']]) {
      try { s[k] = (await navigator.permissions.query({ name })).state; } catch { s[k] = 'prompt'; }
    }
    s.storage = navigator.storage?.persisted ? ((await navigator.storage.persisted()) ? 'granted' : 'prompt') : 'no soportado';
    s.voice = voiceOn ? 'granted' : 'prompt';
    s.wake = wakeRef.current ? 'granted' : ('wakeLock' in navigator ? 'prompt' : 'no soportado');
    s.install = window.matchMedia('(display-mode: standalone)').matches ? 'granted' : installEvt ? 'prompt' : 'manual';
    setState(s);
  }, [voiceOn, installEvt]);
  useEffect(() => { refresh(); }, [refresh]);

  const perms = [
    { id: 'notifications', icon: '🔔', t: 'Notificaciones', d: 'Alerta cada vez que entra o sale dinero',
      req: async () => { await Notification.requestPermission(); } },
    { id: 'voice', icon: '🔊', t: 'Voz', d: '“Recibiste … de …” / “Hiciste un pago por valor de … a …”',
      req: async () => { setVoiceOn(true); speak('Voz activada. Te avisaré cada pago recibido y cada pago realizado.'); } },
    { id: 'camera', icon: '📷', t: 'Cámara', d: 'Fotografiar comprobantes en otra pantalla',
      req: async () => { const st = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }); st.getTracks().forEach((t) => t.stop()); } },
    { id: 'clipboard', icon: '📋', t: 'Portapapeles', d: 'Pegar SMS o correos copiados',
      req: async () => { await navigator.clipboard.readText(); } },
    { id: 'storage', icon: '💾', t: 'Almacenamiento persistente', d: 'Evita que Android borre los datos de la app',
      req: async () => { await navigator.storage.persist(); } },
    { id: 'wake', icon: '💡', t: 'Modo caja (pantalla encendida)', d: 'Mantiene la pantalla activa para escuchar los pagos',
      req: async () => { wakeRef.current = await navigator.wakeLock.request('screen'); wakeRef.current.addEventListener('release', () => { wakeRef.current = null; refresh(); }); } },
    { id: 'install', icon: '📲', t: 'Instalar app', d: 'Necesario para recibir SMS y pantallazos con “Compartir”',
      req: async () => { if (installEvt) { installEvt.prompt(); await installEvt.userChoice; } else toast('En Chrome: menú ⋮ → “Instalar aplicación”'); } },
  ];

  const ask = async (p) => {
    try { await p.req(); } catch (e) { toast(`${p.t}: ${e.message || 'denegado'}`); }
    refresh();
  };
  const askAll = async () => { for (const p of perms) if (state[p.id] !== 'granted' && p.id !== 'install') await ask(p); };
  const badge = (s) => (s === 'granted' ? <span className="badge b-ok">ACTIVO</span>
    : s === 'denied' ? <span className="badge b-bad">BLOQUEADO</span>
      : s === 'no soportado' ? <span className="badge b-mut">N/D</span> : <span className="badge b-warn">PENDIENTE</span>);

  return (
    <div className="grid">
      <Card>
        <div className="row between" style={{ marginBottom: 6 }}>
          <h3 style={{ margin: 0 }}>🔐 Permisos del celular</h3>
          <button className="btn" onClick={askAll}>Conceder todos</button>
        </div>
        {perms.map((p, i) => (
          <motion.div className="perm" key={p.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}>
            <div className="av" style={{ background: 'rgba(168,85,247,.18)' }}>{p.icon}</div>
            <div style={{ flex: 1 }}><div style={{ fontWeight: 700, fontSize: 14 }}>{p.t}</div><div className="muted">{p.d}</div></div>
            {state[p.id] === 'granted' ? badge('granted') : <button className="btn ghost" style={{ padding: '8px 12px' }} onClick={() => ask(p)}>{badge(state[p.id])}</button>}
          </motion.div>
        ))}
        <button className="btn ghost full" style={{ marginTop: 12 }} onClick={() => {
          speak(voiceText({ direction: 'in', amount: 70000, counterparty: 'Diccter Fernando Perea Rodriguez' }));
          speak(voiceText({ direction: 'out', amount: 41649, counterparty: 'Comunicacion Celular Comcel' }));
        }}>▶️ Probar voz</button>
      </Card>

      {session.role === 'admin' && <UsersAdmin session={session} toast={toast} />}
      <ChangePassword session={session} toast={toast} />

      {session.role === 'admin' && <>
      <Card delay={0.05}>
        <h3>✉️ Lectura de correos (Gmail)</h3>
        <p className="muted">Android no permite que una app web lea la bandeja de entrada. Por eso un script de Google en tu propia cuenta lee <b>solo</b> los correos de <code>{AUTHORIZED.in}</code> y <code>{AUTHORIZED.out}</code>, verifica la firma DKIM/DMARC de <code>nequi.com.co</code> y los envía a la base de datos al instante.</p>
        <ol className="steps" style={{ marginTop: 8 }}>
          <li>En Supabase ejecuta <code>supabase/schema.sql</code>.</li>
          <li>Copia tu secreto: <code>select value from app_config where key='ingest_secret';</code></li>
          <li>Abre script.google.com, pega <code>integraciones/gmail-apps-script.gs</code> y reemplaza el secreto.</li>
          <li>Ejecuta <code>instalarActivador</code> y acepta los permisos de Gmail.</li>
        </ol>
      </Card>

      <Card delay={0.1}>
        <h3>💬 Lectura de SMS</h3>
        <p className="muted">El navegador no puede leer SMS. Usa una de estas opciones:</p>
        <ol className="steps" style={{ marginTop: 8 }}>
          <li><b>Automático:</b> con MacroDroid/Tasker crea la regla “SMS recibido que contenga <i>Nequi</i>” → petición HTTP POST a <code>{SUPABASE_URL}/rest/v1/rpc/ingest_notification</code> con los encabezados <code>apikey</code> y <code>Authorization: Bearer &lt;anon key&gt;</code> y cuerpo JSON <code>{'{"p_raw":"[texto sms]","p_channel":"sms","p_sender":"[número]","p_secret":"[secreto]"}'}</code>.</li>
          <li><b>Compartir:</b> mantén presionado el SMS → Compartir → <b>Validar Pagos</b> (requiere instalar la app).</li>
          <li><b>Pegar:</b> copia el SMS y usa “Pegar” en la pestaña Movimientos.</li>
        </ol>
      </Card>
      </>}

      <Card delay={0.15}>
        <div className="row between">
          <div>
            <div style={{ fontWeight: 700 }}>{session.display_name}</div>
            <div className="muted">@{session.username} · {session.role === 'admin' ? 'Administrador' : 'Trabajador'}</div>
          </div>
          <button className="btn ghost" onClick={onLogout}>Salir</button>
        </div>
      </Card>
    </div>
  );
}

/* =====================================================================
   USUARIOS (solo admin) Y CAMBIO DE CONTRASEÑA
   ===================================================================== */
const EMPTY_USER = { username: '', display_name: '', role: 'trabajador', password: '', active: true, isNew: true };

function UsersAdmin({ session, toast }) {
  const [users, setUsers] = useState([]);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setUsers(await rpc('list_users', { p_token: session.token })); } catch (e) { toast('⚠️ ' + e.message); }
  }, [session.token, toast]);
  useEffect(() => { load(); }, [load]);

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await rpc('save_user', {
        p_token: session.token, p_username: form.username, p_password: form.password || null,
        p_role: form.role, p_display_name: form.display_name, p_active: form.active,
      });
      toast('✅ Usuario guardado');
      setForm(null);
      load();
    } catch (err) { toast('⚠️ ' + err.message); }
    setBusy(false);
  };
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  return (
    <Card delay={0.03}>
      <div className="row between" style={{ marginBottom: 6 }}>
        <h3 style={{ margin: 0 }}>👥 Usuarios</h3>
        <button className="btn ghost" style={{ padding: '8px 12px' }} onClick={() => setForm(form ? null : EMPTY_USER)}>{form ? 'Cerrar' : '+ Nuevo'}</button>
      </div>
      <AnimatePresence>
        {form && (
          <motion.form onSubmit={save} initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} style={{ overflow: 'hidden' }}>
            <div className="grid two">
              <div><label className="f">Usuario</label><input required value={form.username} onChange={set('username')} disabled={!form.isNew} autoCapitalize="none" /></div>
              <div><label className="f">Nombre</label><input value={form.display_name || ''} onChange={set('display_name')} /></div>
              <div><label className="f">Rol</label>
                <select value={form.role} onChange={set('role')}><option value="trabajador">Trabajador (caja / validar)</option><option value="admin">Administrador</option></select>
              </div>
              <div><label className="f">{form.isNew ? 'Contraseña' : 'Nueva contraseña (opcional)'}</label><input type="password" value={form.password} onChange={set('password')} required={form.isNew} minLength={4} autoComplete="new-password" /></div>
            </div>
            <label className="row muted" style={{ marginTop: 12, gap: 8 }}><input type="checkbox" style={{ width: 'auto' }} checked={form.active} onChange={set('active')} /> Activo</label>
            <button className="btn full" style={{ marginTop: 12 }} disabled={busy}>Guardar</button>
          </motion.form>
        )}
      </AnimatePresence>
      {users.map((u) => (
        <div className="perm" key={u.id}>
          <div className="av" style={{ background: u.role === 'admin' ? 'rgba(255,45,149,.18)' : 'rgba(34,211,238,.15)' }}>{u.role === 'admin' ? '👑' : '🧑‍💼'}</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 14 }}>{u.display_name || u.username} <span className="muted">@{u.username}</span></div>
            <div className="row" style={{ gap: 6, marginTop: 3 }}>
              <span className="badge b-mut">{u.role.toUpperCase()}</span>
              {!u.active && <span className="badge b-bad">INACTIVO</span>}
              {u.locked && <span className="badge b-warn">BLOQUEADO</span>}
            </div>
          </div>
          <button className="btn ghost" style={{ padding: '8px 12px' }} onClick={() => setForm({ ...u, password: '', isNew: false })}>Editar</button>
        </div>
      ))}
    </Card>
  );
}

function ChangePassword({ session, toast }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ old: '', next: '' });
  const submit = async (e) => {
    e.preventDefault();
    try {
      await rpc('change_password', { p_token: session.token, p_old: f.old, p_new: f.next });
      toast('✅ Contraseña actualizada'); setOpen(false); setF({ old: '', next: '' });
    } catch (err) { toast('⚠️ ' + err.message); }
  };
  return (
    <Card delay={0.04}>
      <div className="row between"><h3 style={{ margin: 0 }}>🔑 Mi contraseña</h3>
        <button className="btn ghost" style={{ padding: '8px 12px' }} onClick={() => setOpen(!open)}>{open ? 'Cerrar' : 'Cambiar'}</button></div>
      {open && (
        <form onSubmit={submit}>
          <label className="f">Contraseña actual</label><input type="password" required value={f.old} onChange={(e) => setF({ ...f, old: e.target.value })} autoComplete="current-password" />
          <label className="f">Nueva contraseña</label><input type="password" required minLength={4} value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} autoComplete="new-password" />
          <button className="btn full" style={{ marginTop: 12 }}>Guardar</button>
        </form>
      )}
    </Card>
  );
}

/* =====================================================================
   CAJA EN VIVO (vista del trabajador): escuchar y validar pagos
   ===================================================================== */
function LiveDesk({ notifs, voiceOn, setVoiceOn, live, goValidate }) {
  const today = bogota(new Date().toISOString()).date;
  const todays = notifs.filter((n) => n.direction === 'in' && bogota(n.occurred_at).date === today);
  const last = todays[0];
  const total = todays.reduce((s, n) => s + Number(n.amount), 0);
  const pending = todays.filter((n) => !n.validated).length;

  return (
    <div className="grid">
      <Card>
        <div className="row" style={{ gap: 16 }}>
          <div style={{ position: 'relative', width: 64, height: 64, flexShrink: 0 }}>
            {live && voiceOn && [0, 1, 2].map((i) => (
              <motion.div key={i} style={{ position: 'absolute', inset: 0, borderRadius: '50%', border: '2px solid var(--pink)' }}
                animate={{ scale: [1, 1.9], opacity: [0.7, 0] }} transition={{ duration: 2.4, repeat: Infinity, delay: i * 0.8 }} />
            ))}
            <button onClick={() => { setVoiceOn(!voiceOn); if (!voiceOn) speak('Escuchando pagos'); }}
              style={{ position: 'absolute', inset: 0, borderRadius: '50%', border: 0, fontSize: 28, cursor: 'pointer', color: '#fff',
                background: voiceOn ? 'linear-gradient(135deg,var(--pink),var(--violet))' : 'rgba(255,255,255,.1)' }}>
              {voiceOn ? '🔊' : '🔇'}
            </button>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 800, fontSize: 18 }}>{voiceOn ? 'Escuchando pagos' : 'Voz desactivada'}</div>
            <div className="muted">{live ? 'Conectado en vivo · ' : 'Reconectando… · '}{voiceOn ? 'Te avisaré con voz cada pago recibido' : 'Toca el botón para activar la voz'}</div>
          </div>
        </div>
      </Card>

      <AnimatePresence mode="wait">
        {last ? (
          <motion.div key={last.id} className="card" style={{ textAlign: 'center', padding: 24, background: 'linear-gradient(135deg, rgba(52,211,153,.18), rgba(168,85,247,.12))' }}
            initial={{ opacity: 0, scale: 0.85, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.9 }} transition={{ type: 'spring', stiffness: 160, damping: 16 }}>
            <div className="muted" style={{ textTransform: 'uppercase', letterSpacing: '.08em', fontSize: 12 }}>Último pago recibido</div>
            <motion.div style={{ fontSize: 40, fontWeight: 900, color: 'var(--ok)', margin: '6px 0' }} initial={{ scale: 0.6 }} animate={{ scale: [0.6, 1.12, 1] }} transition={{ duration: 0.6 }}>
              +{fmtCOP(last.amount)}
            </motion.div>
            <div style={{ fontWeight: 700, fontSize: 17 }}>{titleCase(last.counterparty)}</div>
            <div className="muted">{bogota(last.occurred_at).time} · {last.bank || 'Nequi'}</div>
            <div className="row" style={{ justifyContent: 'center', gap: 8, marginTop: 10 }}>
              <Badge n={last} />
              {last.validated ? <span className="badge b-ok">VALIDADO</span> : <span className="badge b-warn">PENDIENTE DE COMPROBANTE</span>}
            </div>
            <div className="row" style={{ marginTop: 16 }}>
              <button className="btn ghost" style={{ flex: 1 }} onClick={() => speak(voiceText(last))}>🔁 Repetir</button>
              <button className="btn" style={{ flex: 1 }} onClick={goValidate}>🧾 Validar pantallazo</button>
            </div>
          </motion.div>
        ) : (
          <motion.div key="empty" className="card" style={{ textAlign: 'center', padding: 28 }} initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            <motion.div style={{ fontSize: 44 }} animate={{ scale: [1, 1.1, 1] }} transition={{ duration: 2, repeat: Infinity }}>👂</motion.div>
            <p style={{ fontWeight: 700, marginTop: 8 }}>Esperando pagos de hoy…</p>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(3,1fr)' }}>
        <Card className="kpi"><div className="lab">Hoy</div><div className="val" style={{ fontSize: 18, color: 'var(--ok)' }}><AnimatedNumber value={total} /></div></Card>
        <Card className="kpi" delay={0.05}><div className="lab">Pagos</div><div className="val" style={{ fontSize: 18 }}><AnimatedNumber value={todays.length} format={(v) => Math.round(v)} /></div></Card>
        <Card className="kpi" delay={0.1}><div className="lab">Pendientes</div><div className="val" style={{ fontSize: 18, color: pending ? 'var(--warn)' : 'var(--ok)' }}><AnimatedNumber value={pending} format={(v) => Math.round(v)} /></div></Card>
      </div>

      <Card delay={0.15}>
        <h3><span className="pulse" /> Pagos recibidos hoy</h3>
        {!todays.length && <p className="muted">Aún no hay pagos hoy.</p>}
        <AnimatePresence initial={false}>
          {todays.map((n, i) => <MovementRow key={n.id} n={n} i={i} />)}
        </AnimatePresence>
      </Card>
    </div>
  );
}

/* =====================================================================
   APP
   ===================================================================== */
const TABS = {
  admin: [['dash', '📊', 'Analítica'], ['desk', '👂', 'Caja'], ['validate', '🧾', 'Validar'], ['moves', '💳', 'Movimientos'], ['perms', '⚙️', 'Ajustes']],
  trabajador: [['desk', '👂', 'Caja'], ['validate', '🧾', 'Validar'], ['perms', '⚙️', 'Ajustes']],
};
const loadSession = () => { try { return JSON.parse(localStorage.getItem('vp-session')) || null; } catch { return null; } };

export default function App() {
  const [session, setSession] = useState(loadSession);
  const [tab, setTab] = useState(() => (loadSession()?.role === 'admin' ? 'dash' : 'desk'));
  const [notifs, setNotifs] = useState([]);
  const [vals, setVals] = useState([]);
  const [toasts, setToasts] = useState([]);
  const [voiceOn, setVoiceOnState] = useState(() => { try { return localStorage.getItem('vp-voice') === '1'; } catch { return false; } });
  const [installEvt, setInstallEvt] = useState(null);
  const [sharedFile, setSharedFile] = useState(null);
  const [sharedText, setSharedText] = useState('');
  const [live, setLive] = useState(false);
  const voiceRef = useRef(voiceOn);

  const setVoiceOn = (v) => { voiceRef.current = v; setVoiceOnState(v); try { localStorage.setItem('vp-voice', v ? '1' : '0'); } catch { /* */ } };

  const toast = useCallback((msg) => {
    const id = Math.random();
    setToasts((t) => [...t, { id, msg }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);

  const login = (s) => {
    try { localStorage.setItem('vp-session', JSON.stringify(s)); } catch { /* */ }
    setSession(s);
    setTab(s.role === 'admin' ? 'dash' : 'desk');
  };
  const logout = useCallback(async (expired) => {
    const s = loadSession();
    try { localStorage.removeItem('vp-session'); } catch { /* */ }
    setSession(null); setNotifs([]); setVals([]);
    if (expired === true) toast('Tu sesión expiró. Ingresa de nuevo.');
    else if (s?.token) supabase.rpc('app_logout', { p_token: s.token });
  }, [toast]);

  useEffect(() => {
    const onExpired = () => logout(true);
    window.addEventListener('vp-logout', onExpired);
    const onInstall = (e) => { e.preventDefault(); setInstallEvt(e); };
    window.addEventListener('beforeinstallprompt', onInstall);
    // Los navegadores exigen un toque antes de hablar: el primer toque desbloquea la voz
    const unlock = () => { if (voiceRef.current) { try { window.speechSynthesis.speak(new SpeechSynthesisUtterance('')); } catch { /* */ } } };
    window.addEventListener('pointerdown', unlock, { once: true });
    window.speechSynthesis?.getVoices();
    return () => { window.removeEventListener('vp-logout', onExpired); window.removeEventListener('beforeinstallprompt', onInstall); };
  }, [logout]);

  // Contenido compartido desde Android (share target)
  useEffect(() => {
    if (!session || !new URLSearchParams(location.search).has('share')) return;
    (async () => {
      const inbox = await caches.open('share-inbox');
      const img = await inbox.match('/shared/image');
      const txt = await inbox.match('/shared/text');
      if (img) {
        const blob = await img.blob();
        setSharedFile(new File([blob], 'compartido.png', { type: blob.type }));
        setTab('validate');
      } else if (txt && session.role === 'admin') {
        setSharedText(await txt.text());
        setTab('moves');
      }
      await inbox.delete('/shared/image'); await inbox.delete('/shared/text');
      history.replaceState(null, '', location.pathname);
    })();
  }, [session]);

  const announce = useCallback((n) => {
    const text = voiceText(n);
    if (voiceRef.current) speak(text);
    systemNotify(n.direction === 'in' ? `💰 +${fmtCOP(n.amount)}` : `💸 −${fmtCOP(n.amount)}`, text);
    navigator.vibrate?.([200, 100, 200]);
    toast((n.direction === 'in' ? '💰 ' : '💸 ') + text);
  }, [toast]);

  // Sincronización en vivo: consulta cambios cada 4 s (15 s en segundo plano)
  useEffect(() => {
    if (!session) return undefined;
    let cursor = null;
    let first = true;
    let stopped = false;
    let timer;
    const seen = new Set();
    const tick = async () => {
      try {
        const d = await rpc('sync', { p_token: session.token, p_cursor: cursor });
        cursor = new Date(new Date(d.server_time).getTime() - 15000).toISOString();
        const ns = d.notifications || [];
        if (ns.length) setNotifs((p) => mergeById(p, ns, 'occurred_at'));
        if (d.validations?.length) setVals((p) => mergeById(p, d.validations, 'created_at'));
        if (!first) {
          ns.filter((n) => !seen.has(n.id) && Date.now() - new Date(n.created_at).getTime() < 10 * 60000).forEach(announce);
        }
        ns.forEach((n) => seen.add(n.id));
        first = false;
        setLive(true);
      } catch { setLive(false); }
      if (!stopped) timer = setTimeout(tick, document.visibilityState === 'visible' ? 4000 : 15000);
    };
    tick();
    return () => { stopped = true; clearTimeout(timer); };
  }, [session, announce]);

  const consumeFile = useCallback(() => setSharedFile(null), []);
  const consumeText = useCallback(() => setSharedText(''), []);
  const tabs = session ? TABS[session.role] || TABS.trabajador : [];

  return (
    <>
      <style>{CSS}</style>
      <Blobs />
      <div className="toast">
        <AnimatePresence>
          {toasts.map((t) => (
            <motion.div key={t.id} initial={{ opacity: 0, y: -20, scale: 0.95 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -20 }}>{t.msg}</motion.div>
          ))}
        </AnimatePresence>
      </div>

      {!session ? <Login onLogin={login} /> : (
        <div className="wrap">
          <div className="top">
            <div className="brand">
              <motion.div className="logo" whileTap={{ rotate: 360 }} transition={{ duration: 0.6 }}>✓</motion.div>
              <div>Validar Pagos<div className="muted" style={{ fontWeight: 400, fontSize: 12 }}>{live ? '● En vivo' : 'Conectando…'} · {session.display_name}</div></div>
            </div>
            <button className="chip" onClick={() => { setVoiceOn(!voiceOn); if (!voiceOn) speak('Voz activada'); }}>{voiceOn ? '🔊 Voz' : '🔇 Voz'}</button>
          </div>

          <AnimatePresence mode="wait">
            <motion.div key={tab} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -12 }} transition={{ duration: 0.2 }}>
              {tab === 'dash' && session.role === 'admin' && <Dashboard notifs={notifs} vals={vals} />}
              {tab === 'desk' && <LiveDesk notifs={notifs} voiceOn={voiceOn} setVoiceOn={setVoiceOn} live={live} goValidate={() => setTab('validate')} />}
              {tab === 'validate' && <Validator session={session} sharedFile={sharedFile} onConsumed={consumeFile} toast={toast} />}
              {tab === 'moves' && session.role === 'admin' && <Movements session={session} notifs={notifs} toast={toast} sharedText={sharedText} onConsumed={consumeText} />}
              {tab === 'perms' && <Permissions voiceOn={voiceOn} setVoiceOn={setVoiceOn} toast={toast} installEvt={installEvt} session={session} onLogout={logout} />}
            </motion.div>
          </AnimatePresence>

          <nav className="nav">
            {tabs.map(([k, ic, l]) => (
              <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
                {tab === k && <motion.div layoutId="pill" className="pill" transition={{ type: 'spring', stiffness: 400, damping: 30 }} />}
                <span className="ic">{ic}</span>{l}
              </button>
            ))}
          </nav>
        </div>
      )}
    </>
  );
}
