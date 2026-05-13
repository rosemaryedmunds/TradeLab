// Pure-SVG chart helpers. No external libraries.

export const fmtUsd = (n, { signed = false, compact = false } = {}) => {
  if (n == null || Number.isNaN(n)) return '—';
  const v = Math.abs(n);
  let s;
  if (compact && v >= 1000) s = '$' + (n / 1000).toFixed(1) + 'k';
  else s = '$' + Math.round(n).toLocaleString();
  if (signed && n > 0) s = '+' + s;
  if (signed && n < 0) s = '−' + s.replace('-', '');
  if (!signed && n < 0) s = '−' + s.replace('-', '');
  return s;
};

export const fmtPct = (n, { signed = false, digits = 1 } = {}) => {
  if (n == null || Number.isNaN(n)) return '—';
  const s = (Math.abs(n) * (Math.abs(n) > 1 ? 1 : 100)).toFixed(digits) + '%';
  return (signed && n > 0 ? '+' : n < 0 ? '−' : '') + s;
};

export const fmtTime = (iso) => {
  if (!iso) return '—';
  const m = iso.match(/T(\d{2}):(\d{2})/);
  if (!m) return iso.slice(11, 16);
  return `${m[1]}:${m[2]}`;
};

export const fmtDate = (iso, fmt = 'short') => {
  if (!iso) return '—';
  const d = new Date(iso.slice(0,10) + 'T12:00:00Z');
  if (Number.isNaN(d.getTime())) return iso;
  if (fmt === 'long') return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  if (fmt === 'med')  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
};

export const todayISO = () => new Date().toISOString().slice(0, 10);

// ---------------- charts ----------------

// Equity curve: array of {date, cum_pnl}
export function equityCurve(points, { height = 240, padding = 12 } = {}) {
  if (!points.length) return '<div class="empty">no data</div>';
  const w = 1200, h = height, padTop = padding, padBot = 36, padLeft = 60, padRight = 12;
  const innerW = w - padLeft - padRight;
  const innerH = h - padTop - padBot;
  const xs = points.map((_, i) => i);
  const ys = points.map(p => p.cum_pnl);
  const minY = Math.min(0, ...ys);
  const maxY = Math.max(0, ...ys);
  const xScale = (i) => padLeft + (i / Math.max(1, points.length - 1)) * innerW;
  const yScale = (v) => padTop + innerH - ((v - minY) / Math.max(1, maxY - minY)) * innerH;
  const zeroY = yScale(0);

  // path
  let d = '';
  points.forEach((p, i) => { d += (i === 0 ? 'M' : 'L') + xScale(i).toFixed(1) + ' ' + yScale(p.cum_pnl).toFixed(1); });
  let areaPos = `M${xScale(0)} ${zeroY}`, areaNeg = `M${xScale(0)} ${zeroY}`;
  // build clipped areas above and below zero
  let dPos = `M${xScale(0).toFixed(1)} ${zeroY}`;
  let dNeg = `M${xScale(0).toFixed(1)} ${zeroY}`;
  points.forEach((p, i) => {
    const x = xScale(i).toFixed(1);
    const y = Math.min(yScale(p.cum_pnl), zeroY).toFixed(1);
    const y2 = Math.max(yScale(p.cum_pnl), zeroY).toFixed(1);
    dPos += ` L${x} ${y}`;
    dNeg += ` L${x} ${y2}`;
  });
  dPos += ` L${xScale(points.length-1).toFixed(1)} ${zeroY} Z`;
  dNeg += ` L${xScale(points.length-1).toFixed(1)} ${zeroY} Z`;

  // x-axis labels — show first, mid, last
  const labels = [0, Math.floor(points.length/2), points.length-1].map(i => `
    <text class="axis-text" x="${xScale(i)}" y="${h-12}" text-anchor="${i===0?'start':i===points.length-1?'end':'middle'}">${fmtDate(points[i].date)}</text>`).join('');

  // y-axis ticks: 0, max, min
  const yTicks = [maxY, (maxY+minY)/2, minY].filter((v, i, a) => a.indexOf(v) === i);
  const yLabels = yTicks.map(v => `
    <line class="grid-line" x1="${padLeft}" x2="${w-padRight}" y1="${yScale(v)}" y2="${yScale(v)}" stroke-dasharray="${v === 0 ? '0' : '2 4'}"/>
    <text class="axis-text" x="${padLeft - 8}" y="${yScale(v) + 4}" text-anchor="end">${fmtUsd(v, { compact: true })}</text>`).join('');

  return `<div class="chart-wrap"><svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <defs>
      <linearGradient id="posg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--mint)" stop-opacity="0.30"/>
        <stop offset="100%" stop-color="var(--mint)" stop-opacity="0"/>
      </linearGradient>
      <linearGradient id="negg" x1="0" y1="1" x2="0" y2="0">
        <stop offset="0%" stop-color="var(--coral)" stop-opacity="0.30"/>
        <stop offset="100%" stop-color="var(--coral)" stop-opacity="0"/>
      </linearGradient>
    </defs>
    ${yLabels}
    <path d="${dPos}" fill="url(#posg)"/>
    <path d="${dNeg}" fill="url(#negg)"/>
    <path d="${d}" stroke="var(--text)" stroke-width="1.5" fill="none" stroke-linejoin="round"/>
    ${labels}
  </svg></div>`;
}

