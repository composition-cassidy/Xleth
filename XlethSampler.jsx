import { useState, useRef, useEffect } from "react";

// ═══════════════════════════════════════════════════════════════
//  XLETH SAMPLER — Design Mock v1.1
//
//  TOKEN MIGRATION (replace C.xxx before committing to Xleth):
//  C.bg       → var(--theme-bg-primary)
//  C.surface  → var(--theme-bg-surface)
//  C.card     → var(--theme-bg-elevated)
//  C.accent   → var(--theme-accent)
//  C.panel    → var(--theme-panel-pianoroll)
//  C.text     → var(--theme-text)
//  C.muted    → var(--theme-text-muted)
//  C.border   → var(--theme-border-subtle)
//  C.bSt      → var(--theme-border-strong)
// ═══════════════════════════════════════════════════════════════

const C = {
  bg: "#0D0F13", surface: "#16191E", card: "#1E2432",
  accent: "#4AE3D0", panel: "#C44AE3",
  text: "#E4E6EA", muted: "#8A8D93",
  border: "rgba(228,230,234,0.07)", bSt: "rgba(228,230,234,0.15)",
};

const TDIVS = ["1/1","1/2","1/4","1/8","1/16","1/32","1/64"];
const NOTE_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];

// 8 evenly-spaced y-values per cycle — used as catmull-rom control points
const LFO_PRESETS = {
  sine:     [ 0, 0.707, 1, 0.707, 0, -0.707, -1, -0.707 ],
  triangle: [ 0, 0.5, 1, 0.5, 0, -0.5, -1, -0.5 ],
  square:   [ 1, 1, 1, 1, -1, -1, -1, -1 ],
  rampUp:   [ -1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75 ],
  rampDown: [ 1, 0.75, 0.5, 0.25, 0, -0.25, -0.5, -0.75 ],
};

// SVG arc helper — sweep-flag=1 (clockwise). KS=135° = 7-8 o'clock, KW=270°.
function arcPath(cx, cy, r, startDeg, sweepDeg) {
  const rad = (d) => (d * Math.PI) / 180;
  const x1 = cx + r * Math.cos(rad(startDeg)), y1 = cy + r * Math.sin(rad(startDeg));
  const x2 = cx + r * Math.cos(rad(startDeg + sweepDeg)), y2 = cy + r * Math.sin(rad(startDeg + sweepDeg));
  return `M${x1.toFixed(2)},${y1.toFixed(2)} A${r},${r} 0 ${sweepDeg > 180 ? 1 : 0} 1 ${x2.toFixed(2)},${y2.toFixed(2)}`;
}

// Catmull-Rom spline (periodic boundary)
function crom(p0, p1, p2, p3, t) {
  const t2 = t*t, t3 = t2*t;
  return 0.5*((2*p1)+(-p0+p2)*t+(2*p0-5*p1+4*p2-p3)*t2+(-p0+3*p1-3*p2+p3)*t3);
}
function lfoSample(Y, t) {
  const N = Y.length, i = Math.floor(t), f = t - i;
  return crom(Y[((i-1)%N+N)%N], Y[i%N], Y[(i+1)%N], Y[(i+2)%N], f);
}

