// shared-supply.js — Lógica compartida de cadena de suministros

window.PRODS  = ["Rojo","Azul","Rosado","Blanco","Amarillo"];
window.COLORS = {"Rojo":"#E24B4A","Azul":"#378ADD","Rosado":"#E89AB9","Blanco":"#888780","Amarillo":"#EFC027"};
window.AGENT_LABEL = {
  YICHANG:"YICHANG", DON_TITO:"DON TITO",
  TOTTUS_TIENDA:"TOTTUS TIENDA", TOTTUS_CD:"TOTTUS CD",
  UNILEVER_PERU:"UNILEVER PERÚ", UNILEVER_MEX:"UNILEVER MEX",
  CETLOG:"CETLOG", COMPRADOR:"COMPRADOR"
};
window.shortProd = function(p){ return p||"—"; };
window.TIMER_MS = 180000;

/* ═══════════════════════════════════════════════════════════
   RELOJ GLOBAL CON PAUSA
   El coordinador escribe control/global = { paused, totalPausedMs, pausedSince }
   Todos los agentes leen ese doc y calculan "tiempo efectivo":
   - Si está en pausa: el reloj se congela en pausedSince - totalPausedMs
   - Si corre: Date.now() - totalPausedMs
   Los deadlines se guardan en ms reales; se comparan contra effectiveNow().
═══════════════════════════════════════════════════════════ */
window.__clock = { paused: false, totalPausedMs: 0, pausedSince: null };

window.effectiveNow = function() {
  const c = window.__clock;
  if (c.paused && c.pausedSince) return c.pausedSince - c.totalPausedMs;
  return Date.now() - (c.totalPausedMs || 0);
};

window.isPaused = function() { return !!window.__clock.paused; };

/* Suscribe el reloj global; onChange se llama en cada cambio (para refrescar UI) */
window.subscribeClock = function(db, fns, onChange) {
  const { doc, onSnapshot, setDoc, getDoc } = fns;
  const ref = doc(db, "control", "global");
  // inicializa SOLO si no existe (no pisar una pausa en curso)
  if (getDoc) {
    getDoc(ref).then(s => {
      if (!s.exists()) setDoc(ref, { paused:false, totalPausedMs:0, pausedSince:null }).catch(()=>{});
    }).catch(()=>{});
  }
  onSnapshot(ref, snap => {
    if (snap.exists()) {
      const d = snap.data();
      window.__clock = {
        paused: !!d.paused,
        totalPausedMs: d.totalPausedMs || 0,
        pausedSince: d.pausedSince || null
      };
    }
    document.body.classList.toggle("sim-paused", window.__clock.paused);
    if (onChange) onChange(window.__clock);
  });
};

/* Acciones del coordinador */
window.pauseSim = async function(db, fns) {
  const { doc, runTransaction } = fns;
  const ref = doc(db, "control", "global");
  await runTransaction(db, async tx => {
    const s = await tx.get(ref);
    const d = s.exists() ? s.data() : { paused:false, totalPausedMs:0 };
    if (d.paused) return;
    tx.set(ref, { paused:true, pausedSince: Date.now(), totalPausedMs: d.totalPausedMs||0 }, { merge:true });
  });
};
window.resumeSim = async function(db, fns) {
  const { doc, runTransaction } = fns;
  const ref = doc(db, "control", "global");
  await runTransaction(db, async tx => {
    const s = await tx.get(ref);
    if (!s.exists()) return;
    const d = s.data();
    if (!d.paused) return;
    const extra = Date.now() - (d.pausedSince || Date.now());
    tx.set(ref, { paused:false, pausedSince:null, totalPausedMs: (d.totalPausedMs||0) + extra }, { merge:true });
  });
};

/* Códigos auto-increment transaccional */
window.getNextCode = async function(db, fns, prefix) {
  const { doc, runTransaction } = fns;
  const ref = doc(db, "contadores", prefix);
  const num = await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.exists() ? (snap.data().numero || 0) : 0;
    const next = current + 1;
    tx.set(ref, { numero: next });
    return next;
  });
  return `${prefix}-${String(num).padStart(3, "0")}`;
};

/* Items remaining vs entregados */
window.itemsRemaining = function(orden, albaranesDeOrden) {
  const accum = {};
  for (const a of albaranesDeOrden) for (const it of (a.items||[])) accum[it.producto] = (accum[it.producto]||0) + it.cantidad;
  return (orden.items||[]).map(it => ({
    producto: it.producto,
    pedido: it.cantidad,
    entregado: accum[it.producto] || 0,
    pendiente: Math.max(0, it.cantidad - (accum[it.producto]||0))
  }));
};
window.itemsAnyDelivered = function(rem) { return rem.some(r => r.entregado > 0); };
window.itemsAllDelivered = function(rem) { return rem.every(r => r.pendiente === 0); };

