// shared-ui.js — donut chart and multi-product picker helpers

const PRODUCT_COLORS = {
  Rojo:     "#E24B4A",
  Azul:     "#378ADD",
  Rosado:   "#E89AB9",
  Blanco:   "#E5E4DE",
  Amarillo: "#EFC027",
  LIBRE:    "#f5f5f3"
};

window.PRODUCT_COLORS = PRODUCT_COLORS;

// Renders a donut chart showing product distribution + free space
window.renderDonut = function(containerId, stock, productsList, limit, title) {
  const products = productsList || ["Rojo","Azul","Rosado","Blanco","Amarillo"];
  const used = products.reduce((a,p) => a + (stock[p]||0), 0);
  const segments = [];

  for (const p of products) {
    const v = stock[p] || 0;
    if (v > 0) segments.push({ name: p, value: v, color: PRODUCT_COLORS[p] });
  }
  if (limit !== null && limit !== undefined) {
    const free = Math.max(0, limit - used);
    if (free > 0) segments.push({ name: "LIBRE", value: free, color: PRODUCT_COLORS.LIBRE, isFree: true });
  }

  const total = segments.reduce((a,s) => a + s.value, 0);
  if (total === 0) {
    document.getElementById(containerId).innerHTML = `
      <div class="donut-title">${title || "Stock"}</div>
      <svg class="donut-svg" viewBox="0 0 200 200">
        <circle cx="100" cy="100" r="70" fill="none" stroke="#f1efe8" stroke-width="40"/>
        <text x="100" y="105" text-anchor="middle" font-size="14" fill="#888780">Sin stock</text>
      </svg>`;
    return;
  }

  // Build SVG arcs
  const cx = 100, cy = 100, r = 70, sw = 40;
  let cumulative = 0;
  const arcs = segments.map(seg => {
    const startAngle = (cumulative / total) * 2 * Math.PI - Math.PI/2;
    const endAngle = ((cumulative + seg.value) / total) * 2 * Math.PI - Math.PI/2;
    cumulative += seg.value;
    const largeArc = (seg.value / total) > 0.5 ? 1 : 0;
    const x1 = cx + r * Math.cos(startAngle);
    const y1 = cy + r * Math.sin(startAngle);
    const x2 = cx + r * Math.cos(endAngle);
    const y2 = cy + r * Math.sin(endAngle);
    const stroke = seg.isFree ? "#e5e4de" : "none";
    return `<path d="M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2}" fill="none" stroke="${seg.color}" stroke-width="${sw}"/>` +
           (seg.isFree ? `<path d="M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2}" fill="none" stroke="#d3d1c7" stroke-width="1" opacity="0.5"/>` : "");
  }).join("");

  const legend = segments.map(seg => {
    const pct = Math.round((seg.value / total) * 100);
    return `<span class="donut-legend-item"><span class="donut-legend-swatch" style="background:${seg.color};${seg.isFree?'border:1px solid #d3d1c7;':''}"></span>${seg.name} ${pct}%</span>`;
  }).join("");

  const centerLabel = limit ? `${used}/${limit}` : `${used}`;

  document.getElementById(containerId).innerHTML = `
    <div class="donut-title">${title || "Distribución de stock"}</div>
    <svg class="donut-svg" viewBox="0 0 200 200">
      ${arcs}
      <text x="100" y="95" text-anchor="middle" font-size="20" font-weight="500" fill="#1a1a18">${centerLabel}</text>
      <text x="100" y="115" text-anchor="middle" font-size="11" fill="#888780">${limit?'uds totales':'cajas'}</text>
    </svg>
    <div class="donut-legend">${legend}</div>`;
};

// Multi-product picker — manages a list of {producto, cantidad} rows
window.MultiPicker = class {
  constructor(containerId, label, products) {
    this.container = document.getElementById(containerId);
    this.label = label || "Cantidad";
    this.products = products || ["Rojo","Azul","Rosado","Blanco","Amarillo"];
    this.rows = [{producto: this.products[0], cantidad: 1}];
    this.render();
  }

  render() {
    const html = this.rows.map((row, i) => `
      <div class="product-row">
        <select onchange="window.__pickers['${this.containerId()}'].update(${i},'producto',this.value)">
          ${this.products.map(p => `<option value="${p}" ${row.producto===p?'selected':''}>${p}</option>`).join("")}
        </select>
        <input type="number" min="1" value="${row.cantidad}" placeholder="${this.label}"
          oninput="window.__pickers['${this.containerId()}'].update(${i},'cantidad',this.value)"/>
        <button class="remove-btn" onclick="window.__pickers['${this.containerId()}'].remove(${i})" ${this.rows.length===1?'disabled style="opacity:0.3;cursor:not-allowed"':''}>×</button>
      </div>
    `).join("");
    const addBtn = `<button class="add-product-btn" onclick="window.__pickers['${this.containerId()}'].add()">+ Agregar otro producto</button>`;
    this.container.innerHTML = html + addBtn;
  }

  containerId() { return this.container.id; }

  update(i, field, val) {
    if (field === 'cantidad') val = parseInt(val) || 0;
    this.rows[i][field] = val;
  }

  add() {
    this.rows.push({producto: this.products[0], cantidad: 1});
    this.render();
  }

  remove(i) {
    if (this.rows.length === 1) return;
    this.rows.splice(i, 1);
    this.render();
  }

  reset() {
    this.rows = [{producto: this.products[0], cantidad: 1}];
    this.render();
  }

  getValid() {
    return this.rows.filter(r => r.cantidad && r.cantidad > 0);
  }
};

// Registry for picker instances
window.__pickers = {};
window.createPicker = function(containerId, label) {
  const p = new window.MultiPicker(containerId, label);
  window.__pickers[containerId] = p;
  return p;
};
