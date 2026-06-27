// Dependency-free chart helpers. Every data-derived string is set via textContent /
// createTextNode — never innerHTML — so there is no XSS surface.

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * A vertical list of rows, each: label + a proportional horizontal bar + the value.
 * Bar width % = value / max * 100. Pure divs, no SVG.
 */
export function barList(
  items: Array<{ label: string; value: number }>,
  opts?: { max?: number; format?: (n: number) => string },
): HTMLElement {
  const fmt = opts?.format ?? ((n: number) => String(n));
  const max = opts?.max ?? items.reduce((m, it) => Math.max(m, it.value), 0);
  const wrap = document.createElement("div");
  wrap.className = "bar-list";
  for (const it of items) {
    const row = document.createElement("div");
    row.className = "bar-row";

    const label = document.createElement("span");
    label.className = "bar-label";
    label.textContent = it.label;

    const track = document.createElement("div");
    track.className = "bar-track";
    const fill = document.createElement("div");
    fill.className = "bar-fill";
    fill.style.width = (max > 0 ? (it.value / max) * 100 : 0) + "%";
    track.appendChild(fill);

    const val = document.createElement("span");
    val.className = "bar-value";
    val.textContent = fmt(it.value);

    row.append(label, track, val);
    wrap.appendChild(row);
  }
  return wrap;
}

/**
 * A simple SVG bar chart: one <rect> per point, height ∝ y / maxY.
 * Used for timeBuckets.
 */
export function sparkBars(
  points: Array<{ x: number; y: number }>,
  opts?: { width?: number; height?: number },
): SVGSVGElement {
  const height = opts?.height ?? 40;
  const barW = 6;
  const width = opts?.width ?? Math.min(points.length * barW, 600);
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.classList.add("spark");

  const maxY = points.reduce((m, p) => Math.max(m, p.y), 0);
  const step = points.length > 0 ? width / points.length : 0;
  points.forEach((p, i) => {
    const h = maxY > 0 ? (p.y / maxY) * height : 0;
    const rect = document.createElementNS(SVG_NS, "rect");
    rect.setAttribute("x", String(i * step));
    rect.setAttribute("y", String(height - h));
    rect.setAttribute("width", String(Math.max(step - 1, 1)));
    rect.setAttribute("height", String(h));
    rect.setAttribute("fill", "#2a4");
    const title = document.createElementNS(SVG_NS, "title");
    title.textContent = `${new Date(p.x).toLocaleString()}: ${p.y}`;
    rect.appendChild(title);
    svg.appendChild(rect);
  });
  return svg;
}

/**
 * A horizontal bar (0..1) colored by severity, showing the percentage text.
 * For errorRate.
 */
export function gauge(rate: number): HTMLElement {
  const clamped = Math.max(0, Math.min(1, rate));
  const color = clamped < 0.1 ? "#2a4" : clamped < 0.3 ? "#ca3" : "#c44";

  const wrap = document.createElement("div");
  wrap.className = "gauge";

  const track = document.createElement("div");
  track.className = "gauge-track";
  const fill = document.createElement("div");
  fill.className = "gauge-fill";
  fill.style.width = clamped * 100 + "%";
  fill.style.background = color;
  track.appendChild(fill);

  const text = document.createElement("span");
  text.className = "gauge-text";
  text.textContent = (clamped * 100).toFixed(1) + "%";

  wrap.append(track, text);
  return wrap;
}

/** A plain table. Header + body cells are all textContent-escaped. */
export function table(headers: string[], rows: string[][]): HTMLTableElement {
  const t = document.createElement("table");
  t.className = "stats-table";

  const thead = document.createElement("thead");
  const htr = document.createElement("tr");
  for (const h of headers) {
    const th = document.createElement("th");
    th.textContent = h;
    htr.appendChild(th);
  }
  thead.appendChild(htr);
  t.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const r of rows) {
    const tr = document.createElement("tr");
    for (const cell of r) {
      const td = document.createElement("td");
      td.textContent = cell;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  t.appendChild(tbody);
  return t;
}