// ── Knob ──────────────────────────────────────────────────────
const KS = 135, KW = 270;
function Knob({ value=0.5, onChange, label, size=38, color, fmt }) {
  const d = useRef({ on:false, sy:0, sv:0 });
  const ac = color || C.panel;
  const cx = size/2, cy = size/2, r = size/2 - 4;
  const kv = Math.max(0.005, Math.min(0.995, value));
  const ir = ((KS + kv*KW) * Math.PI) / 180;
  const ix = cx + (r-3)*Math.cos(ir), iy = cy + (r-3)*Math.sin(ir);
  const md = (e) => {
    e.preventDefault();
    d.current = { on:true, sy:e.clientY, sv:value };
    const mv = (e) => { if (!d.current.on) return; onChange?.(Math.max(0, Math.min(1, d.current.sv + (d.current.sy - e.clientY)/160))); };
    const mu = () => { d.current.on=false; window.removeEventListener("mousemove",mv); window.removeEventListener("mouseup",mu); };
    window.addEventListener("mousemove",mv); window.addEventListener("mouseup",mu);
  };
  return (
    <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:3, userSelect:"none" }}>
      <svg width={size} height={size} style={{ cursor:"ns-resize" }} onMouseDown={md}>
        <path d={arcPath(cx,cy,r,KS,KW)} fill="none" stroke="#2A3140" strokeWidth={2.5} strokeLinecap="round"/>
        {kv>0.01 && <path d={arcPath(cx,cy,r,KS,kv*KW)} fill="none" stroke={ac} strokeWidth={2.5} strokeLinecap="round"/>}
        <circle cx={cx} cy={cy} r={r-6} fill={C.card}/>
        <line x1={cx} y1={cy} x2={ix} y2={iy} stroke={C.text} strokeWidth={1.5} strokeLinecap="round" opacity={0.8}/>
      </svg>
      {label && <div style={{ fontSize:9, color:C.muted, textTransform:"uppercase", letterSpacing:"0.05em", textAlign:"center" }}>{label}</div>}
      {fmt && <div style={{ fontSize:9, color:C.text, textAlign:"center" }}>{fmt(value)}</div>}
    </div>
  );
}

const SL = ({ children }) => (
  <div style={{ fontSize:9, color:C.muted, textTransform:"uppercase", letterSpacing:"0.1em", fontWeight:600, borderTop:`1px solid ${C.border}`, paddingTop:7, marginBottom:7 }}>{children}</div>
);

function Tabs({ tabs, active, onSelect, sm }) {
  return (
    <div style={{ display:"flex", borderBottom:`1px solid ${C.border}` }}>
      {tabs.map((t) => (
        <div key={t.id} onClick={() => onSelect(t.id)} style={{
          padding: sm ? "4px 10px" : "6px 14px", fontSize: sm?10:11, fontWeight:600,
          textTransform:"uppercase", letterSpacing:"0.07em",
          color: active===t.id ? C.text : C.muted,
          borderBottom: active===t.id ? `2px solid ${C.accent}` : "2px solid transparent",
          marginBottom:-1, cursor:"pointer", userSelect:"none",
        }}>{t.label}</div>
      ))}
    </div>
  );
}

function Seg({ opts, val, set, sm }) {
  return (
    <div style={{ display:"flex", background:C.bg, border:`1px solid ${C.bSt}`, borderRadius:3, overflow:"hidden" }}>
      {opts.map((o) => (
        <div key={o.v} onClick={() => set(o.v)} style={{
          padding: sm ? "3px 7px" : "5px 12px", fontSize: sm?9:10, fontWeight:700,
          textTransform:"uppercase", letterSpacing:"0.05em",
          background: val===o.v ? C.accent : "transparent",
          color: val===o.v ? C.bg : C.muted,
          cursor:"pointer", userSelect:"none", whiteSpace:"nowrap",
        }}>{o.l}</div>
      ))}
    </div>
  );
}

const Pill = ({ label, on, toggle }) => (
  <div onClick={toggle} style={{
    padding:"4px 10px", fontSize:10, fontWeight:600, textTransform:"uppercase", letterSpacing:"0.04em",
    border:`1px solid ${on ? C.accent : C.bSt}`, background: on ? "rgba(74,227,208,0.1)" : "transparent",
    color: on ? C.accent : C.muted, borderRadius:3, cursor:"pointer", userSelect:"none", whiteSpace:"nowrap",
  }}>{label}</div>
);

const Chk = ({ val, set, label }) => (
  <label style={{ display:"flex", alignItems:"center", gap:5, cursor:"pointer", userSelect:"none" }}>
    <input type="checkbox" checked={val} onChange={(e) => set(e.target.checked)} style={{ accentColor:C.accent, cursor:"pointer" }}/>
    <span style={{ fontSize:9, color:C.muted, textTransform:"uppercase", letterSpacing:"0.06em" }}>{label}</span>
  </label>
);

const Sel = ({ val, set, opts }) => (
  <select value={val} onChange={(e) => set(e.target.value)}
    style={{ background:C.card, border:`1px solid ${C.bSt}`, color:C.text, fontSize:10, padding:"3px 6px", borderRadius:3, outline:"none", cursor:"pointer" }}>
    {opts.map((o) => <option key={o} value={o}>{o}</option>)}
  </select>
);