/* Ordena: órdenes activas primero, cerradas al final; cada grupo por timestamp desc */
window.__sortOrders = function(arr){
  const closed=["recibido","enviado","recibido_tarde","enviado_tarde","cancelado"];
  return arr.slice().sort((a,b)=>{
    const ca=closed.includes(a.estado)?1:0, cb=closed.includes(b.estado)?1:0;
    if(ca!==cb) return ca-cb;
    const ta=a.timestamp?(a.timestamp.toMillis?a.timestamp.toMillis():+new Date(a.timestamp)):0;
    const tb=b.timestamp?(b.timestamp.toMillis?b.timestamp.toMillis():+new Date(b.timestamp)):0;
    return tb-ta;
  });
};

/* Estado computado */
window.computeOrderState = function(orden, albaranes, completedKey="recibido") {
  if (orden.estado === "cancelado") return "cancelado";
  if (["recibido","enviado","recibido_tarde","enviado_tarde"].includes(orden.estado)) return orden.estado;
  const rem = window.itemsRemaining(orden, albaranes);
  const complete = window.itemsAllDelivered(rem);
  const wasOverdue = orden.estado === "atrasado" || (orden.deadlineMs && window.effectiveNow() > orden.deadlineMs);
  if (complete) return wasOverdue ? (completedKey === "enviado" ? "enviado_tarde" : "recibido_tarde") : completedKey;
  if (window.itemsAnyDelivered(rem)) return wasOverdue ? "atrasado" : "parcial";
  return wasOverdue ? "atrasado" : "pendiente";
};

/* Deduce si este albarán completa la orden (entrega lo que faltaba)
   o es parcial (aún queda pendiente después de este albarán).
   orderItems: items de la orden. accumulated: ya entregado antes (sin este albarán).
   deliveringNow: items de este albarán. */
window.deduceTipoEntrega = function(orderItems, accumulated, deliveringNow) {
  const order = {};
  for (const it of orderItems) order[it.producto] = it.cantidad;
  const afterDelivery = {...accumulated};
  for (const it of deliveringNow) afterDelivery[it.producto] = (afterDelivery[it.producto]||0) + it.cantidad;
  // ¿Queda algo pendiente luego de este albarán?
  for (const p in order) {
    if ((afterDelivery[p]||0) < order[p]) return "parcial";
  }
  return "completa";
};

/* Header */
window.renderPenCount = function(count) {
  const el = document.getElementById("penCount");
  if (el) {
    el.querySelector(".penc-val").textContent = count || 0;
    el.classList.toggle("has-pen", (count||0) > 0);
  }
};

window.renderHeader = function(stock, limit, accentColor) {
  const total = window.PRODS.reduce((a,p) => a+(stock[p]||0), 0);
  const pills = document.getElementById("stockPills");
  if (pills) pills.innerHTML = window.PRODS.map(p => {
    const v = stock[p]||0;
    const cls = v===0 ? "empty" : (limit && total/limit > 0.85) ? "low" : "ok";
    return `<div class="sp"><span class="sp-name">${p}</span><span class="sp-val ${cls}" style="color:${window.COLORS[p]}">${v}</span></div>`;
  }).join("");
  const cap = document.getElementById("stockCap");
  if (cap) {
    if (limit) {
      const pct = Math.min(100, Math.round(total/limit*100));
      const free = Math.max(0, limit-total);
      const color = total>=limit ? "#A32D2D" : pct>=85 ? "#EF9F27" : accentColor;
      cap.innerHTML = `<span class="cap-nums" style="color:${color}">${total} / ${limit}</span>
        <div class="cap-bar-wrap"><div class="cap-bar" style="width:${pct}%;background:${color}"></div></div>
        <span class="cap-sub">${pct}% · ${free} libres</span>`;
    } else {
      cap.innerHTML = `<span class="cap-nums" style="color:${accentColor}">${total} uds</span>
        <div class="cap-bar-wrap"><div class="cap-bar" style="width:55%;background:${accentColor};opacity:.6"></div></div>
        <span class="cap-sub">sin límite</span>`;
    }
  }
};

