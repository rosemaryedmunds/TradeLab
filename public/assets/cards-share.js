// Multi-card share PNG generator. Loaded lazily by cards.js the first time
// the user clicks "Generate PNG".
//
// Strategy:
//   1) Compute a target width (matches the source card's actual width).
//   2) Inline computed CSS for every node we're going to embed.
//   3) Wrap them in a vertical stack with a TradeLab header + footer.
//   4) Serialize the stack as an <foreignObject> inside an SVG.
//   5) Draw the SVG into a canvas and export PNG.
//
// foreignObject rendering is supported in Chrome/Firefox/Safari for static
// HTML but doesn't render <canvas> children — none of our charts are <canvas>,
// they're inline SVGs, so we're fine.
(function () {
  if (window.tlShareCards) return;

  // Avoid copying expensive properties that bloat the inlined style and
  // generate "transform: matrix(…)" lines that fight the layout.
  const SKIP_PROPS = new Set([
    'transform', 'transform-origin', 'will-change',
    'animation', 'animation-name', 'animation-duration', 'animation-timing-function',
    'animation-delay', 'animation-iteration-count', 'animation-direction',
    'animation-fill-mode', 'animation-play-state',
    'transition', 'transition-property', 'transition-duration',
    'transition-timing-function', 'transition-delay',
    'cursor',
  ]);
  function inlineStyles(srcRoot, clone) {
    const srcAll = srcRoot.querySelectorAll('*');
    const dstAll = clone.querySelectorAll('*');
    const queue = [[srcRoot, clone]];
    for (let i = 0; i < srcAll.length; i++) queue.push([srcAll[i], dstAll[i]]);
    for (const [src, dst] of queue) {
      if (!(src instanceof Element)) continue;
      const cs = getComputedStyle(src);
      let style = '';
      for (let i = 0; i < cs.length; i++) {
        const p = cs[i];
        if (SKIP_PROPS.has(p)) continue;
        const v = cs.getPropertyValue(p);
        if (v) style += `${p}:${v};`;
      }
      dst.setAttribute('style', style);
      // Strip event handlers and class artifacts we don't want in the export.
      dst.removeAttribute('onclick');
      dst.classList.remove('tl-arrange', 'tl-dragging', 'tl-drop-target');
    }
  }

  function strip(el) {
    // Remove the cards-system chrome from the cloned card.
    el.querySelectorAll('.tl-card-chrome, .tl-height-ctl, .selectionBox, .tl-card-toolbar, .tl-hidden-tray, .modal').forEach(n => n.remove());
    // Remove expand buttons that exist in the legacy dashboards.
    el.querySelectorAll('button.expand, .pill.action, button.close').forEach(n => n.remove());
  }

  function buildStackHtml(cards) {
    const width = Math.max(...cards.map(c => Math.ceil(c.getBoundingClientRect().width)));
    const cw = Math.min(900, Math.max(560, width));
    const stack = document.createElement('div');
    stack.style.cssText = `
      width: ${cw}px;
      background: #08090b;
      color: #f4f1ea;
      font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      padding: 36px 28px 28px;
      box-sizing: border-box;
    `;
    // Header.
    const hdr = document.createElement('div');
    hdr.style.cssText = `display:flex; justify-content:space-between; align-items:baseline; margin-bottom: 22px; padding-bottom: 16px; border-bottom: 1px solid #2a2e36;`;
    hdr.innerHTML = `
      <div>
        <div style="font-family:'Instrument Serif',Georgia,serif; font-size:32px; line-height:1;">Trade·<span style="color:#ffd166">Lab</span></div>
        <div style="font-size:11px; letter-spacing:.18em; color:#9d9a91; text-transform:uppercase; margin-top:6px;">${cards.length} card${cards.length>1?'s':''} · ${new Date().toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'})}</div>
      </div>
      <div style="font-size:11px; letter-spacing:.14em; color:#ffd166; text-transform:uppercase;">Shared layout</div>`;
    stack.appendChild(hdr);

    for (const card of cards) {
      const clone = card.cloneNode(true);
      strip(clone);
      // Force-show even if currently hidden in the live page.
      clone.style.display = 'block';
      clone.style.position = 'relative';
      clone.style.marginBottom = '18px';
      clone.style.padding = '22px';
      clone.style.border = '1px solid #2a2e36';
      clone.style.borderRadius = '18px';
      clone.style.background = 'linear-gradient(180deg,#15171b,#101114)';
      clone.style.width = '100%';
      clone.style.minHeight = '';
      clone.style.height = '';
      inlineStyles(card, clone);
      stack.appendChild(clone);
    }

    // Footer.
    const ftr = document.createElement('div');
    ftr.style.cssText = `display:flex; justify-content:space-between; align-items:center; margin-top:8px; padding-top: 16px; border-top: 1px solid #1d2026; font-size: 11px; color:#9d9a91; letter-spacing:.08em;`;
    ftr.innerHTML = `<span>tradelab</span><span>Generated ${new Date().toLocaleString()}</span>`;
    stack.appendChild(ftr);
    return { stack, width: cw };
  }

  async function renderToPng(stack, width) {
    // Mount off-screen so layout settles, then capture.
    stack.style.position = 'fixed';
    stack.style.left = '-99999px';
    stack.style.top = '0';
    document.body.appendChild(stack);
    // Force a layout pass.
    void stack.offsetHeight;
    const height = stack.scrollHeight;

    // Wrap in an SVG with a foreignObject of the stack's outerHTML.
    const xhtml = new XMLSerializer().serializeToString(stack);
    document.body.removeChild(stack);

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <foreignObject width="100%" height="100%">${xhtml}</foreignObject>
    </svg>`;
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        // Use 2x scale for retina sharpness on common screens.
        const scale = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
        const canvas = document.createElement('canvas');
        canvas.width = width * scale;
        canvas.height = height * scale;
        const ctx = canvas.getContext('2d');
        ctx.scale(scale, scale);
        ctx.fillStyle = '#08090b';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
        canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob failed')), 'image/png');
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image load failed')); };
      img.src = url;
    });
  }

  function openPreview(blob, cards) {
    const url = URL.createObjectURL(blob);
    const back = document.createElement('div');
    back.style.cssText = `position:fixed; inset:0; background:rgba(4,5,7,.92); z-index:9300;
      display:flex; align-items:center; justify-content:center; padding:5vh 18px; overflow:auto;`;
    back.innerHTML = `
      <div style="background:#101114; border:1px solid #2a2e36; border-radius:18px; padding:22px;
                  max-width:min(96vw,900px); width:100%; max-height:90vh; overflow:auto;
                  font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px;">
          <h2 style="margin:0; font-family:'Instrument Serif',Georgia,serif; font-weight:400; font-size:24px; color:#f4f1ea;">Share preview</h2>
          <button class="tl-x" type="button" style="background:transparent;border:none;color:#9d9a91;font-size:24px;cursor:pointer;">×</button>
        </div>
        <div style="font-size:12px;color:#9d9a91;margin-bottom:14px;">${cards.length} card${cards.length>1?'s':''} · PNG · Right-click → Save image, or use the Download button.</div>
        <div style="border:1px solid #1d2026; border-radius:12px; overflow:hidden; background:#08090b;">
          <img src="${url}" alt="share preview" style="display:block; width:100%; height:auto;"/>
        </div>
        <div style="display:flex; gap:10px; justify-content:flex-end; margin-top:16px;">
          <button class="tl-x" type="button" style="padding:10px 14px; border:1px solid #2a2e36; background:transparent; color:#f4f1ea; border-radius:10px; cursor:pointer;">Close</button>
          <a class="tl-dl" href="${url}" download="tradelab-share-${Date.now()}.png" style="padding:10px 18px; border:1px solid #ffd166; background:#ffd166; color:#0a0a0a; border-radius:10px; text-decoration:none; font-weight:600; font-size:12px; letter-spacing:.16em; text-transform:uppercase;">Download PNG</a>
        </div>
      </div>`;
    document.body.appendChild(back);
    const close = () => { URL.revokeObjectURL(url); back.remove(); };
    back.addEventListener('click', (e) => { if (e.target === back) close(); });
    back.querySelectorAll('.tl-x').forEach(b => b.addEventListener('click', close));
  }

  window.tlShareCards = async function (cards) {
    try {
      const { stack, width } = buildStackHtml(cards);
      const blob = await renderToPng(stack, width);
      openPreview(blob, cards);
    } catch (e) {
      console.error('share failed', e);
      alert('Could not generate share image. Try fewer cards or a different browser.');
    }
  };
  window.__tlShareReady = true;
})();
