// Editor 2D sobre Konva: dibuja el modelo y traduce los gestos en cambios del modelo.
// El escenario está escalado en píxeles por metro, así todo se dibuja en medidas reales.
(function () {
  const SA = window.SA;
  const M = SA.model;
  const LIB = SA.library;

  const COLORS = { wall: '#1e293b', selected: '#0ea5e9', line: '#334155', dim: '#0369a1', guide: '#f59e0b' };
  const HINTS = {
    select: 'Tocá un muro, abertura, objeto o ambiente para editarlo. Arrastrá las esquinas para moverlas.',
    wall: 'Tocá cada esquina del muro. Se engancha a esquinas y muros existentes (también para paredes internas).',
    door: 'Tocá sobre un muro para colocar una puerta.',
    window: 'Tocá sobre un muro para colocar una ventana.',
    object: 'Tocá el plano para colocar el objeto elegido.',
    calibrate: 'Tocá los dos extremos de una cota conocida de la mensura.'
  };

  const E = {};
  let stage, container, panelEl, hintEl, finishBtn;
  const layers = {};
  let tool = 'select';
  let selection = null;      // {kind: 'wall'|'opening'|'object'|'room', id?, point?}
  let chainLast = null;      // id del último nodo del muro en curso
  let calibStart = null;
  let pendingObject = null;  // tipo de objeto a colocar
  let hover = null;          // punto bajo el mouse (con enganche)
  let pinchedAt = 0;
  let renderQueued = false;

  const zoom = () => stage.scaleX();
  const px = (n) => n / zoom(); // tamaño constante en pantalla, expresado en metros
  const fmt = (n) => n.toFixed(2).replace('.', ',');
  const num = (v) => parseFloat(String(v).replace(',', '.'));

  // ---------- inicialización ----------
  E.init = (opts) => {
    container = opts.container;
    panelEl = opts.panel;
    hintEl = opts.hint;
    finishBtn = opts.finishBtn;

    Konva.hitOnDragEnabled = true;
    Konva.dragDistance = 5;

    stage = new Konva.Stage({ container, width: container.clientWidth || 300, height: container.clientHeight || 300, draggable: true });
    stage.scale({ x: 50, y: 50 });
    stage.position({ x: stage.width() / 2, y: stage.height() / 2 });

    layers.bg = new Konva.Layer({ listening: false });
    layers.main = new Konva.Layer();
    layers.handles = new Konva.Layer();
    layers.ui = new Konva.Layer({ listening: false });
    stage.add(layers.bg, layers.main, layers.handles, layers.ui);

    stage.on('click tap', (e) => {
      if (Date.now() - pinchedAt < 350) return;
      handleTap(stage.getRelativePointerPosition(), e.target);
    });

    stage.on('mousemove', () => {
      if (tool !== 'wall' && tool !== 'calibrate') return;
      const pos = stage.getRelativePointerPosition();
      hover = snap(pos, null, chainLast ? M.node(chainLast) : null);
      renderUi();
    });
    stage.on('mouseleave', () => { hover = null; renderUi(); });

    // Zoom con rueda, centrado en el cursor
    stage.on('wheel', (e) => {
      e.evt.preventDefault();
      const pointer = stage.getPointerPosition();
      zoomAt(pointer, zoom() * (e.evt.deltaY < 0 ? 1.15 : 1 / 1.15));
    });

    // Zoom y paneo con dos dedos
    let lastCenter = null, lastDist = 0;
    stage.on('touchmove', (e) => {
      const t = e.evt.touches;
      if (!t || t.length < 2) return;
      e.evt.preventDefault();
      if (stage.isDragging()) stage.stopDrag();
      const rect = container.getBoundingClientRect();
      const p1 = { x: t[0].clientX - rect.left, y: t[0].clientY - rect.top };
      const p2 = { x: t[1].clientX - rect.left, y: t[1].clientY - rect.top };
      const center = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
      const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y) || 1;
      pinchedAt = Date.now();
      if (lastCenter) {
        const world = { x: (lastCenter.x - stage.x()) / zoom(), y: (lastCenter.y - stage.y()) / zoom() };
        const s = clampZoom(zoom() * (dist / lastDist));
        stage.scale({ x: s, y: s });
        stage.position({ x: center.x - world.x * s, y: center.y - world.y * s });
        scheduleRender();
      }
      lastCenter = center;
      lastDist = dist;
    });
    stage.on('touchend touchcancel', () => { lastCenter = null; lastDist = 0; });

    window.addEventListener('keydown', (e) => {
      if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
      if (e.key === 'Delete' || e.key === 'Backspace') E.deleteSelection();
      if (e.key === 'Escape') { E.endChain(); select(null); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? M.redo() : M.undo(); }
    });

    M.on(() => {
      if (chainLast && !M.node(chainLast)) chainLast = null;
      if (selection && !selectionExists()) selection = null;
      render();
    });
  };

  function clampZoom(s) { return Math.max(0.05, Math.min(5000, s)); }

  function zoomAt(screenPt, newZoom) {
    const s = clampZoom(newZoom);
    const world = { x: (screenPt.x - stage.x()) / zoom(), y: (screenPt.y - stage.y()) / zoom() };
    stage.scale({ x: s, y: s });
    stage.position({ x: screenPt.x - world.x * s, y: screenPt.y - world.y * s });
    scheduleRender();
  }

  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; render(); });
  }

  E.resize = () => {
    if (!stage || !container.clientWidth) return;
    stage.size({ width: container.clientWidth, height: container.clientHeight });
    render();
  };

  // ---------- enganche (snapping) ----------
  function snap(pos, excludeNodeId, fromPoint) {
    const r = px(14);
    const nid = M.nodeAt(pos, r, excludeNodeId);
    if (nid) return { x: M.node(nid).x, y: M.node(nid).y, kind: 'node', id: nid };
    const near = M.wallNear(pos, r, excludeNodeId);
    if (near) return { x: near.point.x, y: near.point.y, kind: 'wall' };

    const p = { x: pos.x, y: pos.y, kind: 'free' };
    // Alineación horizontal/vertical con el punto anterior y con otras esquinas
    const refs = fromPoint ? [fromPoint] : [];
    for (const id in M.project.nodes) if (id !== excludeNodeId) refs.push(M.project.nodes[id]);
    let bestX = r, bestY = r;
    refs.forEach(n => {
      if (Math.abs(pos.x - n.x) < bestX) { bestX = Math.abs(pos.x - n.x); p.x = n.x; p.kind = 'axis'; }
      if (Math.abs(pos.y - n.y) < bestY) { bestY = Math.abs(pos.y - n.y); p.y = n.y; p.kind = 'axis'; }
    });
    return p;
  }

  // ---------- acciones por toque ----------
  function handleTap(pos, target) {
    if (!pos) return;
    const P = M.project;

    if (tool === 'select') {
      if (!target || target === stage) select(null);
      return;
    }

    if (tool === 'wall') {
      const s = snap(pos, null, chainLast ? M.node(chainLast) : null);
      const eps = px(3);
      if (!chainLast) {
        chainLast = M.resolvePoint(s, eps).id;
        render();
        return;
      }
      const res = M.addWall(chainLast, s, eps);
      if (res.endId === chainLast) return;
      // Llegar a una esquina o muro existente termina el tramo
      chainLast = res.endExisted ? null : res.endId;
      M.commit();
      return;
    }

    if (tool === 'door' || tool === 'window') {
      const near = M.wallNear(pos, px(40));
      if (!near) { flashHint('Tocá más cerca de un muro.'); return; }
      const width = tool === 'door' ? 0.8 : 1.2;
      const o = { id: M.newId('o'), type: tool, wallId: near.wall.id, t: near.t, width, flip: 0 };
      clampOpening(o);
      P.openings.push(o);
      selection = { kind: 'opening', id: o.id };
      M.commit();
      return;
    }

    if (tool === 'object') {
      const def = LIB.objectType(pendingObject);
      if (!def) return;
      const o = { id: M.newId('f'), type: def.type, x: pos.x, y: pos.y, rotation: 0, w: def.w, d: def.d, h: def.h };
      P.objects.push(o);
      selection = { kind: 'object', id: o.id };
      E.setTool('select');
      M.commit();
      return;
    }

    if (tool === 'calibrate') {
      const s = snap(pos, null, null);
      if (!calibStart) { calibStart = s; renderUi(); return; }
      const current = Math.hypot(s.x - calibStart.x, s.y - calibStart.y);
      calibStart = null;
      if (current > 0) {
        const input = prompt('Ingresá la distancia real en metros para esta cota:', '5,00');
        const real = input ? num(input) : NaN;
        if (real > 0) E.calibrate(real / current);
      }
      renderUi();
    }
  }
  E._tap = handleTap; // punto de entrada para pruebas automáticas

  // Reescala a metros reales sin mover nada en pantalla
  E.calibrate = (k) => {
    M.scaleAll(k, M.project.geomFollowsPlan || !M.project.plan);
    const s = zoom() / k;
    stage.scale({ x: s, y: s });
    E.setTool('select');
    M.commit();
  };

  function clampOpening(o) {
    const w = M.wall(o.wallId);
    const len = M.wallLength(w);
    const half = Math.min(o.width, len) / 2 / len;
    o.t = Math.max(half, Math.min(1 - half, o.t));
  }

  let hintTimer = null;
  function flashHint(text) {
    hintEl.innerText = text;
    clearTimeout(hintTimer);
    hintTimer = setTimeout(updateHint, 2500);
  }

  function updateHint() {
    let text = HINTS[tool];
    if (tool === 'wall' && chainLast) text = 'Tocá la siguiente esquina. "Terminar muro" corta el tramo.';
    if (tool === 'calibrate' && calibStart) text = 'Ahora tocá el otro extremo de la cota.';
    if (!M.isMetric()) text += ' — Mensura sin calibrar: las medidas aparecen al calibrar la escala.';
    hintEl.innerText = text;
    finishBtn.classList.toggle('hidden', !(tool === 'wall' && chainLast));
  }

  // ---------- herramientas y selección ----------
  E.setTool = (t, objectType) => {
    E.endChain(true);
    tool = t;
    calibStart = null;
    hover = null;
    if (t === 'object') pendingObject = objectType;
    if (t !== 'select') selection = null;
    if (E.onTool) E.onTool(t);
    render();
  };
  E.getTool = () => tool;

  // Termina el muro en curso y descarta una esquina suelta sin muros
  E.endChain = (silent) => {
    if (!chainLast) return;
    chainLast = null;
    M.cleanupNodes();
    if (!silent) render();
  };

  function select(sel) {
    selection = sel;
    render();
  }

  function selectionExists() {
    const P = M.project;
    if (selection.kind === 'wall') return !!M.wall(selection.id);
    if (selection.kind === 'opening') return P.openings.some(o => o.id === selection.id);
    if (selection.kind === 'object') return P.objects.some(o => o.id === selection.id);
    return true;
  }

  E.deleteSelection = () => {
    if (!selection) return;
    if (selection.kind === 'wall') M.removeWall(selection.id);
    else if (selection.kind === 'opening') M.removeOpening(selection.id);
    else if (selection.kind === 'object') M.removeObject(selection.id);
    else return;
    selection = null;
    M.commit();
  };

  // ---------- dibujo ----------
  function render() {
    if (!stage) return;
    renderBg();
    renderMain();
    renderHandles();
    renderUi();
    updatePanel();
    updateHint();
  }
  E.render = render;

  function renderBg() {
    const P = M.project;
    layers.bg.destroyChildren();

    // Grilla de 1 metro (solo con medidas reales y si no queda demasiado densa)
    if (M.isMetric()) {
      layers.bg.add(new Konva.Shape({
        sceneFunc: (ctx) => {
          const s = zoom();
          const step = s >= 12 ? 1 : s >= 2.4 ? 5 : 0;
          if (!step) return;
          const x0 = -stage.x() / s, y0 = -stage.y() / s;
          const x1 = x0 + stage.width() / s, y1 = y0 + stage.height() / s;
          ctx.beginPath();
          for (let x = Math.floor(x0 / step) * step; x <= x1; x += step) { ctx.moveTo(x, y0); ctx.lineTo(x, y1); }
          for (let y = Math.floor(y0 / step) * step; y <= y1; y += step) { ctx.moveTo(x0, y); ctx.lineTo(x1, y); }
          ctx.setAttr('strokeStyle', '#e2e8f0');
          ctx.setAttr('lineWidth', 1 / s);
          ctx.stroke();
        }
      }));
    }

    if (P.plan && M.planImage) {
      const w = M.planImage.width * P.plan.mPerPx;
      const h = M.planImage.height * P.plan.mPerPx;
      layers.bg.add(new Konva.Image({
        image: M.planImage, x: P.plan.x - w / 2, y: P.plan.y - h / 2, width: w, height: h, opacity: 0.6
      }));
    }
    layers.bg.batchDraw();
  }

  function renderMain() {
    const P = M.project;
    const L = layers.main;
    const metric = M.isMetric();
    const selecting = tool === 'select';
    L.destroyChildren();

    // Ambientes detectados (caras cerradas entre muros)
    M.faces().forEach(face => {
      const rt = LIB.roomType(face.label ? face.label.type : 'otro');
      const isSel = selection && selection.kind === 'room' && M.pointInPoly(selection.point, face.poly);
      const shape = new Konva.Line({
        points: face.poly.flatMap(p => [p.x, p.y]), closed: true,
        fill: rt.color, opacity: 0.75,
        stroke: isSel ? COLORS.selected : null, strokeWidth: px(3)
      });
      shape.on('click tap', (e) => {
        if (tool !== 'select') return;
        e.cancelBubble = true;
        select({ kind: 'room', point: face.label ? { x: face.label.x, y: face.label.y } : stage.getRelativePointerPosition() });
      });
      L.add(shape);

      const name = face.label ? face.label.name : rt.name;
      const text = new Konva.Text({
        x: face.centroid.x, y: face.centroid.y, listening: false, align: 'center',
        text: metric ? `${name}\n${fmt(face.area)} m²` : name,
        fontSize: px(12), fontStyle: 'bold', fill: '#0f172a', lineHeight: 1.25
      });
      text.offsetX(text.width() / 2);
      text.offsetY(text.height() / 2);
      L.add(text);
    });

    // Muros
    P.walls.forEach(w => {
      const a = M.node(w.a), b = M.node(w.b);
      const isSel = selection && selection.kind === 'wall' && selection.id === w.id;
      const line = new Konva.Line({
        points: [a.x, a.y, b.x, b.y], stroke: isSel ? COLORS.selected : COLORS.wall,
        strokeWidth: w.thickness, lineCap: 'square', hitStrokeWidth: Math.max(w.thickness, px(24))
      });
      line.on('click tap', (e) => {
        if (tool !== 'select') return;
        e.cancelBubble = true;
        select({ kind: 'wall', id: w.id });
      });
      L.add(line);
    });

    // Aberturas
    P.openings.forEach(o => {
      const g = buildOpening(o);
      if (g) L.add(g);
    });

    // Objetos
    let selectedObjectNode = null;
    P.objects.forEach(o => {
      const g = buildObject(o);
      L.add(g);
      if (selection && selection.kind === 'object' && selection.id === o.id) selectedObjectNode = g;
    });

    // Cotas de cada muro
    if (metric) {
      P.walls.forEach(w => {
        const a = M.node(w.a), b = M.node(w.b);
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        if (len * zoom() < 46) return;
        let ang = Math.atan2(b.y - a.y, b.x - a.x);
        const nx = -Math.sin(ang), ny = Math.cos(ang);
        const off = w.thickness / 2 + px(9);
        if (ang > Math.PI / 2 || ang <= -Math.PI / 2) ang += Math.PI;
        const text = new Konva.Text({
          x: (a.x + b.x) / 2 - nx * off, y: (a.y + b.y) / 2 - ny * off,
          text: `${fmt(len)} m`, fontSize: px(11), fill: COLORS.dim, rotation: (ang * 180) / Math.PI, listening: false
        });
        text.offsetX(text.width() / 2);
        text.offsetY(text.height() / 2);
        L.add(text);
      });
    }

    // Giro libre del objeto seleccionado
    if (selectedObjectNode && selecting) {
      const tr = new Konva.Transformer({
        nodes: [selectedObjectNode], resizeEnabled: false, rotateEnabled: true,
        rotationSnaps: [0, 45, 90, 135, 180, 225, 270, 315], rotationSnapTolerance: 8,
        borderStroke: COLORS.selected, anchorStroke: COLORS.selected, anchorSize: 14, rotateAnchorOffset: 28
      });
      L.add(tr);
    }
    L.batchDraw();
  }

  function buildOpening(o) {
    const w = M.wall(o.wallId);
    if (!w) return null;
    const a = M.node(w.a), b = M.node(w.b);
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (!len) return null;
    const width = Math.min(o.width, len);
    const th = w.thickness;
    const isSel = selection && selection.kind === 'opening' && selection.id === o.id;
    const stroke = isSel ? COLORS.selected : COLORS.line;
    const sw = px(isSel ? 2.5 : 1.3);

    const g = new Konva.Group({
      x: a.x + (b.x - a.x) * o.t, y: a.y + (b.y - a.y) * o.t,
      rotation: (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI,
      scaleX: o.flip & 1 ? -1 : 1, scaleY: o.flip & 2 ? -1 : 1,
      draggable: tool === 'select'
    });
    // Vano: tapa el muro
    g.add(new Konva.Rect({ x: -width / 2, y: -th / 2, width, height: th, fill: '#ffffff', stroke, strokeWidth: sw, hitStrokeWidth: px(26) }));
    if (o.type === 'door') {
      g.add(new Konva.Line({ points: [-width / 2, 0, -width / 2, -width], stroke, strokeWidth: sw * 1.4 }));
      g.add(new Konva.Arc({ x: -width / 2, y: 0, innerRadius: width, outerRadius: width, angle: 90, rotation: -90, stroke, strokeWidth: sw, listening: false }));
    } else {
      g.add(new Konva.Line({ points: [-width / 2, 0, width / 2, 0], stroke, strokeWidth: sw, listening: false }));
    }

    g.on('click tap', (e) => {
      if (tool !== 'select') return;
      e.cancelBubble = true;
      select({ kind: 'opening', id: o.id });
    });
    // Arrastrar: la abertura se desliza por el muro más cercano
    g.on('dragmove', () => {
      const near = M.wallNear(stage.getRelativePointerPosition(), Infinity);
      if (!near) return;
      o.wallId = near.wall.id;
      o.t = near.t;
      clampOpening(o);
      const wa = M.node(near.wall.a), wb = M.node(near.wall.b);
      g.position({ x: wa.x + (wb.x - wa.x) * o.t, y: wa.y + (wb.y - wa.y) * o.t });
      g.rotation((Math.atan2(wb.y - wa.y, wb.x - wa.x) * 180) / Math.PI);
    });
    g.on('dragend', () => {
      selection = { kind: 'opening', id: o.id };
      setTimeout(() => M.commit(), 0);
    });
    return g;
  }

  function buildObject(o) {
    const def = LIB.objectType(o.type) || { sym: [{ k: 'rect', x: 0, y: 0, w: 1, h: 1, r: 0 }] };
    const isSel = selection && selection.kind === 'object' && selection.id === o.id;
    const stroke = isSel ? COLORS.selected : COLORS.line;
    const sw = px(1.3);
    const X = (nx) => (nx - 0.5) * o.w;
    const Y = (ny) => (ny - 0.5) * o.d;
    const m = Math.min(o.w, o.d);

    const g = new Konva.Group({ x: o.x, y: o.y, rotation: o.rotation, draggable: tool === 'select' });
    // Base invisible para que todo el objeto sea fácil de tocar
    g.add(new Konva.Rect({ x: -o.w / 2, y: -o.d / 2, width: o.w, height: o.d, fill: 'rgba(255,255,255,0.01)', hitStrokeWidth: px(14) }));
    def.sym.forEach(s => {
      const common = { stroke, strokeWidth: sw, listening: false };
      if (s.k === 'rect') g.add(new Konva.Rect({ x: X(s.x), y: Y(s.y), width: s.w * o.w, height: s.h * o.d, cornerRadius: s.r * m, fill: '#ffffff', ...common }));
      else if (s.k === 'ellipse') g.add(new Konva.Ellipse({ x: X(s.cx), y: Y(s.cy), radiusX: s.rx * o.w, radiusY: s.ry * o.d, fill: '#ffffff', ...common }));
      else if (s.k === 'circle') g.add(new Konva.Circle({ x: X(s.cx), y: Y(s.cy), radius: s.r * m, ...common }));
      else if (s.k === 'line') g.add(new Konva.Line({ points: s.pts.map((v, i) => (i % 2 ? Y(v) : X(v))), ...common }));
    });

    g.on('click tap', (e) => {
      if (tool !== 'select') return;
      e.cancelBubble = true;
      select({ kind: 'object', id: o.id });
    });
    g.on('dragend', () => {
      o.x = g.x(); o.y = g.y();
      selection = { kind: 'object', id: o.id };
      setTimeout(() => M.commit(), 0);
    });
    g.on('transformend', () => {
      o.rotation = Math.round(g.rotation());
      o.x = g.x(); o.y = g.y();
      setTimeout(() => M.commit(), 0);
    });
    return g;
  }

  // Esquinas arrastrables (solo con la herramienta Seleccionar)
  function renderHandles() {
    const L = layers.handles;
    L.destroyChildren();
    if (tool === 'select') {
      for (const id in M.project.nodes) {
        const n = M.project.nodes[id];
        const c = new Konva.Circle({
          x: n.x, y: n.y, radius: px(6), fill: '#ffffff', stroke: COLORS.selected,
          strokeWidth: px(2), hitStrokeWidth: px(22), draggable: true
        });
        c.on('dragmove', () => {
          const s = snap(c.position(), id, null);
          n.x = s.x; n.y = s.y;
          c.position({ x: s.x, y: s.y });
          renderMain();
        });
        c.on('dragend', () => {
          const other = M.nodeAt(n, px(3), id);
          if (other) M.mergeNodes(other, id);
          setTimeout(() => M.commit(), 0);
        });
        L.add(c);
      }
    } else if (chainLast && M.node(chainLast)) {
      const n = M.node(chainLast);
      L.add(new Konva.Circle({ x: n.x, y: n.y, radius: px(6), fill: COLORS.guide, listening: false }));
    }
    L.batchDraw();
  }

  // Vista previa del muro / línea de calibración
  function renderUi() {
    const L = layers.ui;
    L.destroyChildren();
    const from = tool === 'wall' && chainLast ? M.node(chainLast) : tool === 'calibrate' ? calibStart : null;
    if (from) L.add(new Konva.Circle({ x: from.x, y: from.y, radius: px(5), fill: COLORS.guide }));
    if (from && hover) {
      L.add(new Konva.Line({ points: [from.x, from.y, hover.x, hover.y], stroke: COLORS.guide, strokeWidth: px(2), dash: [px(6), px(5)] }));
      if (M.isMetric() && tool === 'wall') {
        L.add(new Konva.Text({
          x: (from.x + hover.x) / 2 + px(8), y: (from.y + hover.y) / 2 + px(8),
          text: `${fmt(Math.hypot(hover.x - from.x, hover.y - from.y))} m`, fontSize: px(12), fontStyle: 'bold', fill: '#b45309'
        }));
      }
    }
    if (hover && hover.kind !== 'free' && (tool === 'wall' || tool === 'calibrate')) {
      L.add(new Konva.Circle({ x: hover.x, y: hover.y, radius: px(8), stroke: COLORS.guide, strokeWidth: px(2) }));
    }
    L.batchDraw();
  }

  // ---------- panel de propiedades del elemento seleccionado ----------
  function field(label, key, value, step) {
    return `<label class="flex items-center gap-1.5 text-slate-300">${label}
      <input data-key="${key}" type="number" inputmode="decimal" step="${step}" value="${value}"
        class="w-20 bg-slate-800 border border-slate-600 rounded px-2 py-1 text-right font-bold text-emerald-400"></label>`;
  }
  const button = (label, act, cls) =>
    `<button data-act="${act}" class="px-2.5 py-1 rounded-lg border font-medium ${cls || 'bg-slate-800 border-slate-600 text-slate-200'}">${label}</button>`;
  const DELETE_BTN = button('Borrar', 'delete', 'bg-rose-500/20 border-rose-500/40 text-rose-300');

  function updatePanel() {
    const P = M.project;
    if (!selection || tool !== 'select') { panelEl.classList.add('hidden'); return; }
    const metric = M.isMetric();
    let html = '';
    let apply = null;   // (key, value) => cambios en el modelo
    let actions = {};

    if (selection.kind === 'wall') {
      const w = M.wall(selection.id);
      html = `<b class="text-sky-400">Muro</b>` +
        (metric ? field('Largo (m)', 'length', M.wallLength(w).toFixed(2), 0.05) : '') +
        field('Espesor (m)', 'thickness', w.thickness.toFixed(2), 0.05) + DELETE_BTN;
      apply = (key, v) => {
        if (key === 'length') M.setWallLength(w.id, v);
        if (key === 'thickness' && v > 0) w.thickness = v;
      };
    } else if (selection.kind === 'opening') {
      const o = P.openings.find(x => x.id === selection.id);
      html = `<b class="text-sky-400">${o.type === 'door' ? 'Puerta' : 'Ventana'}</b>` +
        field('Ancho (m)', 'width', o.width.toFixed(2), 0.05) +
        (o.type === 'door' ? button('Invertir', 'flip') : '') + DELETE_BTN;
      apply = (key, v) => { if (v > 0) { o.width = v; clampOpening(o); } };
      actions.flip = () => { o.flip = (o.flip + 1) % 4; };
    } else if (selection.kind === 'object') {
      const o = P.objects.find(x => x.id === selection.id);
      const def = LIB.objectType(o.type);
      html = `<b class="text-sky-400">${def ? def.name : 'Objeto'}</b>` +
        field('Ancho', 'w', o.w.toFixed(2), 0.05) + field('Prof.', 'd', o.d.toFixed(2), 0.05) +
        button('Rotar 90°', 'rotate') + button('Duplicar', 'duplicate') + DELETE_BTN;
      apply = (key, v) => { if (v > 0) o[key] = v; };
      actions.rotate = () => { o.rotation = (o.rotation + 90) % 360; };
      actions.duplicate = () => {
        const copy = Object.assign({}, o, { id: M.newId('f'), x: o.x + 0.3, y: o.y + 0.3 });
        P.objects.push(copy);
        selection = { kind: 'object', id: copy.id };
      };
    } else if (selection.kind === 'room') {
      const face = M.faces().find(f => M.pointInPoly(selection.point, f.poly));
      if (!face) { panelEl.classList.add('hidden'); return; }
      const current = face.label ? face.label.type : 'otro';
      const options = LIB.ROOM_TYPES.map(r => `<option value="${r.type}" ${r.type === current ? 'selected' : ''}>${r.name}</option>`).join('');
      html = `<b class="text-sky-400">Ambiente</b>` + (metric ? `<span class="text-emerald-400 font-bold">${fmt(face.area)} m²</span>` : '') +
        `<select data-room="type" class="bg-slate-800 border border-slate-600 rounded px-2 py-1 text-slate-100">${options}</select>
         <input data-room="name" type="text" value="${(face.label ? face.label.name : '').replace(/"/g, '&quot;')}" placeholder="Nombre"
           class="w-28 bg-slate-800 border border-slate-600 rounded px-2 py-1 text-slate-100">`;
      const ensureLabel = () => {
        if (face.label) return P.labels.find(l => l.id === face.label.id);
        const label = { id: M.newId('l'), x: selection.point.x, y: selection.point.y, type: 'otro', name: LIB.roomType('otro').name };
        P.labels.push(label);
        return label;
      };
      panelEl.innerHTML = html;
      panelEl.classList.remove('hidden');
      panelEl.querySelector('[data-room="type"]').addEventListener('change', (e) => {
        const label = ensureLabel();
        label.type = e.target.value;
        label.name = LIB.roomType(label.type).name;
        M.commit();
      });
      panelEl.querySelector('[data-room="name"]').addEventListener('change', (e) => {
        const label = ensureLabel();
        label.name = e.target.value.trim() || LIB.roomType(label.type).name;
        M.commit();
      });
      return;
    }

    panelEl.innerHTML = html;
    panelEl.classList.remove('hidden');
    panelEl.querySelectorAll('[data-key]').forEach(input => {
      input.addEventListener('change', () => {
        const v = num(input.value);
        if (!isNaN(v)) { apply(input.dataset.key, v); M.commit(); }
      });
    });
    panelEl.querySelectorAll('[data-act]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.dataset.act === 'delete') { E.deleteSelection(); return; }
        actions[btn.dataset.act]();
        M.commit();
      });
    });
  }

  // ---------- vista ----------
  E.viewCenter = () => ({ x: (stage.width() / 2 - stage.x()) / zoom(), y: (stage.height() / 2 - stage.y()) / zoom() });

  function contentBounds() {
    const P = M.project;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const add = (x, y) => { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); };
    for (const id in P.nodes) add(P.nodes[id].x, P.nodes[id].y);
    P.objects.forEach(o => { const r = Math.max(o.w, o.d) / 2; add(o.x - r, o.y - r); add(o.x + r, o.y + r); });
    if (P.plan && M.planImage) {
      const hw = (M.planImage.width * P.plan.mPerPx) / 2, hh = (M.planImage.height * P.plan.mPerPx) / 2;
      add(P.plan.x - hw, P.plan.y - hh); add(P.plan.x + hw, P.plan.y + hh);
    }
    return minX === Infinity ? null : { minX, maxX, minY, maxY };
  }

  E.fitView = () => {
    const b = contentBounds();
    if (!b || !stage.width()) return;
    const pad = 50;
    const spanX = Math.max(b.maxX - b.minX, 1e-6), spanY = Math.max(b.maxY - b.minY, 1e-6);
    let s = Math.min((stage.width() - pad * 2) / spanX, (stage.height() - pad * 2) / spanY);
    if (b.maxX - b.minX < 1e-6 && b.maxY - b.minY < 1e-6) s = zoom();
    s = clampZoom(s);
    stage.scale({ x: s, y: s });
    stage.position({
      x: stage.width() / 2 - ((b.minX + b.maxX) / 2) * s,
      y: stage.height() / 2 - ((b.minY + b.maxY) / 2) * s
    });
    render();
  };

  // Coloca una mensura encuadrada en la vista actual
  E.setPlanImage = (img, src) => {
    const P = M.project;
    M.planImage = img;
    M.planSrc = src;
    const c = E.viewCenter();
    P.plan = {
      x: c.x, y: c.y, calibrated: false,
      mPerPx: Math.min((stage.width() * 0.9) / img.width, (stage.height() * 0.9) / img.height) / zoom()
    };
    // Sin muros previos, lo que se dibuje se calca sobre la mensura y se reescala con ella
    P.geomFollowsPlan = P.walls.length === 0;
    M.commit();
  };

  E.removePlan = () => {
    M.project.plan = null;
    M.project.geomFollowsPlan = false;
    M.commit();
  };

  // Imagen del plano tal como se ve, sobre fondo blanco y sin controles de edición
  E.toPNG = () => {
    const prevSel = selection;
    selection = null;
    render();
    layers.handles.hide();
    const s = zoom();
    const bgRect = new Konva.Rect({ x: -stage.x() / s, y: -stage.y() / s, width: stage.width() / s, height: stage.height() / s, fill: '#ffffff' });
    layers.bg.add(bgRect);
    bgRect.moveToBottom();
    const url = stage.toDataURL({ pixelRatio: 3 });
    bgRect.destroy();
    layers.handles.show();
    selection = prevSel;
    render();
    return url;
  };

  SA.editor = E;
})();