/* Modal genérico */
window.SupplyModal = class {
  constructor(overlayId, rowsContId, alertId) {
    this.overlay = document.getElementById(overlayId);
    this.rowsContId = rowsContId;
    this.alertId = alertId;
    this.rows = [{ producto: window.PRODS[0], cantidad: 1 }];
    this.overlay.addEventListener("click", e => { if(e.target===this.overlay) this.close(); });
  }
  open(fieldDefaults = {}) {
    this.rows = [{ producto: window.PRODS[0], cantidad: 1 }];
    this._render();
    Object.keys(fieldDefaults).forEach(k => {
      const el = document.getElementById(k);
      if (el) el.value = fieldDefaults[k] || "";
    });
    const a = document.getElementById(this.alertId); if(a) a.className = "alert-m";
    this.overlay.classList.add("open");
  }
  close() { this.overlay.classList.remove("open"); }
  setRows(rows) {
    this.rows = rows && rows.length ? rows.map(r=>({producto:r.producto,cantidad:r.cantidad})) : [{producto:window.PRODS[0],cantidad:1}];
    this._render();
  }
  /* Carga los productos del pedido pero con cantidad vacía: el usuario decide cuánto */
  setRowsEmpty(rows) {
    this.rows = rows && rows.length ? rows.map(r=>({producto:r.producto,cantidad:0})) : [{producto:window.PRODS[0],cantidad:0}];
    this._render();
  }
  addRow() { this.rows.push({ producto: window.PRODS[0], cantidad: 0 }); this._render(); }
  removeRow(i) { if (this.rows.length > 1) { this.rows.splice(i, 1); this._render(); } }
  update(i, f, v) { this.rows[i][f] = f === "cantidad" ? (parseInt(v)||0) : v; }
  alert(msg, err) {
    const el = document.getElementById(this.alertId); if(!el) return;
    el.textContent = msg; el.className = "alert-m show" + (err?" error":"");
    setTimeout(() => el.className = "alert-m", 5000);
  }
  getItems() { return this.rows.filter(r => r.cantidad > 0); }
  _render() {
    const id = this.overlay.id;
    const c = document.getElementById(this.rowsContId); if(!c) return;
    c.innerHTML = this.rows.map((r,i)=>`
      <div class="row-m">
        <select onchange="window.__supply_${id}.update(${i},'producto',this.value)">
          ${window.PRODS.map(p=>`<option value="${p}" ${r.producto===p?"selected":""}>${p}</option>`).join("")}
        </select>
        <input type="number" min="0" value="${r.cantidad>0?r.cantidad:''}" placeholder="0"
          oninput="window.__supply_${id}.update(${i},'cantidad',this.value)"/>
        <button class="row-rm-btn" onclick="window.__supply_${id}.removeRow(${i})"
          ${this.rows.length===1?"disabled style='opacity:.25;cursor:default'":""}>×</button>
      </div>`).join("");
  }
};
window.createSupplyModal = function(overlayId, rowsContId, alertId) {
  const m = new window.SupplyModal(overlayId, rowsContId, alertId);
  window[`__supply_${overlayId}`] = m;
  return m;
};

/* Watcher de expiración: el responsable monitorea sus propios pedidos */
/* Watcher de CADENA (para Unilever Perú): la orden de compra entrante se considera
   cumplida cuando el cliente final recibió todo. Si al vencer el deadline NO está
   completada (sigue pendiente o parcial), se penaliza al responsable.
   completedFn(orden) => true si ya está cumplida (recibido por el cliente). */
window.startChainWatcher = function(db, fns, ordenesObservable, miAgente, completedFn) {
  const { doc, runTransaction, collection, addDoc, serverTimestamp } = fns;
  const enProceso = new Set();
  setInterval(async () => {
    if (window.isPaused()) return;
    const now = window.effectiveNow();
    for (const o of ordenesObservable()) {
      if (o.responsable !== miAgente) continue;
      if (!o.deadlineMs || now < o.deadlineMs) continue;
      if (o.penalizada) continue;
      if (completedFn(o)) continue;        // ya se cumplió a tiempo → no penaliza
      if (enProceso.has(o.id)) continue;
      enProceso.add(o.id);
      try {
        let did = false;
        await runTransaction(db, async (tx) => {
          const ref = doc(db, "ordenes", o.id);
          const snap = await tx.get(ref);
          if (!snap.exists()) return;
          const d = snap.data();
          if (!d.penalizada) { tx.update(ref, { penalizada: true }); did = true; }
        });
        if (did) {
          await addDoc(collection(db, "penalizaciones"), {
            empresa: miAgente, motivo: "Cadena incompleta",
            detalle: `${o.codigo}: el pedido no llegó al cliente en 3 min`,
            codigoOrden: o.codigo, timestamp: serverTimestamp()
          });
          window.showToast("⏰", "Tiempo vencido", `${o.codigo}: la cadena no llegó a tiempo`);
        }
      } catch (e) { console.error("Chain watcher", e); }
      finally { enProceso.delete(o.id); }
    }
  }, 1500);
};