// Daily P&L bars
export function dailyBars(points, { height = 220 } = {}) {
  if (!points.length) return '<div class="empty">no data</div>';
  const w = 1200, h = height, padTop = 14, padBot = 32, padLeft = 60, padRight = 12;
  const innerW = w - padLeft - padRight;
  const innerH = h - padTop - padBot;
  const ys = points.map(p => p.net_pnl);
  const maxY = Math.max(0, ...ys);
  const minY = Math.min(0, ...ys);
  const yScale = (v) => padTop + innerH - ((v - minY) / Math.max(1, maxY - minY)) * innerH;
  const zeroY = yScale(0);
  const barW = innerW / points.length;
  const bars = points.map((p, i) => {
    const x = padLeft + i * barW + barW * 0.12;
    const w_ = barW * 0.76;
    const y1 = yScale(p.net_pnl);
    const top = Math.min(zeroY, y1);
    const tall = Math.max(1, Math.abs(zeroY - y1));
    const color = p.net_pnl >= 0 ? 'var(--mint)' : 'var(--coral)';
    return `<rect x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${w_.toFixed(1)}" height="${tall.toFixed(1)}" fill="${color}" opacity="0.85" data-date="${p.date}" data-pnl="${p.net_pnl}"><title>${fmtDate(p.date, 'med')} · ${fmtUsd(p.net_pnl, { signed: true })}</title></rect>`;
  }).join('');
  const labels = [0, Math.floor(points.length/2), points.length-1].map(i => `
    <text class="axis-text" x="${padLeft + i*barW + barW/2}" y="${h-10}" text-anchor="${i===0?'start':i===points.length-1?'end':'middle'}">${fmtDate(points[i].date)}</text>`).join('');
  const yTicks = [maxY, 0, minY].filter((v, i, a) => a.indexOf(v) === i);
  const yLabels = yTicks.map(v => `
    <line class="grid-line" x1="${padLeft}" x2="${w-padRight}" y1="${yScale(v)}" y2="${yScale(v)}" stroke-dasharray="${v === 0 ? '0' : '2 4'}"/>
    <text class="axis-text" x="${padLeft - 8}" y="${yScale(v) + 4}" text-anchor="end">${fmtUsd(v, { compact: true })}</text>`).join('');

  return `<div class="chart-wrap"><svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    ${yLabels}
    ${bars}
    ${labels}
  </svg></div>`;
}

// Horizontal bars (e.g. day-of-week)
export function horizBars(rows, { keyName = 'name', valueName = 'net', countName = 'count', height = 200 } = {}) {
  if (!rows.length) return '<div class="empty">no data</div>';
  const w = 720, h = height, padTop = 8, padBot = 8, padLeft = 56, padRight = 60;
  const innerW = w - padLeft - padRight;
  const rowH = (h - padTop - padBot) / rows.length;
  const vals = rows.map(r => r[valueName]);
  const maxAbs = Math.max(1, ...vals.map(Math.abs));
  const zeroX = padLeft + innerW * (maxAbs / (maxAbs*2));
  const barFor = (v) => {
    const len = (Math.abs(v) / (maxAbs * 2)) * innerW;
    return v >= 0 ? { x: zeroX, w: len } : { x: zeroX - len, w: len };
  };
  const bars = rows.map((r, i) => {
    const y = padTop + i * rowH + rowH*0.22;
    const bh = rowH * 0.56;
    const { x, w: bw } = barFor(r[valueName]);
    const color = r[valueName] >= 0 ? 'var(--mint)' : 'var(--coral)';
    return `
      <text class="axis-text" x="${padLeft - 8}" y="${y + bh*0.7}" text-anchor="end">${r[keyName]}</text>
      <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" fill="${color}" opacity="0.82"/>
      <text class="axis-text" x="${w-6}" y="${y + bh*0.7}" text-anchor="end" fill="var(--muted)">${fmtUsd(r[valueName], { signed: true, compact: true })} · ${r[countName]||0}</text>`;
  }).join('');
  return `<div class="chart-wrap"><svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet">
    <line class="tick-line" x1="${zeroX}" x2="${zeroX}" y1="${padTop}" y2="${h-padBot}"/>
    ${bars}
  </svg></div>`;
}

// Hour heatmap (24 cells)
export function hourHeat(hours) {
  const has = hours.filter(h => h.count > 0);
  if (!has.length) return '<div class="empty">no data</div>';
  const maxAbs = Math.max(1, ...has.map(h => Math.abs(h.net)));
  const cells = hours.map(h => {
    const intensity = Math.min(1, Math.abs(h.net) / maxAbs);
    const color = h.count === 0 ? 'var(--ink-2)' : (h.net >= 0 ? `rgba(143, 212, 154, ${0.18 + intensity*0.72})` : `rgba(240, 130, 116, ${0.18 + intensity*0.72})`);
    return `<div class="hcell" style="background:${color}"><b>${h.hour}</b><span>${h.count || ''}</span></div>`;
  }).join('');
  return `<div class="hours-grid">${cells}</div>`;
}

export function ksub(n) {
  return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
}