// ── Waveform canvas ───────────────────────────────────────────
// Loop region: teal border-box overlay. Crossfade X: two diagonals at loopE boundary.
function WaveCanvas({ loopS, loopE, xf }) {
  const ref = useRef(null);
  useEffect(() => {
    const cv = ref.current; if (!cv) return;
    const W = 800, H = 128; cv.width = W; cv.height = H;
    const ctx = cv.getContext("2d");
    ctx.fillStyle = C.bg; ctx.fillRect(0,0,W,H);

    // Waveform
    ctx.beginPath(); ctx.strokeStyle = C.panel; ctx.lineWidth = 1.5;
    for (let i = 0; i <= W; i++) {
      const t = i/W;
      const decay = Math.exp(-t*2.8)*0.8 + Math.exp(-t*0.4)*0.2;
      const sig = Math.sin(t*420 + Math.sin(t*7)*0.5)*0.65 + Math.sin(t*160)*0.22 + Math.sin(t*290)*0.13;
      const y = H/2 - sig*decay*H*0.44;
      i===0 ? ctx.moveTo(i,y) : ctx.lineTo(i,y);
    }
    ctx.stroke();

    // Loop region fill
    const lx = loopS*W, lw = (loopE-loopS)*W;
    ctx.fillStyle = "rgba(74,227,208,0.06)";
    ctx.fillRect(lx, 0, lw, H);

    // Loop region border
    ctx.strokeStyle = "rgba(74,227,208,0.5)";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(lx + 0.75, 0.75, lw - 1.5, H - 1.5);

    // Crossfade X — two diagonals centered on loopE vertical
    // Width scales with xf knob; always at least 30px for visibility
    const xfPx = Math.max(30, xf * 200);
    const xc = loopE * W;
    ctx.strokeStyle = "rgba(196,74,227,0.85)";
    ctx.lineWidth = 1.5;
    // Incoming (fading in): rises left→right
    ctx.beginPath(); ctx.moveTo(xc - xfPx, H*0.82); ctx.lineTo(xc + xfPx, H*0.18); ctx.stroke();
    // Outgoing (fading out): falls left→right
    ctx.beginPath(); ctx.moveTo(xc - xfPx, H*0.18); ctx.lineTo(xc + xfPx, H*0.82); ctx.stroke();

    // Loop boundary ticks
    ctx.strokeStyle = "rgba(74,227,208,0.55)"; ctx.lineWidth = 1; ctx.setLineDash([3,3]);
    [loopS*W, loopE*W].forEach((x) => { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke(); });
    ctx.setLineDash([]);
  }, [loopS, loopE, xf]);
  return <canvas ref={ref} style={{ width:"100%", height:128, display:"block" }}/>;
}

