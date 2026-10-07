// Detección automática de muros sobre la imagen de la mensura (todo en el navegador).
// 1) recorta la zona elegida y la pasa a blanco y negro
// 2) estima la inclinación dominante del dibujo y lo endereza
// 3) busca trazos horizontales y verticales largos (franjas oscuras)
// 4) une líneas dobles, tramos colineales y esquinas
// 5) devuelve segmentos en metros, listos para convertirse en muros
(function () {
  const SA = window.SA;
  const M = SA.model;
  const D = {};

  function otsu(gray) {
    const hist = new Array(256).fill(0);
    for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
    let sum = 0;
    for (let t = 0; t < 256; t++) sum += t * hist[t];
    let sumB = 0, wB = 0, best = 0, thr = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (!wB) continue;
      const wF = gray.length - wB;
      if (!wF) break;
      sumB += t * hist[t];
      const diff = sumB / wB - (sum - sumB) / wF;
      const between = wB * wF * diff * diff;
      if (between > best) { best = between; thr = t; }
    }
    return thr;
  }

  // Inclinación dominante de los bordes (módulo 90°), en radianes entre -45° y 45°
  function dominantAngle(g, w, h) {
    const bins = new Float32Array(180); // pasos de 0,5°
    for (let y = 1; y < h - 1; y += 2) {
      for (let x = 1; x < w - 1; x += 2) {
        const i = y * w + x;
        const gx = -g[i - w - 1] - 2 * g[i - 1] - g[i + w - 1] + g[i - w + 1] + 2 * g[i + 1] + g[i + w + 1];
        const gy = -g[i - w - 1] - 2 * g[i - w] - g[i - w + 1] + g[i + w - 1] + 2 * g[i + w] + g[i + w + 1];
        const mag = Math.abs(gx) + Math.abs(gy);
        if (mag < 80) continue;
        let a = (Math.atan2(gy, gx) * 180) / Math.PI;
        a = ((a % 90) + 90) % 90;
        bins[Math.floor(a * 2) % 180] += mag;
      }
    }
    let peak = 0, peakVal = -1;
    for (let k = 0; k < 180; k++) {
      const v = bins[(k + 179) % 180] + bins[k] + bins[(k + 1) % 180];
      if (v > peakVal) { peakVal = v; peak = k; }
    }
    let deg = (peak + 0.5) / 2;
    if (deg > 45) deg -= 90;
    if (Math.abs(deg) < 0.5) deg = 0;
    return (deg * Math.PI) / 180;
  }

  const median = (arr) => {
    const s = arr.slice().sort((p, q) => p - q);
    return s[Math.floor(s.length / 2)];
  };

  // Franjas oscuras largas en una dirección. get(i, j): i = fila (o columna), j = posición a lo largo.
  function findBands(get, n1, n2, P) {
    const out = [];
    let open = [];
    for (let i = 0; i < n1; i++) {
      const runs = [];
      let s = -1, last = -1;
      for (let j = 0; j < n2; j++) {
        if (get(i, j)) {
          if (s < 0) s = j;
          last = j;
        } else if (s >= 0 && j - last > P.gap) {
          if (last - s + 1 >= P.minLen) runs.push([s, last]);
          s = -1;
        }
      }
      if (s >= 0 && last - s + 1 >= P.minLen) runs.push([s, last]);

      runs.forEach(([a, b]) => {
        const match = open.find(band => !band.used &&
          Math.min(b, band.b) - Math.max(a, band.a) >= 0.6 * Math.min(b - a, band.b - band.a));
        if (match) {
          Object.assign(match, { used: true, last: i, a, b });
          match.as.push(a);
          match.bs.push(b);
        } else {
          open.push({ first: i, last: i, a, b, as: [a], bs: [b], used: true });
        }
      });

      open = open.filter(band => {
        if (i - band.last > 1) { out.push(band); return false; }
        band.used = false;
        return true;
      });
    }
    out.push(...open);
    return out.map(b => ({ c: (b.first + b.last) / 2, a: median(b.as), b: median(b.bs), t: b.last - b.first + 1 }));
  }

  const overlap = (s, u) => Math.min(s.b, u.b) - Math.max(s.a, u.a);

  // Muros dibujados con doble línea: dos trazos paralelos cercanos pasan a ser uno con espesor
  function mergeParallel(segs, maxDist) {
    let changed = true;
    while (changed) {
      changed = false;
      outer:
      for (let i = 0; i < segs.length; i++) {
        for (let j = i + 1; j < segs.length; j++) {
          const s = segs[i], u = segs[j];
          if (s.o !== u.o) continue;
          const d = Math.abs(s.c - u.c);
          if (d < 1 || d > maxDist) continue;
          if (overlap(s, u) < 0.6 * Math.min(s.b - s.a, u.b - u.a)) continue;
          segs[i] = { o: s.o, c: (s.c + u.c) / 2, a: Math.min(s.a, u.a), b: Math.max(s.b, u.b), t: d + (s.t + u.t) / 2 };
          segs.splice(j, 1);
          changed = true;
          break outer;
        }
      }
    }
    return segs;
  }

  // Tramos en la misma línea separados por un hueco se unen. Los huecos del ancho de una
  // puerta se anotan para colocarla después (así el ambiente queda cerrado).
  function mergeCollinear(segs, gapMax, doorMin, gaps) {
    let changed = true;
    while (changed) {
      changed = false;
      outer:
      for (let i = 0; i < segs.length; i++) {
        for (let j = i + 1; j < segs.length; j++) {
          const s = segs[i], u = segs[j];
          if (s.o !== u.o) continue;
          if (Math.abs(s.c - u.c) > Math.max(2, (s.t + u.t) / 2)) continue;
          const gap = -overlap(s, u);
          if (gap > gapMax) continue;
          if (gap >= doorMin) {
            const first = s.a < u.a ? s : u, second = s.a < u.a ? u : s;
            gaps.push({ o: s.o, c: (s.c + u.c) / 2, a: first.b, b: second.a });
          }
          const ls = s.b - s.a, lu = u.b - u.a;
          segs[i] = { o: s.o, c: (s.c * ls + u.c * lu) / (ls + lu), a: Math.min(s.a, u.a), b: Math.max(s.b, u.b), t: Math.max(s.t, u.t) };
          segs.splice(j, 1);
          changed = true;
          break outer;
        }
      }
    }
    return segs;
  }

  // Extiende o recorta los extremos hasta el muro perpendicular más cercano (esquinas y encuentros en T)
  function snapCorners(segs, tol) {
    segs.forEach(s => {
      ['a', 'b'].forEach(end => {
        let best = null, bestD = tol;
        segs.forEach(v => {
          if (v.o === s.o || s.c < v.a - tol || s.c > v.b + tol) return;
          const d = Math.abs(v.c - s[end]);
          if (d <= bestD) { bestD = d; best = v; }
        });
        if (best) s[end] = best.c;
      });
      if (s.a > s.b) { const t = s.a; s.a = s.b; s.b = t; }
    });
    return segs;
  }

  // region: {a, b} en metros (esquinas opuestas) o null para toda la imagen
  D.run = (region, opts = {}) => {
    const plan = M.level.plan;
    const img = M.planImage;
    if (!plan || !img) return { error: 'noplan' };
    const mpp = plan.mPerPx;
    const ox = plan.x - (img.width * mpp) / 2;
    const oy = plan.y - (img.height * mpp) / 2;

    let x0 = 0, y0 = 0, x1 = img.width, y1 = img.height;
    if (region) {
      const clampX = (v) => Math.max(0, Math.min(img.width, v));
      const clampY = (v) => Math.max(0, Math.min(img.height, v));
      x0 = clampX(Math.floor((Math.min(region.a.x, region.b.x) - ox) / mpp));
      x1 = clampX(Math.ceil((Math.max(region.a.x, region.b.x) - ox) / mpp));
      y0 = clampY(Math.floor((Math.min(region.a.y, region.b.y) - oy) / mpp));
      y1 = clampY(Math.ceil((Math.max(region.a.y, region.b.y) - oy) / mpp));
    }
    const cw = x1 - x0, ch = y1 - y0;
    if (cw < 30 || ch < 30) return { error: 'small' };

    // Recorte en escala de grises (reducido si es muy grande)
    const scale = Math.min(1, 1600 / Math.max(cw, ch));
    const w = Math.max(1, Math.round(cw * scale)), h = Math.max(1, Math.round(ch * scale));
    const crop = document.createElement('canvas');
    crop.width = w; crop.height = h;
    const cctx = crop.getContext('2d', { willReadFrequently: true });
    cctx.fillStyle = '#ffffff';
    cctx.fillRect(0, 0, w, h);
    cctx.drawImage(img, x0, y0, cw, ch, 0, 0, w, h);
    const toGray = (data) => {
      const g = new Uint8Array(data.length / 4);
      for (let i = 0; i < g.length; i++) g[i] = (data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114) | 0;
      return g;
    };
    const gray = toGray(cctx.getImageData(0, 0, w, h).data);
    const thr = Math.min(otsu(gray), 200);
    const theta = dominantAngle(gray, w, h);

    // Enderezo el dibujo para buscar trazos horizontales y verticales
    let W = w, H = h, bin;
    if (theta === 0) {
      bin = gray.map(v => (v < thr ? 1 : 0));
    } else {
      const cos = Math.abs(Math.cos(theta)), sin = Math.abs(Math.sin(theta));
      W = Math.ceil(w * cos + h * sin);
      H = Math.ceil(w * sin + h * cos);
      const rot = document.createElement('canvas');
      rot.width = W; rot.height = H;
      const rctx = rot.getContext('2d', { willReadFrequently: true });
      rctx.fillStyle = '#ffffff';
      rctx.fillRect(0, 0, W, H);
      rctx.translate(W / 2, H / 2);
      rctx.rotate(-theta);
      rctx.drawImage(crop, -w / 2, -h / 2);
      bin = toGray(rctx.getImageData(0, 0, W, H).data).map(v => (v < thr ? 1 : 0));
    }

    // Umbrales: en metros si la mensura está calibrada, si no, proporcionales al recorte
    const size = Math.max(W, H);
    const pxPerM = plan.calibrated ? scale / mpp : null;
    const P = {
      minLen: Math.max(14, pxPerM ? 0.5 * pxPerM : 0.035 * size),
      maxThick: Math.max(5, pxPerM ? 0.5 * pxPerM : 0.025 * size),
      minThick: opts.thin ? 1 : 2,
      gap: 2,
      join: Math.max(3, pxPerM ? 1.1 * pxPerM : 0.05 * size),   // hasta el ancho de una puerta
      doorMin: Math.max(4, pxPerM ? 0.55 * pxPerM : 0.025 * size),
      corner: Math.max(5, pxPerM ? 0.35 * pxPerM : 0.02 * size)
    };

    const keep = (s) => s.t >= P.minThick && s.t <= P.maxThick && s.b - s.a >= P.minLen;
    let segs = [
      ...findBands((i, j) => bin[i * W + j], H, W, P).map(s => ({ ...s, o: 'h' })).filter(keep),
      ...findBands((i, j) => bin[j * W + i], W, H, P).map(s => ({ ...s, o: 'v' })).filter(keep)
    ];
    segs.sort((s, u) => (u.b - u.a) - (s.b - s.a));
    segs = segs.slice(0, 600);

    segs = mergeParallel(segs, P.maxThick);
    const gaps = [];
    segs = mergeCollinear(segs, P.join, P.doorMin, gaps);
    segs = snapCorners(segs, P.corner);
    segs = segs.filter(s => s.b - s.a >= P.minLen * 0.8);

    // De vuelta a metros: dibujo enderezado -> recorte -> imagen -> plano
    const c = Math.cos(theta), sn = Math.sin(theta);
    const toWorld = (u, v) => {
      const dx = u - W / 2, dy = v - H / 2;
      const x = c * dx - sn * dy + w / 2;
      const y = sn * dx + c * dy + h / 2;
      return { x: ox + (x0 + x / scale) * mpp, y: oy + (y0 + y / scale) * mpp };
    };
    const metersPerPx = mpp / scale;
    const segments = segs.map(s => ({
      p: s.o === 'h' ? toWorld(s.a, s.c) : toWorld(s.c, s.a),
      q: s.o === 'h' ? toWorld(s.b, s.c) : toWorld(s.c, s.b),
      thickness: plan.calibrated ? Math.min(0.45, Math.max(0.08, s.t * metersPerPx)) : undefined
    }));

    // Puertas en los huecos (solo con escala calibrada, para conocer su ancho)
    const doors = plan.calibrated ? gaps.map(g => {
      const mid = (g.a + g.b) / 2;
      return {
        center: g.o === 'h' ? toWorld(mid, g.c) : toWorld(g.c, mid),
        width: Math.min(1.2, Math.max(0.6, (g.b - g.a) * metersPerPx))
      };
    }) : [];

    return { segments, doors, joinTolerance: P.corner * metersPerPx * 0.5, angle: (theta * 180) / Math.PI };
  };

  SA.detect = D;
})();