window.startExpirationWatcher = function(db, fns, ordenesObservable, miAgente) {
  const { doc, runTransaction, collection, addDoc, serverTimestamp } = fns;
  const enProceso = new Set(); // evita reentrada sobre la misma orden
  setInterval(async () => {
    if (window.isPaused()) return; // congelado: no vence ni penaliza
    const now = window.effectiveNow();
    const ordenes = ordenesObservable();
    for (const o of ordenes) {
      if (o.responsable !== miAgente) continue;
      if (o.estado !== "pendiente") continue;
      if (!o.deadlineMs || now < o.deadlineMs) continue;
      if (enProceso.has(o.id)) continue; // ya lo estamos procesando en este ciclo
      enProceso.add(o.id);
      try {
        // Penalización creada DENTRO de la transacción → atómico, sin duplicados
        let didTransition = false;
        await runTransaction(db, async (tx) => {
          const ref = doc(db, "ordenes", o.id);
          const snap = await tx.get(ref);
          if (!snap.exists()) return;
          const d = snap.data();
          if (d.estado === "pendiente" && !d.penalizada) {
            tx.update(ref, { estado: "atrasado", penalizada: true });
            didTransition = true;
          }
        });
        if (didTransition) {
          await addDoc(collection(db, "penalizaciones"), {
            empresa: miAgente, motivo: "Tiempo vencido",
            detalle: `${o.codigo} no entregada en 3 min`,
            codigoOrden: o.codigo, timestamp: serverTimestamp()
          });
          window.showToast("⏰", "Tiempo vencido", `${o.codigo} venció — penalización aplicada`);
        }
      } catch (e) { console.error("Expiration watcher", e); }
      finally { enProceso.delete(o.id); }
    }
  }, 1500);
};

/* Watcher de completion */
window.startCompletionWatcher = function(db, fns, ordenesObservable, albaranesByCodigoFn, completedKey, expectedTipoAlbaran) {
  const { doc, updateDoc } = fns;
  setInterval(async () => {
    const ordenes = ordenesObservable();
    for (const o of ordenes) {
      if (["recibido","enviado","recibido_tarde","enviado_tarde","cancelado"].includes(o.estado)) continue;
      const albs = albaranesByCodigoFn(o.codigo).filter(a => !expectedTipoAlbaran || a.tipo === expectedTipoAlbaran);
      const rem = window.itemsRemaining(o, albs);
      if (rem.length && rem.every(r => r.pendiente === 0)) {
        const wasOverdue = o.estado === "atrasado" || (o.deadlineMs && window.effectiveNow() > o.deadlineMs);
        const nuevoEstado = wasOverdue
          ? (completedKey === "enviado" ? "enviado_tarde" : "recibido_tarde")
          : completedKey;
        try {
          await updateDoc(doc(db, "ordenes", o.id), { estado: nuevoEstado });
        } catch(e) { console.error("Completion watcher", e); }
      }
    }
  }, 2000);
};