// ── ADSR canvas ───────────────────────────────────────────────
function ADSRCanvas({ atk, hld, dec, sus, rel, aT, dT, rT }) {
  const ref = useRef(null);
  useEffect(() => {
    const cv = ref.current; if (!cv) return;
    const W = 600, H = 118; cv.width = W; cv.height = H;
    const ctx = cv.getContext("2d");
    ctx.fillStyle = C.bg; ctx.fillRect(0,0,W,H);
    ctx.strokeStyle = C.border; ctx.lineWidth = 1;
    [0.25,0.5,0.75].forEach((f) => { ctx.beginPath(); ctx.moveTo(0,H*f); ctx.lineTo(W,H*f); ctx.stroke(); });
    const p=10, aw=atk*0.35, hw=hld*0.12, dw=dec*0.22, sw=0.08, rw=rel*0.28;
    const sc = (W-p*2)/(aw+hw+dw+sw+rw);
    const tx=(t)=>p+t*sc, ty=(v)=>p+(1-v)*(H-p*2);
    let t=0;
    const pts=[[t,0]]; t+=aw; pts.push([t,1]); t+=hw; pts.push([t,1]); t+=dw; pts.push([t,sus]); t+=sw; pts.push([t,sus]); t+=rw; pts.push([t,0]);
    const curve=()=>{
      ctx.moveTo(tx(pts[0][0]),ty(0));
      ctx.bezierCurveTo(tx(pts[0][0]+aw*aT),ty(0),tx(pts[1][0]-aw*(1-aT)),ty(1),tx(pts[1][0]),ty(1));
      ctx.lineTo(tx(pts[2][0]),ty(1));
      ctx.bezierCurveTo(tx(pts[2][0]+dw*dT),ty(1),tx(pts[3][0]-dw*(1-dT)),ty(sus),tx(pts[3][0]),ty(sus));
      ctx.lineTo(tx(pts[4][0]),ty(sus));
      ctx.bezierCurveTo(tx(pts[4][0]+rw*rT),ty(sus),tx(pts[5][0]-rw*(1-rT)),ty(0),tx(pts[5][0]),ty(0));
    };
    ctx.beginPath(); curve(); ctx.lineTo(tx(pts[5][0]),ty(0)); ctx.closePath();
    const g=ctx.createLinearGradient(0,0,0,H); g.addColorStop(0,"rgba(196,74,227,0.22)"); g.addColorStop(1,"rgba(196,74,227,0.01)");
    ctx.fillStyle=g; ctx.fill();
    ctx.beginPath(); curve(); ctx.strokeStyle=C.panel; ctx.lineWidth=1.5; ctx.stroke();
  }, [atk,hld,dec,sus,rel,aT,dT,rT]);
  return <canvas ref={ref} style={{ width:"100%", height:118, display:"block" }}/>;
}

// ── LFO canvas — editable catmull-rom points ──────────────────
// Shows 2 cycles. First cycle: 8 draggable handles. Second cycle: read-only preview.
const LFO_N=8, LFO_CW=400, LFO_CH=80, LFO_AMP=28, LFO_CYCS=2, LFO_PTW=LFO_CW/LFO_CYCS;

function LFOCanvas({ lfoY, onDrag }) {
  const ref = useRef(null);
  const drag = useRef({ on:false, idx:-1 });

  useEffect(() => {
    const cv = ref.current; if (!cv) return;
    cv.width = LFO_CW; cv.height = LFO_CH;
    const ctx = cv.getContext("2d");
    ctx.fillStyle = C.bg; ctx.fillRect(0,0,LFO_CW,LFO_CH);

    // Center line
    ctx.strokeStyle = C.border; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(0,LFO_CH/2); ctx.lineTo(LFO_CW,LFO_CH/2); ctx.stroke();

    // Gradient fill under curve
    ctx.beginPath();
    for (let px=0; px<=LFO_CW; px++) {
      const t=(px/LFO_CW)*LFO_N*LFO_CYCS;
      const y=lfoSample(lfoY,t);
      const cy=LFO_CH/2 - y*LFO_AMP;
      px===0 ? ctx.moveTo(px,cy) : ctx.lineTo(px,cy);
    }
    ctx.lineTo(LFO_CW,LFO_CH/2); ctx.lineTo(0,LFO_CH/2); ctx.closePath();
    const g=ctx.createLinearGradient(0,0,0,LFO_CH);
    g.addColorStop(0,"rgba(196,74,227,0.18)"); g.addColorStop(1,"rgba(196,74,227,0.01)");
    ctx.fillStyle=g; ctx.fill();

    // Curve stroke
    ctx.beginPath(); ctx.strokeStyle=C.panel; ctx.lineWidth=1.5;
    for (let px=0; px<=LFO_CW; px++) {
      const t=(px/LFO_CW)*LFO_N*LFO_CYCS;
      const y=lfoSample(lfoY,t);
      const cy=LFO_CH/2 - y*LFO_AMP;
      px===0 ? ctx.moveTo(px,cy) : ctx.lineTo(px,cy);
    }
    ctx.stroke();

    // Cycle separator
    ctx.strokeStyle="rgba(228,230,234,0.1)"; ctx.lineWidth=1; ctx.setLineDash([2,2]);
    ctx.beginPath(); ctx.moveTo(LFO_PTW,0); ctx.lineTo(LFO_PTW,LFO_CH); ctx.stroke();
    ctx.setLineDash([]);

    // Draggable handles — first cycle only
    for (let i=0; i<LFO_N; i++) {
      const px=(i/LFO_N)*LFO_PTW;
      const py=LFO_CH/2 - lfoY[i]*LFO_AMP;
      ctx.beginPath(); ctx.arc(px,py,4,0,Math.PI*2);
      ctx.fillStyle=C.card; ctx.fill();
      ctx.strokeStyle=C.panel; ctx.lineWidth=1.5; ctx.stroke();
    }
  }, [lfoY]);

  const onMouseDown = (e) => {
    const cv = ref.current; if (!cv) return;
    e.preventDefault();
    const rect = cv.getBoundingClientRect();
    const mx = (e.clientX-rect.left)*(LFO_CW/rect.width);
    const my = (e.clientY-rect.top)*(LFO_CH/rect.height);
    for (let i=0; i<LFO_N; i++) {
      const px=(i/LFO_N)*LFO_PTW, py=LFO_CH/2 - lfoY[i]*LFO_AMP;
      if (Math.hypot(mx-px,my-py) < 10) {
        drag.current = { on:true, idx:i };
        const onMove=(e)=>{
          if (!drag.current.on) return;
          const r2=cv.getBoundingClientRect();
          const my2=(e.clientY-r2.top)*(LFO_CH/r2.height);
          onDrag(drag.current.idx, Math.max(-1,Math.min(1,-(my2-LFO_CH/2)/LFO_AMP)));
        };
        const onUp=()=>{ drag.current.on=false; window.removeEventListener("mousemove",onMove); window.removeEventListener("mouseup",onUp); };
        window.addEventListener("mousemove",onMove); window.addEventListener("mouseup",onUp);
        break;
      }
    }
  };

  return <canvas ref={ref} onMouseDown={onMouseDown} style={{ width:"100%", height:LFO_CH, display:"block", cursor:"crosshair" }}/>;
}

