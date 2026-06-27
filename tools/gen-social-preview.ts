#!/usr/bin/env bun
// Generates the GitHub social-preview placards for lllogs.
//
//   bun tools/gen-social-preview.ts
//
// Emits, into .github/ : social-preview{,-light}.svg + .png (1280x640) + @2x.png (2560x1280).
// The SVG is the source of truth; PNGs are rasterized via librsvg's `rsvg-convert`
// (Debian/Ubuntu: `apt install librsvg2-bin`). The 1280x640 PNG is what you upload under
// GitHub → repo Settings → Social preview. See tools/README.md.
//
// Note: the orange sunburst is a recognizable stand-in for the Claude/Anthropic mark, not the
// official trademarked asset. Swap in the real SVG (and mind Anthropic's brand guidelines) if you
// want exact fidelity. librsvg has no text auto-layout, so the wordmark cursor block is positioned
// by a char-advance estimate — nudge it if you change the wordmark or font.

export {}; // ensure module scope (enables top-level await; this file has no imports)

const W = 1280;
const H = 640;
const MONO = "DejaVu Sans Mono, monospace";
const OUT_DIR = ".github";

type Theme = {
  name: string;
  file: string;
  bgTop: string;
  bgBot: string;
  ink: string;
  inkDim: string;
  inkFaint: string;
  orange: string;
  orange2: string;
  cream: string;
  pillBorder: string;
  watermark: string;
  watermarkOpacity: number;
};

const DARK: Theme = {
  name: "dark",
  file: "social-preview",
  bgTop: "#161310",
  bgBot: "#0b0907",
  ink: "#F4EFE6",
  inkDim: "#A89F90",
  inkFaint: "#6E665A",
  orange: "#D97757",
  orange2: "#E8895E",
  cream: "#F4EFE6",
  pillBorder: "#3A332B",
  watermark: "#D97757",
  watermarkOpacity: 0.05,
};

const LIGHT: Theme = {
  name: "light",
  file: "social-preview-light",
  bgTop: "#F2EEE6",
  bgBot: "#E7E1D4",
  ink: "#1C1813",
  inkDim: "#6E6557",
  inkFaint: "#A79D8C",
  orange: "#C8623F",
  orange2: "#D97757",
  cream: "#1C1813",
  pillBorder: "#CDC4B4",
  watermark: "#C8623F",
  watermarkOpacity: 0.06,
};

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Claude starburst (recognizable stand-in mark) — 12 rounded spokes around a center dot.
function starburst(cx: number, cy: number, rOuter: number, fill: string, opacity = 1): string {
  const spikes = 12;
  const rInner = rOuter * 0.16;
  const w = rOuter * 0.21;
  const len = rOuter - rInner;
  let out = `<g opacity="${opacity}">`;
  for (let i = 0; i < spikes; i++) {
    const a = (360 / spikes) * i;
    out +=
      `<rect x="${(cx - w / 2).toFixed(2)}" y="${(cy - rOuter).toFixed(2)}" ` +
      `width="${w.toFixed(2)}" height="${len.toFixed(2)}" rx="${(w / 2).toFixed(2)}" ` +
      `transform="rotate(${a} ${cx} ${cy})" fill="${fill}"/>`;
  }
  out += `<circle cx="${cx}" cy="${cy}" r="${(rOuter * 0.13).toFixed(2)}" fill="${fill}"/>`;
  out += `</g>`;
  return out;
}

type Seg = { t: string; c: string };