/* Render de tarjeta de orden */
window.renderOrderCard = function(orden, options = {}) {
  const albs = options.albaranes || [];
  const rem = window.itemsRemaining(orden, albs);
  const computedState = window.computeOrderState(orden, albs, options.completedKey||"recibido");
  const stateLabel = {
    pendiente: "Pendiente", parcial: "Parcial", atrasado: "Atrasado",
    recibido: "Recibido", enviado: "Enviado",
    recibido_tarde: "Recibido tarde", enviado_tarde: "Enviado tarde",
    cancelado: "Cancelado"
  }[computedState] || computedState;
  const stateIcon = {
    pendiente: "○", parcial: "◐", atrasado: "!",
    recibido: "✓", enviado: "✓",
    recibido_tarde: "✓", enviado_tarde: "✓", cancelado: "×"
  }[computedState] || "";

  // Barra de progreso por producto — se muestra siempre (desde 0/N), salvo cancelado
  // Si la orden ya está cerrada (enviado/recibido) pero no tiene albaranes (ej: venta
  // instantánea OCLI), mostramos todo como entregado (100%).
  const cerrada = ["recibido","enviado","recibido_tarde","enviado_tarde"].includes(computedState);
  const remDisplay = (cerrada && !window.itemsAnyDelivered(rem))
    ? (orden.items||[]).map(it=>({producto:it.producto,pedido:it.cantidad,entregado:it.cantidad,pendiente:0}))
    : rem;
  let progressHtml = "";
  if (computedState !== "cancelado") {
    const bars = remDisplay.map(r => {
      const pct = r.pedido ? Math.min(100, Math.round(r.entregado/r.pedido*100)) : 0;
      const col = window.COLORS[r.producto] || "#888780";
      const done = r.pendiente === 0;
      return `<div class="oc-pbar-row">
        <span class="oc-pbar-label"><span class="oc-chip-dot" style="background:${col}"></span>${window.shortProd(r.producto)}</span>
        <div class="oc-pbar-track"><div class="oc-pbar-fill" style="width:${pct}%;background:${col}"></div></div>
        <span class="oc-pbar-num ${done?'done':''}">${r.entregado}/${r.pedido}</span>
      </div>`;
    }).join("");
    progressHtml = `<div class="oc-progress-box">${bars}</div>`;
  } else {
    // Para canceladas, mostrar los items pedidos como referencia simple
    progressHtml = (orden.items||[]).map(it => {
      const col = window.COLORS[it.producto] || "#888780";
      return `<span class="oc-chip"><span class="oc-chip-dot" style="background:${col}"></span>${window.shortProd(it.producto)} <b>×${it.cantidad}</b></span>`;
    }).join("");
    progressHtml = `<div class="oc-chips">${progressHtml}</div>`;
  }

  let timerHtml = "";
  if (options.showTimer && ["pendiente","parcial"].includes(computedState)) {
    timerHtml = `<div class="oc-timer" id="tmr-${orden.id}" data-deadline="${orden.deadlineMs||0}" data-accent="${options.accentColor||'#1D9E75'}" style="color:${options.accentColor||'#1D9E75'}">3:00</div>`;
  } else if (computedState === "atrasado" && options.showTimer) {
    timerHtml = `<div class="oc-timer expired">⏱ VENCIDO</div>`;
  }

  let actionsHtml = "";
  if (options.showCancel && ["pendiente","parcial","atrasado"].includes(computedState)) {
    actionsHtml = `<div class="oc-actions"><button class="oc-btn cancel" onclick="${options.onCancel}('${orden.id}','${orden.codigo}')">Cancelar</button></div>`;
  }

  // Metadatos en línea limpia
  const meta = [];
  if (orden.emisor && orden.emisor !== options.viewerId) meta.push(`de ${window.AGENT_LABEL[orden.emisor]||orden.emisor}`);
  if (orden.destino && orden.destino !== options.viewerId) meta.push(`a ${window.AGENT_LABEL[orden.destino]||orden.destino}`);
  if (orden.cliente) meta.push(orden.cliente);
  if (orden.destinoFinal && orden.destinoFinal !== orden.destino && orden.destinoFinal !== options.viewerId) meta.push(`→ ${window.AGENT_LABEL[orden.destinoFinal]||orden.destinoFinal}`);
  const tm = orden.timestamp ? new Date(orden.timestamp.toDate ? orden.timestamp.toDate() : orden.timestamp).toLocaleTimeString("es-PE",{hour:'2-digit',minute:'2-digit'}) : "";
  const refChip = orden.referencia ? `<span class="oc-ref">ref ${orden.referencia}</span>` : "";

  return `<div class="order-card ${computedState}">
    <div class="oc-head">
      <button class="oc-codigo-btn" onclick="window.copyCode('${orden.codigo}',this)" title="Copiar código">
        <span class="oc-codigo-txt">${orden.codigo}</span>
        <span class="oc-copy-ic">⧉</span>
      </button>
      <span class="estado-badge ${computedState}"><span class="eb-ic">${stateIcon}</span>${stateLabel}</span>
    </div>
    ${progressHtml}
    <div class="oc-foot">
      <span class="oc-meta-line">${tm}${meta.length?' · '+meta.join(' · '):''}</span>
      ${refChip}
    </div>
    ${timerHtml}
    ${actionsHtml}
  </div>`;
};