// ── LFO shape preset icons ────────────────────────────────────
const SHP = {
  sine:     <path d="M1,7 Q4,1 7,7 Q10,13 13,7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>,
  triangle: <path d="M1,9 L5,2 L9,9 L13,2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>,
  square:   <path d="M1,9 L1,3 L7,3 L7,9 L13,9 L13,3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>,
  rampUp:   <path d="M2,10 L9,2 M9,2 L9,10 M11,10 L13,10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>,
  rampDown: <path d="M2,2 L2,10 L9,2 M11,10 L13,10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>,
};

const ADSVG = {
  up:     <path d="M7,11 L7,4 M4,7 L7,4 L10,7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>,
  down:   <path d="M7,4 L7,11 M4,8 L7,11 L10,8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>,
  updown: <path d="M7,2 L7,13 M4,5 L7,2 L10,5 M4,10 L7,13 L10,10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>,
  sticky: <path d="M4,3 L7,1 L10,3 M7,1 L7,7 M4,12 L7,14 L10,12 M7,14 L7,8 M5,7.5 L9,7.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>,
};

// ════════════════════════════════════════════════════════════════
export default function XlethSampler() {
  const [tab, setTab] = useState("sample");
  const [envTab, setEnvTab] = useState("env");
  const [lfoTab, setLfoTab] = useState("vol");
  const [voice, setVoice] = useState("poly");
  const [porta, setPorta] = useState(0);
  const [arpOn, setArpOn] = useState(false);
  const [arpRange, setArpRange] = useState(1);
  const [arpDir, setArpDir] = useState("up");
  const [arpSync, setArpSync] = useState(true);
  const [arpDiv, setArpDiv] = useState("1/8");
  const [arpMs, setArpMs] = useState(0.5);
  const [loopOn, setLoopOn] = useState(true);
  const [mode, setMode] = useState("sustained");
  const [rootNote, setRootNote] = useState(60);
  const [pre, setPre] = useState({ dc:false, norm:false, rp:false, rev:false });
  const [lfoY, setLfoY] = useState([...LFO_PRESETS.sine]);
  const [lfoPreset, setLfoPreset] = useState("sine");
  const [lfoSync, setLfoSync] = useState(false);
  const [lfoDiv, setLfoDiv] = useState("1/4");

  const [k, setK] = useState({
    ss:0, len:1, fi:0.1, fo:0.12, xf:0.22, ls:0.28, le:0.75,
    atk:0.05, hld:0, dec:0.4, sus:0.7, rel:0.3,
    aT:0.5, dT:0.5, rT:0.5,
    lDel:0, lAtt:0, lAmt:0.3, lSpd:0.5, pit:0.5,
  });
  const sk = (key, v) => setK((p) => ({ ...p, [key]: v }));
  const nn = `${NOTE_NAMES[rootNote%12]}${Math.floor(rootNote/12)-1}`;

  const applyPreset = (id) => { setLfoY([...LFO_PRESETS[id]]); setLfoPreset(id); };
  const onLfoDrag = (idx, y) => { setLfoY((p) => { const n=[...p]; n[idx]=y; return n; }); setLfoPreset(null); };

  const row={display:"flex",alignItems:"center",gap:8};
  const col={display:"flex",flexDirection:"column"};
  const lbl={fontSize:9,color:C.muted,textTransform:"uppercase",letterSpacing:"0.06em"};
  const card={background:C.surface,border:`1px solid ${C.bSt}`,borderRadius:4,padding:12};

  const renderSample = () => (
    <div style={{...col,gap:12}}>
      <div style={{border:`1px solid ${C.bSt}`,borderRadius:4,overflow:"hidden"}}>
        <WaveCanvas loopS={k.ls} loopE={k.le} xf={k.xf}/>
      </div>
      <div style={{display:"flex",justifyContent:"space-around",padding:"0 8px"}}>
        {[
          ["ss","Smp Start",(v)=>`${Math.round(v*100)}%`],
          ["len","Length",()=>"FULL"],
          ["fi","In",(v)=>`${Math.round(v*500)}ms`],
          ["fo","Out",(v)=>`${Math.round(v*500)}ms`],
          ["xf","XFade",(v)=>`${Math.round(v*500)}ms`],
          ["ls","Loop Start",(v)=>Math.round(v*16000)],
          ["le","Loop End",(v)=>Math.round(v*16000)],
        ].map(([key,label,fmt])=>(
          <Knob key={key} value={k[key]} onChange={(v)=>sk(key,v)} label={label} size={42} fmt={fmt}/>
        ))}
      </div>
      <div style={{...row,flexWrap:"wrap",gap:16,padding:"0 4px"}}>
        <div style={row}>
          <span style={lbl}>Root Note</span>
          <input type="number" value={rootNote} min={0} max={127}
            onChange={(e)=>setRootNote(Math.max(0,Math.min(127,parseInt(e.target.value)||0)))}
            style={{background:C.card,border:`1px solid ${C.bSt}`,color:C.text,fontSize:10,padding:"3px 6px",borderRadius:3,width:40,textAlign:"center",outline:"none"}}/>
          <span style={{fontSize:10,color:C.muted}}>{nn}</span>
        </div>
        <div style={row}>
          <span style={lbl}>Mode</span>
          {["oneshot","sustained"].map((m)=>(
            <label key={m} style={{...row,gap:4,cursor:"pointer"}}>
              <input type="radio" checked={mode===m} onChange={()=>setMode(m)} style={{accentColor:C.accent}}/>
              <span style={{fontSize:10,color:mode===m?C.text:C.muted}}>{m==="oneshot"?"One-shot":"Sustained"}</span>
            </label>
          ))}
        </div>
        <Chk val={loopOn} set={setLoopOn} label="Loop"/>
      </div>
      <div>
        <SL>Precomputed Effects</SL>
        <div style={{...row,flexWrap:"wrap",gap:6}}>
          <Pill label="Remove DC Offset" on={pre.dc}   toggle={()=>setPre((p)=>({...p,dc:!p.dc}))}/>
          <Pill label="Normalize"        on={pre.norm} toggle={()=>setPre((p)=>({...p,norm:!p.norm}))}/>
          <Pill label="Reverse Polarity" on={pre.rp}   toggle={()=>setPre((p)=>({...p,rp:!p.rp}))}/>
          <Pill label="Reverse"          on={pre.rev}  toggle={()=>setPre((p)=>({...p,rev:!p.rev}))}/>
        </div>
      </div>
    </div>
  );

  const renderPlayback = () => (
    <div style={{...col,gap:12}}>
      <div style={{display:"flex",gap:12}}>
        {/* Voice + Portamento (no label below knob) */}
        <div style={{...card,...col,gap:12,alignItems:"center",minWidth:148}}>
          <Seg opts={[{v:"mono",l:"Mono"},{v:"poly",l:"Poly"}]} val={voice} set={setVoice}/>
          <Knob value={porta} onChange={setPorta} label="Porta Time" size={48} color={porta>0?C.panel:C.muted}/>
        </div>

        {/* Arpeggiator */}
        <div style={{...card,flex:1}}>
          <div style={{...row,justifyContent:"space-between",marginBottom:10}}>
            <span style={{fontSize:10,fontWeight:700,color:C.text,textTransform:"uppercase",letterSpacing:"0.1em"}}>Arpeggiator</span>
            <input type="checkbox" checked={arpOn} onChange={(e)=>setArpOn(e.target.checked)} style={{accentColor:C.accent,cursor:"pointer"}}/>
          </div>
          <div style={{opacity:arpOn?1:0.3,...col,gap:8,pointerEvents:arpOn?"auto":"none"}}>
            <div style={row}>
              <span style={{...lbl,width:62}}>Range</span>
              <Seg sm opts={[1,2,3,4].map((n)=>({v:n,l:`${n} Oct`}))} val={arpRange} set={setArpRange}/>
            </div>
            <div style={row}>
              <span style={{...lbl,width:62}}>Direction</span>
              <div style={{display:"flex",gap:2}}>
                {["up","down","updown","sticky"].map((id)=>(
                  <div key={id} onClick={()=>setArpDir(id)}
                    title={{up:"Up",down:"Down",updown:"Up + Down",sticky:"Sticky"}[id]}
                    style={{
                      width:28,height:26,display:"flex",alignItems:"center",justifyContent:"center",
                      background:arpDir===id?C.accent:C.card, color:arpDir===id?C.bg:C.muted,
                      border:`1px solid ${arpDir===id?C.accent:C.border}`,
                      borderRadius:3,cursor:"pointer",
                    }}>
                    <svg width={14} height={15} viewBox="0 0 14 15">{ADSVG[id]}</svg>
                  </div>
                ))}
              </div>
            </div>
            <div style={row}>
              <span style={{...lbl,width:62}}>Time</span>
              {arpSync ? <Sel val={arpDiv} set={setArpDiv} opts={TDIVS}/> : <Knob value={arpMs} onChange={setArpMs} size={26}/>}
              <Chk val={arpSync} set={setArpSync} label="Tempo Sync"/>
            </div>
          </div>
        </div>
      </div>

      {/* Envelope + LFO */}
      <div style={card}>
        <Tabs tabs={[{id:"env",label:"Env"},{id:"pitch",label:"Pitch"}]} active={envTab} onSelect={setEnvTab} sm/>
        <div style={{marginTop:10}}>
          {envTab==="env" ? (
            <div style={{...col,gap:12}}>
              <div style={{display:"flex",gap:14,alignItems:"flex-start"}}>
                <div style={{flex:1,border:`1px solid ${C.border}`,borderRadius:3,overflow:"hidden"}}>
                  <ADSRCanvas atk={k.atk*0.6+0.01} hld={k.hld*0.3} dec={k.dec*0.6+0.05} sus={k.sus} rel={k.rel*0.6+0.05} aT={k.aT} dT={k.dT} rT={k.rT}/>
                </div>
                <div style={{...col,gap:8}}>
                  <div style={{display:"flex",gap:5}}>
                    {[["atk","ATK"],["hld","HLD"],["dec","DEC"],["sus","SUS"],["rel","REL"]].map(([kk,ll])=>(
                      <Knob key={kk} value={k[kk]} onChange={(v)=>sk(kk,v)} label={ll} size={36}/>
                    ))}
                  </div>
                  <div style={{display:"flex",gap:5,alignItems:"flex-end"}}>
                    {[["aT","ATK T"],["dT","DEC T"],["rT","REL T"]].map(([kk,ll])=>(
                      <Knob key={kk} value={k[kk]} onChange={(v)=>sk(kk,v)} label={ll} size={28} color={C.accent}/>
                    ))}
                    <div style={{...col,justifyContent:"flex-end",paddingBottom:10}}>
                      <span style={{...lbl,fontSize:8}}>Tension</span>
                    </div>
                  </div>
                </div>
              </div>

              <div>
                <SL>LFO</SL>
                <Tabs tabs={[{id:"vol",label:"Vol LFO"},{id:"pan",label:"Pan LFO"},{id:"pitch",label:"Pitch LFO"}]} active={lfoTab} onSelect={setLfoTab} sm/>
                <div style={{marginTop:8,display:"flex",gap:14,alignItems:"flex-start"}}>
                  <div style={{flex:1,...col,gap:6}}>
                    {/* Preset buttons */}
                    <div style={{...row,gap:4}}>
                      <span style={{...lbl,marginRight:2}}>Preset</span>
                      {Object.keys(SHP).map((id)=>(
                        <div key={id} onClick={()=>applyPreset(id)}
                          title={{sine:"Sine",triangle:"Triangle",square:"Square",rampUp:"Ramp Up",rampDown:"Ramp Down"}[id]}
                          style={{
                            width:28,height:24,display:"flex",alignItems:"center",justifyContent:"center",
                            background:lfoPreset===id?C.panel:C.card,
                            color:lfoPreset===id?"#fff":C.muted,
                            border:`1px solid ${lfoPreset===id?C.panel:C.border}`,
                            borderRadius:3,cursor:"pointer",
                          }}>
                          <svg width={14} height={14} viewBox="0 0 14 14">{SHP[id]}</svg>
                        </div>
                      ))}
                      {lfoPreset===null && <span style={{...lbl,color:C.accent,marginLeft:4}}>Custom</span>}
                    </div>
                    {/* Editable canvas */}
                    <div style={{border:`1px solid ${C.border}`,borderRadius:3,overflow:"hidden"}}>
                      <LFOCanvas lfoY={lfoY} onDrag={onLfoDrag}/>
                    </div>
                    <div style={{fontSize:9,color:C.muted}}>Drag points to edit · Click preset to reset</div>
                  </div>
                  <div style={{...col,gap:8}}>
                    <div style={{display:"flex",gap:5}}>
                      {[["lDel","Del"],["lAtt","Att"],["lAmt","Amt"],["lSpd","Speed"]].map(([kk,ll])=>(
                        <Knob key={kk} value={k[kk]} onChange={(v)=>sk(kk,v)} label={ll} size={34}/>
                      ))}
                    </div>
                    <div style={row}>
                      <Chk val={lfoSync} set={setLfoSync} label="Tempo Sync"/>
                      {lfoSync && <Sel val={lfoDiv} set={setLfoDiv} opts={TDIVS}/>}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div style={{...col,alignItems:"center",padding:"24px 0",gap:8}}>
              <Knob value={k.pit} onChange={(v)=>sk("pit",v)} label="Pitch" size={72} color={C.accent}/>
              <div style={{fontSize:13,fontWeight:600,color:C.text}}>{Math.round((k.pit-0.5)*72)} st</div>
              <div style={{fontSize:9,color:C.muted}}>±36 semitones</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <div style={{background:C.bg,minHeight:"100vh",padding:12,fontFamily:"'Segoe UI',system-ui,sans-serif"}}>
      <div style={{background:C.surface,border:`1px solid ${C.bSt}`,borderRadius:6,overflow:"hidden",maxWidth:900,margin:"0 auto"}}>
        <div style={{display:"flex",alignItems:"center",gap:8,padding:"7px 12px",background:C.card,borderBottom:`1px solid ${C.border}`}}>
          <div style={{width:3,height:14,background:C.panel,borderRadius:2}}/>
          <span style={{fontSize:10,fontWeight:700,letterSpacing:"0.14em",textTransform:"uppercase",color:C.muted}}>Xleth Sampler</span>
        </div>
        <div style={{padding:"0 12px",background:C.card,borderBottom:`1px solid ${C.border}`}}>
          <Tabs tabs={[{id:"sample",label:"Sample"},{id:"playback",label:"Playback"}]} active={tab} onSelect={setTab}/>
        </div>
        <div style={{padding:12}}>
          {tab==="sample" ? renderSample() : renderPlayback()}
        </div>
      </div>
    </div>
  );
}