// Mock terminal card streaming clogdy-style tool-call log lines (dark in both themes).
function card(t: Theme): string {
  const cx = 664;
  const cy = 132;
  const cw = 552;
  const ch = 392;
  const r = 18;
  const titleH = 46;
  const cardFill = "#1B1814";
  const cardBorder = t.name === "dark" ? "#39322A" : "#2A251F";

  const cTime = "#6E665A";
  const cBash = "#E0905F";
  const cRead = "#7BA7D0";
  const cEdit = "#88B06A";
  const cGrep = "#B58CD0";
  const cPath = "#CDC5B6";
  const cErr = "#E0705C";
  const cAdd = "#7FB069";
  const cDel = "#D2725F";
  const cCorr = "#5A554C";
  const cDim = "#8A8175";

  const lines: { segs: Seg[]; corr: string }[] = [
    { segs: [{ t: "09:24:07  ", c: cTime }, { t: "Bash  ", c: cBash }, { t: "git status -sb", c: cPath }], corr: "#a3f" },
    { segs: [{ t: "09:24:09  ", c: cTime }, { t: "Read  ", c: cRead }, { t: "server/src/app.ts", c: cPath }], corr: "#a3f" },
    { segs: [{ t: "09:24:12  ", c: cTime }, { t: "Edit  ", c: cEdit }, { t: "queries.ts ", c: cPath }, { t: "+18", c: cAdd }, { t: " ", c: cPath }, { t: "-4", c: cDel }], corr: "#b7c" },
    { segs: [{ t: "09:24:18  ", c: cTime }, { t: "Grep  ", c: cGrep }, { t: "\"queryEvents\"", c: cPath }, { t: "  3 files", c: cDim }], corr: "#c1d" },
    { segs: [{ t: "09:24:21  ", c: cTime }, { t: "Bash  ", c: cBash }, { t: "bun test", c: cPath }], corr: "#c1d" },
    { segs: [{ t: "09:24:29  ", c: cTime }, { t: "✗ Bash ", c: cErr }, { t: "bun run check", c: cErr }, { t: "  exit 1", c: cErr }], corr: "#e2a" },
    { segs: [{ t: "09:24:35  ", c: cTime }, { t: "Read  ", c: cRead }, { t: "v2/01-CONTRACTS.md", c: cPath }], corr: "#e2a" },
  ];

  const dotY = cy + 24;
  let out = "";
  out += `<rect x="${cx}" y="${cy}" width="${cw}" height="${ch}" rx="${r}" fill="${cardFill}" stroke="${cardBorder}" stroke-width="1.5" filter="url(#cardShadow)"/>`;
  out += `<line x1="${cx}" y1="${cy + titleH}" x2="${cx + cw}" y2="${cy + titleH}" stroke="${cardBorder}" stroke-width="1"/>`;
  out += `<circle cx="${cx + 26}" cy="${dotY}" r="6.5" fill="#E0705C"/>`;
  out += `<circle cx="${cx + 48}" cy="${dotY}" r="6.5" fill="#E2B45E"/>`;
  out += `<circle cx="${cx + 70}" cy="${dotY}" r="6.5" fill="#7FB069"/>`;
  out += `<text x="${cx + cw / 2}" y="${dotY + 5}" text-anchor="middle" font-family="${MONO}" font-size="16" fill="#8A8175">tail -f  ~/.claude/projects</text>`;

  const lh = 41;
  const startY = cy + titleH + 40;
  const startX = cx + 26;
  const corrX = cx + cw - 26;
  lines.forEach((ln, i) => {
    const y = startY + i * lh;
    out += `<text x="${startX}" y="${y}" font-family="${MONO}" font-size="18" xml:space="preserve">`;
    for (const s of ln.segs) out += `<tspan fill="${s.c}">${esc(s.t)}</tspan>`;
    out += `</text>`;
    out += `<text x="${corrX}" y="${y}" text-anchor="end" font-family="${MONO}" font-size="18" fill="${cCorr}">${ln.corr}</text>`;
  });
  const cursorY = startY + lines.length * lh - 14;
  out += `<rect x="${startX}" y="${cursorY}" width="11" height="22" rx="1.5" fill="${cEdit}"/>`;
  return out;
}