/* Copiar código al portapapeles con feedback visual */
window.copyCode = function(code, btn) {
  navigator.clipboard.writeText(code).then(() => {
    const ic = btn.querySelector(".oc-copy-ic");
    const prev = ic.textContent;
    ic.textContent = "✓";
    btn.classList.add("copied");
    setTimeout(() => { ic.textContent = prev; btn.classList.remove("copied"); }, 1200);
  }).catch(()=>{
    // Fallback
    const ta = document.createElement("textarea");
    ta.value = code; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } catch(e){}
    document.body.removeChild(ta);
    const ic = btn.querySelector(".oc-copy-ic");
    ic.textContent = "✓"; setTimeout(()=>ic.textContent="⧉",1200);
  });
};

/* Updater de timers globales */
window.tickTimers = function() {
  const paused = window.isPaused();
  const now = window.effectiveNow();
  document.querySelectorAll(".oc-timer[data-deadline]").forEach(el => {
    const dl = parseInt(el.dataset.deadline) || 0;
    if (!dl) return;
    if (paused) {
      el.classList.add("paused");
    } else {
      el.classList.remove("paused");
    }
    const rem = dl - now;
    if (rem <= 0) {
      el.textContent = "¡VENCIDO!"; el.className = "oc-timer expired" + (paused?" paused":""); return;
    }
    const m = Math.floor(rem/60000), s = Math.floor((rem%60000)/1000);
    el.textContent = `${m}:${s.toString().padStart(2,"0")}`;
    el.className = "oc-timer" + (rem<60000 ? " warn" : "") + (paused?" paused":"");
    if (rem >= 60000 && !paused) el.style.color = el.dataset.accent;
  });
};
setInterval(window.tickTimers, 500);

/* Notificaciones */
/* Panel de pedidos entrantes UNIFICADO (UM, UP, Tottus CD).
   - Cada tarjeta: código + botón copiar + items como referencia.
   - Botón "Marcar registrado": NO abre modal, solo marca la orden con
     marcadaRegistrada=true (persiste en Firestore) y desactiva la tarjeta.
   - El usuario copia el código y lo pega en el panel izquierdo para actuar.
   opts: { containerId, ordenes, accent, deColor, onMarcar (fnName), origenLabel(o) } */
window.renderIncomingPanel = function(opts){
  const c = document.getElementById(opts.containerId); if(!c) return;
  const arr = window.__sortOrders ? window.__sortOrders(opts.ordenes) : opts.ordenes;
  if(!arr.length){ c.innerHTML = `<p style="font-size:12px;color:#b4b2a9;text-align:center;padding:.5rem;">Sin pedidos entrantes.</p>`; return; }
  c.innerHTML = arr.map(o=>{
    const items=(o.items||[]).map(it=>`${window.shortProd(it.producto)} ×${it.cantidad}`).join(", ");
    const origen = opts.origenLabel ? opts.origenLabel(o) : (window.AGENT_LABEL[o.emisor]||o.emisor);
    if(o.marcadaRegistrada){
      return `<div class="notif-card registrada" style="border-left-color:${opts.accent}">
        <div class="notif-title" style="color:${opts.accent}">✓ ${o.codigo} · registrado</div>
        <div class="notif-detail">${items}<br>De: ${origen}</div>
      </div>`;
    }
    return `<div class="notif-card" style="background:#fff;border-left-color:${opts.accent}">
      <div class="notif-title" style="display:flex;align-items:center;gap:6px;color:${opts.accent}">
        <button class="oc-codigo-btn" style="font-size:11.5px;padding:3px 7px" onclick="window.copyCode('${o.codigo}',this)" title="Copiar código">
          <span class="oc-codigo-txt">${o.codigo}</span><span class="oc-copy-ic">⧉</span>
        </button>
      </div>
      <div class="notif-detail" style="margin-top:6px">${items}<br>De: ${origen}<br><i>Copia el código y regístralo a la izquierda.</i></div>
      <button class="notif-btn" onclick="${opts.onMarcar}('${o.id}')">✓ Marcar registrado</button>
    </div>`;
  }).join("");
};

