// Editor 2D sobre Konva: dibuja el modelo y traduce los gestos en cambios del modelo.
// El escenario está escalado en píxeles por metro, así todo se dibuja en medidas reales.
(function () {
  const SA = window.SA;
  const M = SA.model;
  const LIB = SA.library;

  const COLORS = { wall: '#1e293b', selected: '#0ea5e9', line: '#334155', dim: '#0369a1', guide: '#f59e0b', lot: '#dc2626', street: '#64748b' };

  function getThemeColors() {
    const s = (M.project && M.project.settings) || {};
    const theme = s.theme || 'realestate';
    if (theme === 'blackwhite') {
      return { wall: '#000000', selected: '#0ea5e9', line: '#000000', dim: '#334155', guide: '#f59e0b', lot: '#dc2626', street: '#64748b' };
    }
    if (theme === 'blueprint') {
      return { wall: '#1e3a8a', selected: '#38bdf8', line: '#1e40af', dim: '#0284c7', guide: '#f59e0b', lot: '#dc2626', street: '#64748b' };
    }
    if (theme === 'warm') {
      return { wall: '#451a03', selected: '#f59e0b', line: '#78350f', dim: '#b45309', guide: '#10b981', lot: '#dc2626', street: '#64748b' };
    }
    return { wall: s.wallColor || '#1e293b', selected: '#0ea5e9', line: '#334155', dim: s.dimColor || '#0369a1', guide: '#f59e0b', lot: '#dc2626', street: '#64748b' };
  }

  const TOUCH = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  const HINTS = {
    select: 'Tocá un elemento para editarlo. Arrastrá esquinas, muros, aberturas y objetos para moverlos.',
    wall: TOUCH
      ? 'Arrastrá el dedo para trazar un muro, o tocá esquina por esquina. Dos dedos: mover y zoom.'
      : 'Hacé clic en cada esquina del muro. Se engancha a esquinas y muros existentes (también para paredes internas).',
    room: 'Arrastrá en diagonal para dibujar un ambiente rectangular. Se engancha a lo ya dibujado.',
    door: 'Tocá sobre un muro para colocar una puerta. Después podés arrastrarla o cambiarle el ancho.',
    window: 'Tocá sobre un muro para colocar una ventana. Después podés arrastrarla o cambiarle el ancho.',
    object: 'Tocá el plano para colocar el objeto elegido.',
    calibrate: 'Tocá los dos extremos de una cota conocida de la mensura.',
    lote: 'Tocá cada vértice del lote sobre la mensura. Tocá el primero para cerrarlo.',
    calle: 'Tocá los puntos del eje de la calle. Tocá dos veces el último punto (o "Terminar") para cerrarla.',
    detect: 'Arrastrá un rectángulo sobre la planta de la mensura para detectar sus muros (o tocá para analizar toda la imagen).'
  };
  const DRAG_TOOLS = ['room', 'detect']; // herramientas donde arrastrar dibuja en vez de mover la vista

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
  let gesture = null;        // trazo en curso al arrastrar: {kind, start, cur, moved, screen}
  let draft = null;          // lote o calle en curso: {kind, points}
  let planNode = null, gridNode = null; // fondo, para ajustarlo al exportar

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
      if (!['wall', 'calibrate', 'lote', 'calle'].includes(tool)) return;
      const pos = stage.getRelativePointerPosition();
      hover = snap(pos, null, draft && draft.points.length ? draft.points[draft.points.length - 1] : chainLast ? M.node(chainLast) : null);
      renderUi();
    });
    stage.on('mouseleave', () => { hover = null; renderUi(); });

    // Dibujar arrastrando: muros con el dedo y ambientes rectangulares
    stage.on('mousedown touchstart', gestureStart);
    stage.on('mousemove touchmove', gestureMove);
    stage.on('mouseup touchend touchcancel', gestureEnd);

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

    let shownLevelId = null;
    M.on(() => {
      // Al cambiar de piso no se arrastra nada del piso anterior
      if (M.level.id !== shownLevelId) {
        shownLevelId = M.level.id;
        selection = null;
        lastDetection = null;
        chainLast = null;
        calibStart = null;
      }
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
  function snap(pos, excludeNodeId, fromPoint, excludePoint) {
    const r = px(14);
    // Vértices de lotes y calles (para que lotes vecinos compartan sus esquinas)
    let vertex = null, vertexD = r;
    (M.level.shapes || []).forEach(sh => sh.points.forEach(p => {
      if (p === excludePoint) return;
      const d = Math.hypot(p.x - pos.x, p.y - pos.y);
      if (d <= vertexD) { vertexD = d; vertex = p; }
    }));
    if (vertex) return { x: vertex.x, y: vertex.y, kind: 'node' };
    const nid = M.nodeAt(pos, r, excludeNodeId);
    if (nid) return { x: M.node(nid).x, y: M.node(nid).y, kind: 'node', id: nid };
    const near = M.wallNear(pos, r, excludeNodeId);
    if (near) {
      // Si el trazo viene casi en escuadra, cae sobre el muro manteniendo la horizontal/vertical
      if (fromPoint) {
        const a = M.node(near.wall.a), b = M.node(near.wall.b);
        const candidates = [];
        if (Math.abs(b.x - a.x) > 1e-9) {
          const t = (fromPoint.x - a.x) / (b.x - a.x);
          if (t >= 0 && t <= 1) candidates.push({ x: fromPoint.x, y: a.y + (b.y - a.y) * t });
        }
        if (Math.abs(b.y - a.y) > 1e-9) {
          const t = (fromPoint.y - a.y) / (b.y - a.y);
          if (t >= 0 && t <= 1) candidates.push({ x: a.x + (b.x - a.x) * t, y: fromPoint.y });
        }
        const best = candidates
          .map(c => ({ c, d: Math.hypot(c.x - pos.x, c.y - pos.y) }))
          .filter(o => o.d <= r)
          .sort((p1, p2) => p1.d - p2.d)[0];
        if (best) return { x: best.c.x, y: best.c.y, kind: 'wall' };
      }
      return { x: near.point.x, y: near.point.y, kind: 'wall' };
    }

    const p = { x: pos.x, y: pos.y, kind: 'free' };
    // Escuadra: un trazo casi horizontal o vertical se endereza solo
    if (fromPoint) {
      const dx = Math.abs(pos.x - fromPoint.x), dy = Math.abs(pos.y - fromPoint.y);
      if (dy <= dx * 0.07) { p.y = fromPoint.y; p.kind = 'axis'; }
      else if (dx <= dy * 0.07) { p.x = fromPoint.x; p.kind = 'axis'; }
    }
    // Alineación horizontal/vertical con el punto anterior y con otras esquinas
    const refs = fromPoint ? [fromPoint] : [];
    for (const id in M.level.nodes) if (id !== excludeNodeId) refs.push(M.level.nodes[id]);
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
    const P = M.level;

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
      finishWall(chainLast, s, eps);
      return;
    }

    if (tool === 'room') {
      flashHint('Arrastrá en diagonal para dibujar el ambiente.');
      return;
    }

    if (tool === 'detect') {
      runDetection(null, false);
      return;
    }

    if (tool === 'lote' || tool === 'calle') {
      const last = draft && draft.points.length ? draft.points[draft.points.length - 1] : null;
      const s = snap(pos, null, last);
      if (!draft) { draft = { kind: tool, points: [] }; selection = null; }
      const pts = draft.points;
      const screenDist = (p) => Math.hypot(s.x - p.x, s.y - p.y) * zoom();
      // Tocar el primer vértice cierra el lote; tocar de nuevo el último termina
      if ((tool === 'lote' && pts.length >= 3 && screenDist(pts[0]) < 18) || (last && screenDist(last) < 8)) {
        finishDraft();
        return;
      }
      pts.push({ x: s.x, y: s.y });
      render();
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
      anchorToWall(o);
      P.objects.push(o);
      E.setTool('select');
      selection = { kind: 'object', id: o.id };
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

  // ---------- lotes y calles ----------
  function finishDraft() {
    const d = draft;
    draft = null;
    if (!d) return;
    if (d.points.length < (d.kind === 'lote' ? 3 : 2)) { render(); return; }
    const L = M.level;
    const count = L.shapes.filter(s => s.kind === d.kind).length + 1;
    const shape = {
      id: M.newId('s'), kind: d.kind, points: d.points,
      name: d.kind === 'lote' ? `Lote ${count}` : `Calle ${count}`
    };
    if (d.kind === 'calle') shape.width = M.isMetric() ? 12 : px(40);
    L.shapes.push(shape);
    selection = { kind: 'shape', id: shape.id };
    M.commit();
  }

  // Texto legible sobre cualquier fondo (borde blanco alrededor de las letras)
  function haloText(attrs) {
    const t = new Konva.Text(Object.assign({ stroke: '#ffffff', strokeWidth: px(3), fillAfterStrokeEnabled: true, listening: false }, attrs));
    t.offsetX(t.width() / 2);
    t.offsetY(t.height() / 2);
    return t;
  }

  const uprightDeg = (dx, dy) => {
    let ang = Math.atan2(dy, dx);
    if (ang > Math.PI / 2 || ang <= -Math.PI / 2) ang += Math.PI;
    return (ang * 180) / Math.PI;
  };

  function renderShapes(L, metric) {
    M.level.shapes.forEach(sh => {
      M.normalizeArcs(sh);
      const isSel = selection && selection.kind === 'shape' && selection.id === sh.id;
      const path = M.shapePath(sh);
      const flat = path.flatMap(p => [p.x, p.y]);
      let node;
      if (sh.kind === 'calle') {
        node = new Konva.Line({
          points: flat, stroke: isSel ? COLORS.selected : COLORS.street, opacity: 0.45, strokeWidth: sh.width,
          lineCap: 'butt', lineJoin: 'round', hitStrokeWidth: Math.max(sh.width, px(20))
        });
        L.add(node);
        // Nombre sobre el lado más largo
        let best = M.edgeInfo(sh, 0);
        for (let i = 1; i < M.edgeCount(sh); i++) {
          const info = M.edgeInfo(sh, i);
          if (info.length > best.length) best = info;
        }
        L.add(haloText({
          x: best.mid.x, y: best.mid.y, rotation: uprightDeg(best.b.x - best.a.x, best.b.y - best.a.y),
          text: sh.name, fontSize: px(15), fontStyle: 'bold', fill: '#1e293b'
        }));
      } else {
        node = new Konva.Line({
          points: flat, closed: true, stroke: isSel ? COLORS.selected : COLORS.lot, strokeWidth: px(3),
          fill: 'rgba(220, 38, 38, 0.07)', hitStrokeWidth: px(16)
        });
        L.add(node);
        // Medida de cada lado por fuera del lote; en los curvos, desarrollo y radio
        if (metric) {
          for (let i = 0; i < M.edgeCount(sh); i++) {
            const info = M.edgeInfo(sh, i);
            if (info.length * zoom() < 40) continue;
            let nx = info.nx, ny = info.ny;
            if (M.pointInPoly({ x: info.mid.x + nx * px(4), y: info.mid.y + ny * px(4) }, path)) { nx = -nx; ny = -ny; }
            const text = info.radius ? `${fmt(info.length)} m\nR ${fmt(info.radius)}` : `${fmt(info.length)} m`;
            L.add(haloText({
              x: info.mid.x + nx * px(info.radius ? 18 : 12), y: info.mid.y + ny * px(info.radius ? 18 : 12),
              rotation: uprightDeg(info.b.x - info.a.x, info.b.y - info.a.y), align: 'center',
              text, fontSize: px(12), fontStyle: 'bold', fill: '#b91c1c'
            }));
          }
        }
        const c = path.reduce((acc, p) => ({ x: acc.x + p.x / path.length, y: acc.y + p.y / path.length }), { x: 0, y: 0 });
        L.add(haloText({
          x: c.x, y: c.y, align: 'center', lineHeight: 1.3,
          text: metric ? `${sh.name}\n${fmt(M.shapeArea(sh))} m²` : sh.name,
          fontSize: px(14), fontStyle: 'bold', fill: '#991b1b'
        }));
      }
      node.on('click tap', (e) => {
        if (tool !== 'select') return;
        e.cancelBubble = true;
        if (shapeScreenSize(sh) < 110) zoomToShape(sh);
        select({ kind: 'shape', id: sh.id });
      });
    });
  }

  // Cierra un tramo de muro y deja el muro nuevo seleccionado para poder ajustar su largo
  function finishWall(fromId, pt, eps) {
    const res = M.addWall(fromId, pt, eps);
    if (res.endId === fromId) { E.endChain(); return; } // tocar de nuevo el último punto termina el muro
    // Llegar a una esquina o muro existente termina el tramo
    chainLast = res.endExisted ? null : res.endId;
    selection = res.created ? { kind: 'wall', id: M.level.walls[M.level.walls.length - 1].id } : null;
    M.commit();
  }

  function addRectangle(p, q, eps) {
    if (Math.abs(q.x - p.x) < px(12) || Math.abs(q.y - p.y) < px(12)) return;
    const corners = [{ x: p.x, y: p.y }, { x: q.x, y: p.y }, { x: q.x, y: q.y }, { x: p.x, y: q.y }];
    corners.forEach((c, i) => M.addWall(c, corners[(i + 1) % 4], eps));
    M.commit();
  }

  // Apoya el objeto contra el muro cercano y lo orienta con el fondo hacia la pared
  function anchorToWall(o) {
    const def = LIB.objectType(o.type);
    if (!def || !def.anchor || !M.isMetric()) return;
    const near = M.wallNear(o, o.d / 2 + 0.35);
    if (!near || near.t <= 0 || near.t >= 1) return;
    let vx = o.x - near.point.x, vy = o.y - near.point.y;
    const dist = Math.hypot(vx, vy);
    if (dist < 1e-6) return;
    vx /= dist; vy /= dist;
    const off = near.wall.thickness / 2 + o.d / 2;
    o.x = near.point.x + vx * off;
    o.y = near.point.y + vy * off;
    o.rotation = Math.round((Math.atan2(-vx, vy) * 180) / Math.PI);
  }

  // ---------- trazo arrastrando ----------
  function gestureStart(e) {
    const touches = e.evt.touches;
    if (touches && touches.length > 1) { cancelGesture(); return; }
    if (!(DRAG_TOOLS.includes(tool) || (tool === 'wall' && touches))) return;
    const pos = stage.getRelativePointerPosition();
    if (!pos) return;
    stage.draggable(false);
    const from = tool === 'wall' && chainLast ? M.node(chainLast) : null;
    gesture = { kind: tool, start: snap(pos, null, from), cur: null, moved: false, screen: stage.getPointerPosition() };
  }

  function gestureMove(e) {
    if (!gesture) return;
    if (e.evt.touches && e.evt.touches.length > 1) { cancelGesture(); return; }
    const sp = stage.getPointerPosition();
    const pos = stage.getRelativePointerPosition();
    if (!sp || !pos) return;
    if (!gesture.moved && Math.hypot(sp.x - gesture.screen.x, sp.y - gesture.screen.y) < 8) return;
    gesture.moved = true;
    const from = gesture.kind === 'wall' ? (chainLast ? M.node(chainLast) : gesture.start) : null;
    gesture.cur = snap(pos, null, from);
    renderUi();
  }

  function gestureEnd() {
    if (!gesture) return;
    const g = gesture;
    gesture = null;
    stage.draggable(!DRAG_TOOLS.includes(tool));
    if (!g.moved || !g.cur) { renderUi(); return; }
    pinchedAt = Date.now(); // el mismo gesto no debe contar además como toque
    const eps = px(3);
    if (g.kind === 'wall') finishWall(chainLast || M.resolvePoint(g.start, eps).id, g.cur, eps);
    else if (g.kind === 'detect') runDetection({ a: g.start, b: g.cur }, false);
    else addRectangle(g.start, g.cur, eps);
    renderUi();
  }

  // ---------- detección automática de muros sobre la mensura ----------
  let lastDetection = null;

  function runDetection(region, thin) {
    if (!M.level.plan || !M.planImage) {
      flashHint('Primero importá la mensura de este piso desde el Menú.');
      return;
    }
    const res = SA.detect.run(region, { thin });
    if (res.error) {
      flashHint(res.error === 'small' ? 'El rectángulo es muy chico: abarcá toda la planta.' : 'No se pudo analizar la imagen.');
      return;
    }
    if (!res.segments.length) {
      flashHint('No se encontraron muros en esa zona. Probá con un rectángulo más ajustado a la planta.');
      return;
    }
    const before = M.level.walls.length;
    const eps = Math.max(px(3), res.joinTolerance);
    res.segments.forEach(s => M.addWall(s.p, s.q, eps, s.thickness));
    M.cleanupNodes();
    res.doors.forEach(d => {
      const near = M.wallNear(d.center, 0.3);
      if (!near) return;
      const o = { id: M.newId('o'), type: 'door', wallId: near.wall.id, t: near.t, width: d.width, flip: 0 };
      clampOpening(o);
      M.level.openings.push(o);
    });
    lastDetection = { region, thin, added: M.level.walls.length - before, rooms: M.faces().length };
    M.commit();
    selection = { kind: 'notice' };
    render();
  }

  function cancelGesture() {
    if (!gesture) return;
    gesture = null;
    stage.draggable(!DRAG_TOOLS.includes(tool));
    renderUi();
  }

  // Reescala a metros reales sin mover nada en pantalla
  E.calibrate = (k) => {
    M.scaleAll(k, M.level.geomFollowsPlan || !M.level.plan);
    const s = zoom() / k;
    stage.scale({ x: s, y: s });
    // Mensura recién calibrada y sin dibujo: el paso natural es detectar sus muros
    E.setTool(M.level.plan && M.level.walls.length === 0 ? 'detect' : 'select');
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
    if (selection && selection.kind === 'shape' && !(draft && draft.points.length)) {
      text = 'Agarrá cualquier lado y tirá para curvarlo. Tocá un lado: radio y vértices. Tocá un vértice para quitarlo.';
    }
    if (draft && draft.points.length) {
      text = draft.kind === 'lote'
        ? 'Tocá el siguiente vértice. Tocá el primero (o "Cerrar lote") para terminar.'
        : 'Tocá el siguiente punto del eje. "Terminar calle" la cierra.';
    }
    if (!M.isMetric()) text += ' — Mensura sin calibrar: las medidas aparecen al calibrar la escala.';
    hintEl.innerText = text;
    const drafting = draft && draft.points.length;
    finishBtn.innerText = drafting ? (draft.kind === 'lote' ? 'Cerrar lote' : 'Terminar calle') : 'Terminar muro';
    finishBtn.classList.toggle('hidden', !((tool === 'wall' && chainLast) || drafting));
  }

  // ---------- herramientas y selección ----------
  E.setTool = (t, objectType) => {
    E.endChain(true);
    tool = t;
    calibStart = null;
    hover = null;
    gesture = null;
    stage.draggable(!DRAG_TOOLS.includes(t)); // ahí arrastrar dibuja; la vista se mueve con dos dedos
    if (t === 'object') pendingObject = objectType;
    selection = null;
    if (E.onTool) E.onTool(t);
    render();
  };
  E.getTool = () => tool;

  // Termina el muro en curso y descarta una esquina suelta sin muros
  E.endChain = (silent) => {
    if (draft) { finishDraft(); return; }
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
    const P = M.level;
    if (selection.kind === 'wall') return !!M.wall(selection.id);
    if (selection.kind === 'opening') return P.openings.some(o => o.id === selection.id);
    if (selection.kind === 'object') return P.objects.some(o => o.id === selection.id);
    if (selection.kind === 'notice') return !!lastDetection;
    if (selection.kind === 'shape') return P.shapes.some(s => s.id === selection.id);
    return true;
  }

  E.deleteSelection = () => {
    if (!selection) return;
    if (selection.kind === 'wall') M.removeWall(selection.id);
    else if (selection.kind === 'opening') M.removeOpening(selection.id);
    else if (selection.kind === 'object') M.removeObject(selection.id);
    else if (selection.kind === 'shape') M.level.shapes = M.level.shapes.filter(s => s.id !== selection.id);
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
    const P = M.level;
    const settings = M.project.settings || {};
    layers.bg.destroyChildren();

    // Grilla de 1 metro (solo con medidas reales y si no queda demasiado densa)
    gridNode = null;
    planNode = null;
    if (M.isMetric()) {
      gridNode = new Konva.Shape({
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
      });
      layers.bg.add(gridNode);
    }

    // Piso de abajo como referencia, para alinear muros y escaleras
    const below = M.project.levels[M.project.active - 1];
    if (below) {
      below.walls.forEach(w => {
        const a = below.nodes[w.a], b = below.nodes[w.b];
        if (!a || !b) return;
        layers.bg.add(new Konva.Line({ points: [a.x, a.y, b.x, b.y], stroke: '#cbd5e1', strokeWidth: w.thickness, lineCap: 'square' }));
      });
    }

    if (P.plan && M.planImage && settings.planVisible !== false) {
      const w = M.planImage.width * P.plan.mPerPx;
      const h = M.planImage.height * P.plan.mPerPx;
      planNode = new Konva.Image({
        image: M.planImage, x: P.plan.x - w / 2, y: P.plan.y - h / 2, width: w, height: h,
        opacity: settings.planOpacity !== undefined ? settings.planOpacity : 0.6
      });
      layers.bg.add(planNode);
    }
    layers.bg.batchDraw();
  }

  function renderMain() {
    const P = M.level;
    const L = layers.main;
    const metric = M.isMetric();
    const selecting = tool === 'select';
    const settings = M.project.settings || {};
    const themeColors = getThemeColors();
    L.destroyChildren();

    // Ambientes detectados (caras cerradas entre muros). Sobre una mensura no la tapan:
    // los que no tienen nombre quedan invisibles y los nombrados, semitransparentes.
    const overPlan = !!(P.plan && M.planImage && settings.planVisible !== false);
    M.faces().forEach(face => {
      const rt = LIB.roomType(face.label ? face.label.type : 'otro');
      const isSel = selection && selection.kind === 'room' && M.pointInPoly(selection.point, face.poly);
      const visible = !overPlan || !!face.label;
      const shape = new Konva.Line({
        points: face.poly.flatMap(p => [p.x, p.y]), closed: true,
        fill: visible ? rt.color : 'rgba(0, 0, 0, 0.002)', opacity: overPlan ? 0.35 : 0.75,
        stroke: isSel ? themeColors.selected : null, strokeWidth: px(3)
      });
      shape.on('click tap', (e) => {
        if (tool !== 'select') return;
        e.cancelBubble = true;
        select({ kind: 'room', point: face.label ? { x: face.label.x, y: face.label.y } : stage.getRelativePointerPosition() });
      });
      L.add(shape);
      if (!visible) return;

      const name = face.label ? face.label.name : rt.name;
      // Superficie: se puede ocultar (global o por ambiente) o reemplazar por un texto manual
      const showM2 = settings.showM2 !== false && !(face.label && face.label.hideArea);
      let areaText = '';
      if (metric && showM2) areaText = `\n${face.label && face.label.customArea ? face.label.customArea : `${fmt(face.area)} m²`}`;
      const text = new Konva.Text({
        x: face.centroid.x, y: face.centroid.y, listening: false, align: 'center',
        text: `${name}${areaText}`,
        fontSize: px(12), fontStyle: 'bold', fill: '#0f172a', lineHeight: 1.25
      });
      text.offsetX(text.width() / 2);
      text.offsetY(text.height() / 2);
      L.add(text);
    });

    renderShapes(L, metric);

    // Muros
    P.walls.forEach(w => {
      const a = M.node(w.a), b = M.node(w.b);
      const isSel = selection && selection.kind === 'wall' && selection.id === w.id;
      const line = new Konva.Line({
        points: [a.x, a.y, b.x, b.y], stroke: isSel ? themeColors.selected : themeColors.wall,
        strokeWidth: w.thickness, lineCap: 'square', hitStrokeWidth: Math.max(w.thickness, px(24)),
        draggable: selecting
      });
      line.on('click tap', (e) => {
        if (tool !== 'select') return;
        e.cancelBubble = true;
        select({ kind: 'wall', id: w.id });
      });
      // Arrastrar un muro lo desplaza en paralelo; los muros vecinos se estiran con él
      let lastPos = null;
      line.on('dragstart', () => {
        lastPos = stage.getRelativePointerPosition();
        selection = { kind: 'wall', id: w.id };
        layers.handles.destroyChildren();
        line.moveTo(layers.handles);
      });
      line.on('dragmove', () => {
        const p = stage.getRelativePointerPosition();
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        if (!p || !lastPos || !len) return;
        const nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
        const d = (p.x - lastPos.x) * nx + (p.y - lastPos.y) * ny;
        a.x += nx * d; a.y += ny * d;
        b.x += nx * d; b.y += ny * d;
        lastPos = p;
        line.position({ x: 0, y: 0 });
        line.points([a.x, a.y, b.x, b.y]);
        renderMain();
      });
      line.on('dragend', () => setTimeout(() => M.commit(), 0));
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

    // Cotas de cada muro (se pueden ocultar; cada muro admite un texto de cota manual)
    if (metric && settings.showLinearM !== false) {
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
          text: w.customDim ? w.customDim : `${fmt(len)} m`, fontSize: px(11), fill: themeColors.dim,
          rotation: (ang * 180) / Math.PI, listening: false
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

  // Las aberturas se pueden tocar y arrastrar sin salir de las herramientas Puerta/Ventana
  const OPENING_TOOLS = ['select', 'door', 'window'];

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
      draggable: OPENING_TOOLS.includes(tool)
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
      if (!OPENING_TOOLS.includes(tool)) return;
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
      anchorToWall(o);
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

  const SHAPE_TOOLS = ['select', 'lote', 'calle'];

  // Etiqueta flotante junto al dedo mientras se curva un lado
  function showDragTag(pt, text) {
    const L = layers.ui;
    L.destroyChildren();
    if (text) {
      const t = new Konva.Text({ x: pt.x, y: pt.y - px(58), text, fontSize: px(14), fontStyle: 'bold', fill: '#b45309' });
      t.offsetX(t.width() / 2);
      L.add(new Konva.Rect({ x: pt.x - t.width() / 2 - px(6), y: pt.y - px(62), width: t.width() + px(12), height: t.height() + px(8), fill: '#fffbeb', stroke: COLORS.guide, strokeWidth: px(1), cornerRadius: px(4) }));
      L.add(t);
    }
    L.batchDraw();
  }

  function renderShapeHandles(L, sh) {
    M.normalizeArcs(sh);
    const n = M.edgeCount(sh);
    const infos = [];
    for (let i = 0; i < n; i++) infos.push(M.edgeInfo(sh, i));
    const screenLen = (info) => info.length * zoom();
    const interactive = (handler) => (e) => {
      if (tool !== 'select') return; // con Lote/Calle los toques siguen dibujando; solo se arrastra
      e.cancelBubble = true;
      handler();
    };

    // 1) Cada lado completo es su propia manija: se agarra en cualquier punto y se tira para curvarlo
    infos.forEach((info, i) => {
      const isSeg = selection.seg === i;
      const edge = new Konva.Line({
        points: info.pts.flatMap(p => [p.x, p.y]), lineCap: 'round', lineJoin: 'round', draggable: true,
        stroke: isSeg ? COLORS.selected : 'rgba(0, 0, 0, 0)', strokeWidth: px(5),
        hitStrokeWidth: px(Math.max(12, Math.min(30, screenLen(info) * 0.6)))
      });
      edge.on('dragstart', () => { selection = { kind: 'shape', id: sh.id, seg: i }; });
      edge.on('dragmove', () => {
        const p = stage.getRelativePointerPosition();
        if (!p) return;
        let h = M.sagittaThrough(sh, i, p);
        if (Math.abs(h) * zoom() < 7) h = 0; // cerca de la recta vuelve a ser recto
        sh.arcs[i] = h;
        const cur = M.edgeInfo(sh, i);
        edge.position({ x: 0, y: 0 });
        edge.points(cur.pts.flatMap(q => [q.x, q.y]));
        edge.stroke(COLORS.selected);
        marks[i].position(cur.mid);
        renderMain();
        showDragTag(p, !M.isMetric() ? '' : cur.radius ? `R ${fmt(cur.radius)} m · ${fmt(cur.length)} m` : `recto · ${fmt(cur.length)} m`);
      });
      edge.on('dragend', () => { layers.ui.destroyChildren(); setTimeout(() => M.commit(), 0); });
      edge.on('click tap', interactive(() => select({ kind: 'shape', id: sh.id, seg: i })));
      L.add(edge);
    });

    // 2) Rombo: solo marca el medio de cada lado (la manija es el lado entero)
    const marks = infos.map((info, i) => {
      const size = Math.max(6, Math.min(12, screenLen(info) * 0.22));
      const m = new Konva.Rect({
        x: info.mid.x, y: info.mid.y, width: px(size), height: px(size), offsetX: px(size / 2), offsetY: px(size / 2), rotation: 45,
        fill: selection.seg === i ? COLORS.selected : '#fbbf24', stroke: '#92400e', strokeWidth: px(1.2), listening: false
      });
      L.add(m);
      return m;
    });

    // 3) Vértices, por encima. Su zona sensible se achica en lotes chicos para no tapar los lados.
    sh.points.forEach((p, idx) => {
      const adjacent = [];
      if (sh.kind === 'lote' || idx > 0) adjacent.push(infos[(idx - 1 + n) % n]);
      if (sh.kind === 'lote' || idx < sh.points.length - 1) adjacent.push(infos[idx % n]);
      const shortest = Math.min(...adjacent.map(screenLen));
      const reach = Math.max(7, Math.min(20, shortest * 0.28)); // radio sensible en px
      const radius = Math.min(7, reach);
      const isVertex = selection.vertex === idx;
      const c = new Konva.Circle({
        x: p.x, y: p.y, radius: px(radius), fill: isVertex ? COLORS.selected : '#ffffff', stroke: COLORS.lot,
        strokeWidth: px(2.5), hitStrokeWidth: px(Math.max(0, (reach - radius) * 2)), draggable: true
      });
      c.on('dragmove', () => {
        const s = snap(c.position(), null, null, p);
        p.x = s.x; p.y = s.y;
        c.position({ x: s.x, y: s.y });
        infos.forEach((_, i) => {
          const cur = M.edgeInfo(sh, i);
          marks[i].position(cur.mid);
        });
        renderMain();
      });
      c.on('dragend', () => setTimeout(() => M.commit(), 0));
      c.on('click tap', interactive(() => select({ kind: 'shape', id: sh.id, vertex: idx })));
      L.add(c);
    });
  }

  // Acerca la vista a un lote o calle para poder editarlo con comodidad
  function zoomToShape(sh) {
    const pts = M.shapePath(sh);
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const span = Math.max(maxX - minX, maxY - minY, 1e-6);
    const s = clampZoom((Math.min(stage.width(), stage.height()) * 0.5) / span);
    stage.scale({ x: s, y: s });
    stage.position({ x: stage.width() / 2 - ((minX + maxX) / 2) * s, y: stage.height() / 2 - ((minY + maxY) / 2) * s });
  }

  function shapeScreenSize(sh) {
    const pts = M.shapePath(sh);
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) * zoom();
  }

  // Esquinas arrastrables (solo con la herramienta Seleccionar)
  function renderHandles() {
    const L = layers.handles;
    L.destroyChildren();
    if (tool === 'select') {
      for (const id in M.level.nodes) {
        const n = M.level.nodes[id];
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
    }
    // Lote o calle seleccionado: sus lados se curvan arrastrándolos y sus vértices se mueven.
    // También mientras se usan las herramientas Lote y Calle, para retocar sin cambiar de herramienta.
    const shapeEditing = SHAPE_TOOLS.includes(tool) && selection && selection.kind === 'shape' && !(draft && draft.points.length);
    if (shapeEditing) {
      const sh = M.level.shapes.find(s => s.id === selection.id);
      if (sh) renderShapeHandles(L, sh);
    }
    if (!shapeEditing && chainLast && M.node(chainLast)) {
      const n = M.node(chainLast);
      L.add(new Konva.Circle({ x: n.x, y: n.y, radius: px(6), fill: COLORS.guide, listening: false }));
    }
    L.batchDraw();
  }

  // Vista previa del muro / línea de calibración
  function renderUi() {
    const L = layers.ui;
    L.destroyChildren();
    const dragging = gesture && gesture.moved && gesture.cur;
    const label = (x, y, text) => {
      const t = new Konva.Text({ x, y, text, fontSize: px(14), fontStyle: 'bold', fill: '#b45309' });
      t.offsetX(t.width() / 2);
      L.add(new Konva.Rect({ x: x - t.width() / 2 - px(5), y: y - px(3), width: t.width() + px(10), height: t.height() + px(6), fill: '#fffbeb', stroke: COLORS.guide, strokeWidth: px(1), cornerRadius: px(4) }));
      L.add(t);
    };

    if (dragging && (gesture.kind === 'room' || gesture.kind === 'detect')) {
      const p = gesture.start, q = gesture.cur;
      const isDetect = gesture.kind === 'detect';
      L.add(new Konva.Rect({
        x: Math.min(p.x, q.x), y: Math.min(p.y, q.y), width: Math.abs(q.x - p.x), height: Math.abs(q.y - p.y),
        stroke: isDetect ? COLORS.selected : COLORS.guide, strokeWidth: px(2), dash: [px(6), px(5)],
        fill: isDetect ? 'rgba(14, 165, 233, 0.08)' : 'rgba(245, 158, 11, 0.08)'
      }));
      if (M.isMetric() && !isDetect) label((p.x + q.x) / 2, Math.min(p.y, q.y) - px(30), `${fmt(Math.abs(q.x - p.x))} × ${fmt(Math.abs(q.y - p.y))} m`);
      L.batchDraw();
      return;
    }

    if (draft && draft.points.length) {
      const all = hover ? [...draft.points, hover] : draft.points.slice();
      const flat = all.flatMap(p => [p.x, p.y]);
      if (draft.kind === 'calle' && all.length >= 2) {
        L.add(new Konva.Line({ points: flat, stroke: COLORS.street, opacity: 0.3, strokeWidth: M.isMetric() ? 12 : px(40), lineJoin: 'round' }));
      }
      L.add(new Konva.Line({ points: flat, stroke: draft.kind === 'lote' ? COLORS.lot : '#334155', strokeWidth: px(2.5), dash: [px(7), px(5)] }));
      draft.points.forEach((p, i) => L.add(new Konva.Circle({ x: p.x, y: p.y, radius: px(i === 0 ? 7 : 5), fill: draft.kind === 'lote' ? COLORS.lot : '#334155' })));
      const last = draft.points[draft.points.length - 1];
      if (hover && M.isMetric()) label((last.x + hover.x) / 2, (last.y + hover.y) / 2 + px(10), `${fmt(Math.hypot(hover.x - last.x, hover.y - last.y))} m`);
      L.batchDraw();
      return;
    }

    let from = tool === 'wall' && chainLast ? M.node(chainLast) : tool === 'calibrate' ? calibStart : null;
    let to = hover;
    if (dragging && gesture.kind === 'wall') {
      from = chainLast ? M.node(chainLast) : gesture.start;
      to = gesture.cur;
    }
    if (from) L.add(new Konva.Circle({ x: from.x, y: from.y, radius: px(5), fill: COLORS.guide }));
    if (from && to) {
      L.add(new Konva.Line({ points: [from.x, from.y, to.x, to.y], stroke: COLORS.guide, strokeWidth: px(2), dash: [px(6), px(5)] }));
      if (M.isMetric() && tool === 'wall') {
        // Con el dedo, la medida va arriba para que la mano no la tape
        const text = `${fmt(Math.hypot(to.x - from.x, to.y - from.y))} m`;
        if (dragging) label(to.x, to.y - px(62), text);
        else label((from.x + to.x) / 2, (from.y + to.y) / 2 + px(10), text);
      }
    }
    if (to && (dragging || to.kind !== 'free') && (tool === 'wall' || tool === 'calibrate')) {
      L.add(new Konva.Circle({ x: to.x, y: to.y, radius: px(8), stroke: COLORS.guide, strokeWidth: px(2) }));
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
    const P = M.level;
    if (!selection) { panelEl.classList.add('hidden'); return; }
    const metric = M.isMetric();
    let html = '';
    let apply = null;   // (key, value) => cambios en el modelo
    let actions = {};

    if (selection.kind === 'notice') {
      const d = lastDetection;
      html = `<b class="text-sky-400">Detección</b><span class="text-slate-200">${d.added} muros nuevos · ${d.rooms} ambientes</span>` +
        (d.thin ? '' : button('Incluir líneas finas', 'thin')) +
        button('Deshacer', 'undo', 'bg-amber-500/20 border-amber-500/40 text-amber-200') +
        button('Listo', 'done', 'bg-emerald-500/20 border-emerald-500/40 text-emerald-200');
      panelEl.innerHTML = html;
      panelEl.classList.remove('hidden');
      panelEl.querySelectorAll('[data-act]').forEach(btn => btn.addEventListener('click', () => {
        const act = btn.dataset.act;
        lastDetection = null;
        selection = null;
        if (act === 'undo' || act === 'thin') M.undo();
        if (act === 'thin') runDetection(d.region, true);
        else render();
      }));
      return;
    }

    let textApply = null; // (key, texto) => cambios en el modelo

    if (selection.kind === 'shape' && selection.vertex !== undefined) {
      const sh = P.shapes.find(s => s.id === selection.id);
      const idx = selection.vertex;
      if (idx >= sh.points.length) { selection = { kind: 'shape', id: sh.id }; updatePanel(); return; }
      const min = sh.kind === 'lote' ? 3 : 2;
      html = `<b class="text-sky-400">Vértice ${idx + 1}</b><span class="text-slate-300">Arrastralo para moverlo.</span>` +
        (sh.points.length > min ? button('Quitar vértice', 'remove', 'bg-rose-500/20 border-rose-500/40 text-rose-300') : `<span class="text-slate-400">No se puede quitar: es el mínimo.</span>`) +
        button('Listo', 'back', 'bg-emerald-500/20 border-emerald-500/40 text-emerald-200');
      actions.remove = () => { M.removeShapeVertex(sh, idx); selection = { kind: 'shape', id: sh.id }; };
      actions.back = () => { selection = { kind: 'shape', id: sh.id }; return false; };
    } else if (selection.kind === 'shape' && selection.seg !== undefined) {
      const sh = P.shapes.find(s => s.id === selection.id);
      const i = selection.seg;
      if (i >= M.edgeCount(sh)) { selection = { kind: 'shape', id: sh.id }; updatePanel(); return; }
      M.normalizeArcs(sh);
      const info = M.edgeInfo(sh, i);
      // Hacia afuera del lote por defecto (como una ochava o un frente curvo)
      let outward = 1;
      if (sh.kind === 'lote' && M.pointInPoly({ x: (info.a.x + info.b.x) / 2 + info.nx * 0.01, y: (info.a.y + info.b.y) / 2 + info.ny * 0.01 }, M.shapePath(Object.assign({}, sh, { arcs: sh.arcs.map(() => 0) })))) outward = -1;
      html = `<b class="text-sky-400">Lado ${i + 1}</b>` +
        (metric ? `<span class="text-slate-300">cuerda ${fmt(info.chord)} m${info.radius ? ` · desarrollo ${fmt(info.length)} m` : ''}</span>` : '') +
        (metric ? field('Radio (m)', 'radius', info.radius ? info.radius.toFixed(2) : '', 0.5) : '') +
        button(info.radius ? 'Invertir curva' : 'Curvar', 'curve') +
        (info.radius ? button('Recto', 'straight') : '') +
        button('Agregar vértice', 'vertex') +
        button('Listo', 'back', 'bg-emerald-500/20 border-emerald-500/40 text-emerald-200');
      apply = (key, v) => {
        if (key === 'radius' && v > 0) sh.arcs[i] = M.sagittaForRadius(info.chord, v, Math.sign(info.h) || outward);
      };
      actions.curve = () => { sh.arcs[i] = info.h ? -info.h : M.sagittaForRadius(info.chord, info.chord, outward); };
      actions.straight = () => { sh.arcs[i] = 0; };
      actions.vertex = () => { M.insertShapeVertex(sh, i); selection = { kind: 'shape', id: sh.id }; };
      actions.back = () => { selection = { kind: 'shape', id: sh.id }; return false; };
    } else if (selection.kind === 'shape') {
      const sh = P.shapes.find(s => s.id === selection.id);
      const isLote = sh.kind === 'lote';
      html = `<b class="text-sky-400">${isLote ? 'Lote' : 'Calle'}</b>
        <input data-text="name" type="text" value="${sh.name.replace(/"/g, '&quot;')}"
          class="w-32 bg-slate-800 border border-slate-600 rounded px-2 py-1 text-slate-100">` +
        (isLote && metric ? `<span class="text-emerald-400 font-bold">${fmt(M.shapeArea(sh))} m²</span>` : '') +
        (!isLote && metric ? field('Ancho (m)', 'width', sh.width.toFixed(2), 0.5) : '') +
        button('Acercar', 'zoom') + DELETE_BTN;
      actions.zoom = () => { zoomToShape(sh); return false; };
      apply = (key, v) => { if (key === 'width' && v > 0) sh.width = v; };
      textApply = (key, value) => { if (value) sh.name = value; };
    } else if (selection.kind === 'wall') {
      const w = M.wall(selection.id);
      html = `<b class="text-sky-400">Muro</b>` +
        (metric ? field('Largo (m)', 'length', M.wallLength(w).toFixed(2), 0.05) : '') +
        field('Espesor (m)', 'thickness', w.thickness.toFixed(2), 0.05) +
        `<label class="flex items-center gap-1.5 text-slate-300 text-xs">Cota manual
          <input data-text="customDim" type="text" value="${(w.customDim || '').replace(/"/g, '&quot;')}" placeholder="ej: 5.20 m"
            class="w-24 bg-slate-800 border border-slate-600 rounded px-2 py-1 text-slate-100 font-mono text-xs"></label>` +
        DELETE_BTN;
      apply = (key, v) => {
        if (key === 'length') M.setWallLength(w.id, v);
        if (key === 'thickness' && v > 0) w.thickness = v;
      };
      textApply = (key, value) => {
        if (key === 'customDim') w.customDim = value;
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
      const lbl = face.label || {};
      html = `<b class="text-sky-400">Ambiente</b>` + (metric ? `<span class="text-emerald-400 font-bold">${fmt(face.area)} m²</span>` : '') +
        `<select data-room="type" class="bg-slate-800 border border-slate-600 rounded px-2 py-1 text-slate-100">${options}</select>
         <input data-room="name" type="text" value="${(lbl.name || '').replace(/"/g, '&quot;')}" placeholder="Nombre"
           class="w-28 bg-slate-800 border border-slate-600 rounded px-2 py-1 text-slate-100">
         <input data-room="customArea" type="text" value="${(lbl.customArea || '').replace(/"/g, '&quot;')}" placeholder="m² manual (ej: 18.5 m²)"
           class="w-36 bg-slate-800 border border-slate-600 rounded px-2 py-1 text-slate-100 text-xs">
         <label class="flex items-center gap-1.5 text-slate-300 text-xs cursor-pointer">
           <input data-room="hideArea" type="checkbox" ${lbl.hideArea ? 'checked' : ''} class="rounded bg-slate-800 border-slate-600 text-emerald-500">
           <span>Ocultar m²</span>
         </label>`;
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
      panelEl.querySelector('[data-room="customArea"]').addEventListener('change', (e) => {
        const label = ensureLabel();
        label.customArea = e.target.value.trim();
        M.commit();
      });
      panelEl.querySelector('[data-room="hideArea"]').addEventListener('change', (e) => {
        const label = ensureLabel();
        label.hideArea = e.target.checked;
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
    panelEl.querySelectorAll('[data-text]').forEach(input => {
      input.addEventListener('change', () => { textApply(input.dataset.text, input.value.trim()); M.commit(); });
    });
    panelEl.querySelectorAll('[data-act]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.dataset.act === 'delete') { E.deleteSelection(); return; }
        if (actions[btn.dataset.act]() === false) render();
        else M.commit();
      });
    });
  }

  // ---------- vista ----------
  E.viewCenter = () => ({ x: (stage.width() / 2 - stage.x()) / zoom(), y: (stage.height() / 2 - stage.y()) / zoom() });

  function contentBounds() {
    const P = M.level;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const add = (x, y) => { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); };
    for (const id in P.nodes) add(P.nodes[id].x, P.nodes[id].y);
    P.objects.forEach(o => { const r = Math.max(o.w, o.d) / 2; add(o.x - r, o.y - r); add(o.x + r, o.y + r); });
    P.shapes.forEach(sh => M.shapePath(sh).forEach(p => add(p.x, p.y)));
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
    const P = M.level;
    M.setPlanImage(img, src);
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
    M.level.plan = null;
    M.level.geomFollowsPlan = false;
    M.commit();
  };

  // Imagen para exportar. Con mensura: la imagen completa en su resolución original, con lo
  // dibujado encima y sin fondo agregado. Sin mensura: el dibujo completo sobre fondo blanco.
  E.toPNG = () => {
    const P = M.level;
    const b = contentBounds();
    if (!b) return null;
    const saved = { scale: zoom(), x: stage.x(), y: stage.y() };
    const prevSel = selection;
    selection = null;

    // Encuadro lo que se exporta para que textos y trazos queden proporcionados
    const withPlan = !!(P.plan && M.planImage && (M.project.settings || {}).planVisible !== false);
    let area;
    if (withPlan) {
      const w = M.planImage.width * P.plan.mPerPx, h = M.planImage.height * P.plan.mPerPx;
      area = { minX: P.plan.x - w / 2, minY: P.plan.y - h / 2, maxX: P.plan.x + w / 2, maxY: P.plan.y + h / 2 };
    } else {
      const m = Math.max(b.maxX - b.minX, b.maxY - b.minY) * 0.06;
      area = { minX: b.minX - m, minY: b.minY - m, maxX: b.maxX + m, maxY: b.maxY + m };
    }
    const spanX = area.maxX - area.minX, spanY = area.maxY - area.minY;
    const s = Math.min(stage.width() / spanX, stage.height() / spanY);
    stage.scale({ x: s, y: s });
    stage.position({ x: -area.minX * s, y: -area.minY * s });
    render();
    layers.handles.hide();
    layers.ui.hide();
    if (gridNode) gridNode.hide();
    if (planNode) planNode.opacity(1);
    let bgRect = null;
    if (!withPlan) {
      bgRect = new Konva.Rect({ x: area.minX, y: area.minY, width: spanX, height: spanY, fill: '#ffffff' });
      layers.bg.add(bgRect);
      bgRect.moveToBottom();
    }

    const pixelRatio = withPlan
      ? Math.min(M.planImage.width / (spanX * s), 8000 / (Math.max(spanX, spanY) * s))
      : Math.min(4, 4000 / (Math.max(spanX, spanY) * s));
    const url = stage.toDataURL({ x: 0, y: 0, width: spanX * s, height: spanY * s, pixelRatio });

    if (bgRect) bgRect.destroy();
    layers.handles.show();
    layers.ui.show();
    stage.scale({ x: saved.scale, y: saved.scale });
    stage.position({ x: saved.x, y: saved.y });
    selection = prevSel;
    render();
    return url;
  };

  SA.editor = E;
})();