// Provider chips: Claude active; others "soon" — the "Claude today, any LLM tomorrow" story.
function chips(t: Theme, x: number, y: number): string {
  const items = [
    { label: "Claude", active: true },
    { label: "OpenAI", active: false },
    { label: "local LLMs", active: false },
  ];
  const fs = 22;
  const ch = 40;
  const padX = 18;
  const gap = 14;
  const charW = 13.2;
  const dot = 9;
  let cur = x;
  let out = "";
  for (const it of items) {
    const extra = it.active ? dot + 9 : 0;
    const w = it.label.length * charW + padX * 2 + extra;
    const ty = y + ch / 2 + fs * 0.35;
    if (it.active) {
      out += `<rect x="${cur}" y="${y}" width="${w.toFixed(1)}" height="${ch}" rx="${ch / 2}" fill="${t.orange}" fill-opacity="0.16" stroke="${t.orange}" stroke-width="1.5"/>`;
      out += starburst(cur + padX + dot / 2, y + ch / 2, dot, t.orange2);
      out += `<text x="${(cur + padX + dot + 9).toFixed(1)}" y="${ty.toFixed(1)}" font-family="${MONO}" font-size="${fs}" font-weight="bold" fill="${t.orange2}">${it.label}</text>`;
    } else {
      out += `<rect x="${cur}" y="${y}" width="${w.toFixed(1)}" height="${ch}" rx="${ch / 2}" fill="none" stroke="${t.pillBorder}" stroke-width="1.5"/>`;
      out += `<text x="${(cur + padX).toFixed(1)}" y="${ty.toFixed(1)}" font-family="${MONO}" font-size="${fs}" fill="${t.inkFaint}">${it.label}</text>`;
      out += `<text x="${(cur + w + 7).toFixed(1)}" y="${ty.toFixed(1)}" font-family="${MONO}" font-size="13" fill="${t.inkFaint}">soon</text>`;
      cur += 30;
    }
    cur += w + gap;
  }
  return out;
}

function svg(t: Theme): string {
  const lx = 84;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${MONO}">`;
  s += `<defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${t.bgTop}"/>
      <stop offset="1" stop-color="${t.bgBot}"/>
    </linearGradient>
    <filter id="cardShadow" x="-20%" y="-20%" width="140%" height="160%">
      <feDropShadow dx="0" dy="18" stdDeviation="28" flood-color="#000000" flood-opacity="0.45"/>
    </filter>
  </defs>`;
  s += `<rect width="${W}" height="${H}" fill="url(#bg)"/>`;
  s += starburst(150, 600, 360, t.watermark, t.watermarkOpacity);
  s += `<rect x="0" y="0" width="${W}" height="5" fill="${t.orange}"/>`;

  // lockup: starburst + wordmark
  s += starburst(lx + 40, 132, 40, t.orange);
  const wmX = lx + 94;
  const wmBaseline = 160;
  const wmSize = 94;
  s += `<text x="${wmX}" y="${wmBaseline}" font-family="${MONO}" font-size="${wmSize}" font-weight="bold" letter-spacing="-2">`;
  s += `<tspan fill="${t.orange}">lll</tspan><tspan fill="${t.cream}">ogs</tspan>`;
  s += `</text>`;
  const wmW = 6 * wmSize * 0.6 - 2 * 5;
  const curX = wmX + wmW + 4;
  s += `<rect x="${curX.toFixed(0)}" y="${(wmBaseline - wmSize * 0.72).toFixed(0)}" width="${(wmSize * 0.52).toFixed(0)}" height="${(wmSize * 0.74).toFixed(0)}" rx="3" fill="${t.orange}" opacity="0.85"/>`;

  // tagline
  s += `<text x="${lx}" y="262" font-family="${MONO}" font-size="31" fill="${t.ink}" letter-spacing="0.3">Investigate &amp; monitor</text>`;
  s += `<text x="${lx}" y="306" font-family="${MONO}" font-size="31" fill="${t.ink}" letter-spacing="0.3">LLM <tspan fill="${t.orange}">tool usage</tspan>.</text>`;

  s += chips(t, lx, 360);

  s += `<text x="${lx}" y="566" font-family="${MONO}" font-size="20" fill="${t.inkDim}">local-first  ·  parse-once, read-many</text>`;
  s += `<text x="${lx}" y="596" font-family="${MONO}" font-size="20" fill="${t.inkFaint}">SQLite  →  DuckDB  →  React</text>`;

  s += card(t);
  s += `</svg>`;
  return s;
}

async function render(svgPath: string, pngPath: string, w: number, h: number): Promise<void> {
  const proc = Bun.spawn(["rsvg-convert", "-w", String(w), "-h", String(h), svgPath, "-o", pngPath], {
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`rsvg-convert exited ${code} for ${pngPath} (is librsvg2-bin installed?)`);
}

for (const t of [DARK, LIGHT]) {
  const svgPath = `${OUT_DIR}/${t.file}.svg`;
  await Bun.write(svgPath, svg(t));
  await render(svgPath, `${OUT_DIR}/${t.file}.png`, W, H);
  await render(svgPath, `${OUT_DIR}/${t.file}@2x.png`, W * 2, H * 2);
  console.log(`wrote ${svgPath} + .png + @2x.png`);
}