window.renderNotifPanel = function(containerId, notifs, onRegistrar) {
  const c = document.getElementById(containerId); if(!c) return;
  if (!notifs.length) { c.innerHTML = `<p style="font-size:12px;color:#b4b2a9;text-align:center;padding:.5rem 0;">Sin llegadas.</p>`; return; }
  c.innerHTML = notifs.map(n => {
    const t = n.timestamp ? new Date(n.timestamp.toDate?n.timestamp.toDate():n.timestamp).toLocaleTimeString("es-PE") : "—";
    const items = (n.items||[]).map(it => `${window.shortProd(it.producto)} ×${it.cantidad}`).join(", ");
    const orig = window.AGENT_LABEL[n.origen] || n.origen;
    // Botón de copiar el código contra el cual registrar
    const refBtn = n.codigoOrden
      ? `<div style="margin:6px 0"><span style="font-size:11px;color:#888780">Registrar contra:</span><br>
          <button class="oc-codigo-btn" style="font-size:11.5px;padding:3px 7px;margin-top:3px" onclick="window.copyCode('${n.codigoOrden}',this)" title="Copiar código">
            <span class="oc-codigo-txt">${n.codigoOrden}</span><span class="oc-copy-ic">⧉</span>
          </button></div>`
      : "";
    if (n.estado === "registrada") {
      return `<div class="notif-card registrada">
        <div class="notif-title">✓ Registrado: ${items}</div>
        <div class="notif-detail">${t} · de ${orig}${n.codigoAlbaran?` · ${n.codigoAlbaran}`:""}</div>
      </div>`;
    }
    return `<div class="notif-card">
      <div class="notif-title">● Llegó: ${items}</div>
      <div class="notif-detail">${t} · de ${orig}${n.codigoAlbaran?` · ${n.codigoAlbaran}`:""}</div>
      ${refBtn}
      <div class="notif-detail" style="margin-bottom:6px"><i>Copia el código y pégalo en "Registrar lo recibido".</i></div>
      <button class="notif-btn" onclick="${onRegistrar}('${n.id}')">✓ Ya lo registré</button>
    </div>`;
  }).join("");
};

window.showToast = function(icon, title, body) {
  let c = document.getElementById("toastContainer");
  if (!c) {
    c = document.createElement("div");
    c.id = "toastContainer"; c.className = "toast-container";
    document.body.appendChild(c);
  }
  const t = document.createElement("div"); t.className = "toast";
  t.innerHTML = `<div class="toast-icon">${icon}</div>
    <div style="flex:1"><div class="toast-title">${title}</div><div class="toast-body">${body}</div></div>
    <div class="toast-close" onclick="this.parentElement.remove()">×</div>`;
  c.appendChild(t);
  setTimeout(() => t.remove(), 6000);
};

window.showPenModal = function(motivo, detalle, empresa, hora, total, icon) {
  let overlay = document.getElementById("penModalOverlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "penModalOverlay"; overlay.className = "modal-overlay";
    overlay.innerHTML = `<div class="pen-modal" id="penModalBox"></div>`;
    overlay.addEventListener("click", e => { if(e.target===overlay) overlay.classList.remove("open"); });
    document.body.appendChild(overlay);
  }
  document.getElementById("penModalBox").innerHTML = `
    <div class="pen-modal-top">
      <div class="pen-icon-big">${icon||"⚠️"}</div>
      <div class="pen-modal-title">${motivo}</div>
      <div class="pen-modal-sub">${detalle}</div>
    </div>
    <div class="pen-modal-body">
      <div class="pen-detail-row"><span class="pen-detail-lbl">Empresa</span><span class="pen-detail-val">${empresa}</span></div>
      <div class="pen-detail-row"><span class="pen-detail-lbl">Hora</span><span class="pen-detail-val">${hora}</span></div>
      <div class="pen-detail-row"><span class="pen-detail-lbl">Total penalizaciones</span><span class="pen-detail-val" style="color:#A32D2D">${total}</span></div>
    </div>
    <div class="pen-modal-footer">
      <button class="pen-ok-btn" onclick="document.getElementById('penModalOverlay').classList.remove('open')">Entendido</button>
    </div>`;
  overlay.classList.add("open");
};

window.renderPenList = function(containerId, badgeId, rows, empresaLabel) {
  const c = document.getElementById(containerId);
  const b = document.getElementById(badgeId);
  if (b) b.textContent = rows.length || "0";
  if (!c) return;
  if (!rows.length) { c.innerHTML = '<p style="font-size:13px;color:#b4b2a9;padding:1rem 0;">Sin penalizaciones.</p>'; return; }
  c.innerHTML = rows.map(r => {
    const t = r.timestamp ? new Date(r.timestamp.toDate?r.timestamp.toDate():r.timestamp).toLocaleTimeString("es-PE") : "—";
    const det = (r.detalle||"").replace(/'/g,"&#39;");
    return `<div class="notif-card" style="border-left-color:#A32D2D;background:#fff5f5;cursor:pointer;" onclick="window.showPenModal('${r.motivo}','${det}','${empresaLabel}','${t}',${rows.length},'⏰')">
      <div class="notif-title" style="color:#A32D2D">${r.motivo}</div>
      <div class="notif-detail">${t} · ${det}${r.codigoOrden?` · ${r.codigoOrden}`:""}</div>
    </div>`;
  }).join("");
};

/* Resumen plegable: cuenta órdenes por estado computado.
   opts: { containerId, grupos:[{label, ordenes, completedKey, albaranesFn}] } */
window.renderSummary = function(containerId, grupos){
  const el = document.getElementById(containerId); if(!el) return;
  let totAct=0, totLat=0, totDon=0;
  const closed=["recibido","enviado","recibido_tarde","enviado_tarde"];
  const cards = grupos.map(g=>{
    let act=0, lat=0, don=0;
    for(const o of g.ordenes){
      if(o.estado==="cancelado") continue;
      const albs = g.albaranesFn ? g.albaranesFn(o) : [];
      const st = window.computeOrderState(o, albs, g.completedKey||"recibido");
      if(st==="atrasado"){ lat++; }
      else if(st==="recibido_tarde"||st==="enviado_tarde"){ don++; lat++; }
      else if(closed.includes(st)){ don++; }
      else { act++; }
    }
    totAct+=act; totLat+=lat; totDon+=don;
    return `<div class="summary-stat">
      <div class="ss-num" style="color:var(--c-accent)">${g.ordenes.filter(o=>o.estado!=='cancelado').length}</div>
      <div class="ss-lbl">${g.label}</div>
      <div style="margin-top:6px;display:flex;gap:5px;flex-wrap:wrap">
        ${act?`<span class="summary-chip act">${act} en curso</span>`:''}
        ${don?`<span class="summary-chip don">${don} listas</span>`:''}
        ${lat?`<span class="summary-chip lat">${lat} con atraso</span>`:''}
      </div>
    </div>`;
  }).join("");
  // Actualizar chips del encabezado
  const headChips = document.getElementById(containerId+"-chips");
  if(headChips){
    headChips.innerHTML =
      (totAct?`<span class="summary-chip act">${totAct} en curso</span>`:'') +
      (totLat?`<span class="summary-chip lat">${totLat} con atraso</span>`:'') +
      (!totAct&&!totLat?`<span class="summary-chip don">todo al día</span>`:'');
  }
  el.innerHTML = `<div class="summary-grid">${cards}</div>`;
};
/* Anti-doble-click: bloquea reejecución de una acción mientras está en curso.
   Uso: onclick="window.guard('crearDESP', window.crearDESP)" — pero para simplificar,
   exponemos window.once(key, fn) que ignora llamadas repetidas dentro de 2s. */
window.__busy = {};
window.once = async function(key, fn, btn){
  if (window.__busy[key]) return;          // ya se está ejecutando → ignorar
  window.__busy[key] = true;
  if (btn){ btn.disabled = true; btn.style.opacity = "0.6"; btn.style.cursor = "wait"; }
  try { await fn(); }
  catch(e){ console.error("once("+key+")", e); }
  finally {
    window.__busy[key] = false;
    if (btn){ btn.disabled = false; btn.style.opacity = ""; btn.style.cursor = ""; }
  }
};

window.toggleGuide = function(){
  const b=document.getElementById("guideBox"); if(b) b.classList.toggle("open");
};
window.toggleSummary = function(boxId){
  const b=document.getElementById(boxId); if(b) b.classList.toggle("open");
};

window.switchTabSupply = function(name, el) {
  const root = el.closest(".tabs-supply").parentElement;
  root.querySelectorAll(".tab-supply").forEach(t => t.classList.remove("active"));
  root.querySelectorAll(".tab-content-supply").forEach(t => t.classList.remove("active"));
  el.classList.add("active");
  const target = root.querySelector("#tab-" + name);
  if (target) target.classList.add("active");
};

/* Validación: ¿puedo entregar estos items contra esta orden? */
window.validateDelivery = function(orderItems, deliveredItemsList, accumulatedDelivered) {
  const order = {};
  for (const it of orderItems) order[it.producto] = it.cantidad;
  for (const it of deliveredItemsList) {
    const already = accumulatedDelivered[it.producto] || 0;
    const max = order[it.producto] || 0;
    if (already + it.cantidad > max) {
      return { ok: false, error: `${window.shortProd(it.producto)}: solo quedan ${Math.max(0, max - already)} pendientes (pediste entregar ${it.cantidad}).` };
    }
    if (!order[it.producto]) {
      return { ok: false, error: `${window.shortProd(it.producto)} no figura en la orden.` };
    }
  }
  return { ok: true };
};
