// Modelo único del inmueble: fuente de verdad para el editor 2D, el 3D y las exportaciones.
// Un proyecto tiene varios pisos; cada piso tiene sus muros, aberturas, objetos, ambientes y mensura.
// Coordenadas en metros, con Y hacia abajo (igual que la pantalla).
(function () {
  const SA = (window.SA = window.SA || {});
  const STORAGE_KEY = 'scanarch.project.v1';
  const DEFAULT_HEIGHT = 2.6;

  function emptyLevel(id, name, height) {
    return {
      id,
      name,
      height: height || DEFAULT_HEIGHT, // altura de muros del piso (m)
      nodes: {},        // { id: {x, y} } esquinas compartidas entre muros
      walls: [],        // [{id, a, b, thickness}] a/b = ids de nodo
      openings: [],     // [{id, type: 'door'|'window', wallId, t, width, flip}]
      objects: [],      // [{id, type, x, y, rotation, w, d, h}]
      labels: [],       // [{id, x, y, type, name}] etiqueta del ambiente que contiene el punto
      shapes: [],       // [{id, kind: 'lote'|'calle', points, name, width?}] trazados sobre la mensura
      plan: null,       // {x, y, mPerPx, calibrated} mensura de fondo
      geomFollowsPlan: false // el dibujo se calcó sobre la mensura: se reescala con ella
    };
  }

  function emptyProject() {
    return {
      version: 2,
      name: 'Inmueble',
      seq: 2,
      settings: { wallThickness: 0.15 },
      levels: [emptyLevel('L1', 'Planta baja')],
      active: 0
    };
  }

  const M = {
    project: emptyProject(),
    _planImages: {}, // { levelId: {img, src} } imágenes de mensura (fuera del historial)
    _history: [],
    _future: [],
    _listeners: []
  };

  // Piso activo: todas las operaciones de edición trabajan sobre él
  Object.defineProperty(M, 'level', { get: () => M.project.levels[M.project.active] });
  Object.defineProperty(M, 'planImage', {
    get: () => (M._planImages[M.level.id] || {}).img || null
  });
  Object.defineProperty(M, 'planSrc', {
    get: () => (M._planImages[M.level.id] || {}).src || null
  });
  M.setPlanImage = (img, src) => {
    if (img) M._planImages[M.level.id] = { img, src };
    else delete M._planImages[M.level.id];
  };

  // Ejecuta fn con otro piso como activo (para leer varios pisos sin cambiar la vista)
  M.withLevel = (index, fn) => {
    const prev = M.project.active;
    M.project.active = index;
    try { return fn(M.level); } finally { M.project.active = prev; }
  };

  // ---------- utilidades ----------
  M.newId = (prefix) => `${prefix}${M.project.seq++}`;
  M.node = (id) => M.level.nodes[id];
  M.wall = (id) => M.level.walls.find(w => w.id === id);

  M.wallLength = (w) => {
    const a = M.node(w.a), b = M.node(w.b);
    return Math.hypot(b.x - a.x, b.y - a.y);
  };

  M.addNode = (x, y) => {
    const id = M.newId('n');
    M.level.nodes[id] = { x, y };
    return id;
  };

  M.nodeAt = (pt, eps, excludeId) => {
    let best = null, bestD = eps;
    for (const id in M.level.nodes) {
      if (id === excludeId) continue;
      const n = M.level.nodes[id];
      const d = Math.hypot(n.x - pt.x, n.y - pt.y);
      if (d <= bestD) { best = id; bestD = d; }
    }
    return best;
  };

  // Muro más cercano a un punto: {wall, t, point, dist}
  M.wallNear = (pt, maxDist, excludeNodeId) => {
    let best = null;
    M.level.walls.forEach(w => {
      if (excludeNodeId && (w.a === excludeNodeId || w.b === excludeNodeId)) return;
      const a = M.node(w.a), b = M.node(w.b);
      const dx = b.x - a.x, dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      if (len2 === 0) return;
      const t = Math.max(0, Math.min(1, ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / len2));
      const point = { x: a.x + dx * t, y: a.y + dy * t };
      const dist = Math.hypot(pt.x - point.x, pt.y - point.y);
      if (dist <= maxDist && (!best || dist < best.dist)) best = { wall: w, t, point, dist };
    });
    return best;
  };

  M.wallBetween = (a, b) => M.level.walls.find(w => (w.a === a && w.b === b) || (w.a === b && w.b === a));

  // Parte un muro en dos insertando un nodo; reparte las aberturas entre ambas mitades
  M.splitWall = (wallId, pt) => {
    const w = M.wall(wallId);
    const a = M.node(w.a), b = M.node(w.b);
    const dx = b.x - a.x, dy = b.y - a.y;
    const ts = ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / (dx * dx + dy * dy);
    const nid = M.addNode(a.x + dx * ts, a.y + dy * ts);
    const second = { id: M.newId('w'), a: nid, b: w.b, thickness: w.thickness };
    w.b = nid;
    M.level.walls.push(second);
    M.level.openings.forEach(o => {
      if (o.wallId !== wallId) return;
      if (o.t <= ts) {
        o.t = ts > 0 ? o.t / ts : 0;
      } else {
        o.wallId = second.id;
        o.t = (o.t - ts) / (1 - ts);
      }
    });
    return nid;
  };

  // Convierte un punto en nodo: reutiliza una esquina, parte un muro o crea uno nuevo
  M.resolvePoint = (pt, eps) => {
    const nid = M.nodeAt(pt, eps);
    if (nid) return { id: nid, existed: true };
    const near = M.wallNear(pt, eps);
    if (near) return { id: M.splitWall(near.wall.id, near.point), existed: true };
    return { id: M.addNode(pt.x, pt.y), existed: false };
  };

  // Agrega un muro entre dos puntos (o ids de nodo). Se engancha a esquinas y muros
  // existentes y se parte en los cruces, de modo que los ambientes se detecten solos.
  M.addWall = (p1, p2, eps = 1e-6, thickness) => {
    const L = M.level;
    const A = typeof p1 === 'string' ? { id: p1, existed: true } : M.resolvePoint(p1, eps);
    const B = typeof p2 === 'string' ? { id: p2, existed: true } : M.resolvePoint(p2, eps);
    if (A.id === B.id) return { endId: B.id, endExisted: true, created: 0 };

    const a = M.node(A.id), b = M.node(B.id);
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const cuts = [{ t: 0, id: A.id }, { t: 1, id: B.id }];
    const hasCut = (id) => cuts.some(c => c.id === id);

    // Esquinas existentes que caen sobre el nuevo muro
    for (const id in L.nodes) {
      if (hasCut(id)) continue;
      const n = L.nodes[id];
      const t = ((n.x - a.x) * dx + (n.y - a.y) * dy) / len2;
      if (t <= 0 || t >= 1) continue;
      if (Math.hypot(n.x - (a.x + dx * t), n.y - (a.y + dy * t)) <= eps) cuts.push({ t, id });
    }

    // Cruces con otros muros
    L.walls.slice().forEach(w => {
      if (hasCut(w.a) || hasCut(w.b)) return;
      const wa = M.node(w.a), wb = M.node(w.b);
      const ex = wb.x - wa.x, ey = wb.y - wa.y;
      const denom = dx * ey - dy * ex;
      if (Math.abs(denom) < 1e-12) return;
      const s = ((wa.x - a.x) * ey - (wa.y - a.y) * ex) / denom;
      const u = ((wa.x - a.x) * dy - (wa.y - a.y) * dx) / denom;
      if (s <= 0 || s >= 1 || u <= 0 || u >= 1) return;
      const pt = { x: a.x + dx * s, y: a.y + dy * s };
      const near = M.nodeAt(pt, eps);
      const id = near || M.splitWall(w.id, pt);
      if (!hasCut(id)) cuts.push({ t: s, id });
    });

    cuts.sort((c1, c2) => c1.t - c2.t);
    let created = 0;
    for (let i = 0; i < cuts.length - 1; i++) {
      const n1 = cuts[i].id, n2 = cuts[i + 1].id;
      if (n1 === n2 || M.wallBetween(n1, n2)) continue;
      L.walls.push({ id: M.newId('w'), a: n1, b: n2, thickness: thickness || M.project.settings.wallThickness });
      created++;
    }
    return { endId: B.id, endExisted: B.existed, created };
  };

  M.cleanupNodes = () => {
    const used = new Set();
    M.level.walls.forEach(w => { used.add(w.a); used.add(w.b); });
    for (const id in M.level.nodes) if (!used.has(id)) delete M.level.nodes[id];
  };

  M.removeWall = (id) => {
    M.level.walls = M.level.walls.filter(w => w.id !== id);
    M.level.openings = M.level.openings.filter(o => o.wallId !== id);
    M.cleanupNodes();
  };

  M.removeOpening = (id) => { M.level.openings = M.level.openings.filter(o => o.id !== id); };
  M.removeObject = (id) => { M.level.objects = M.level.objects.filter(o => o.id !== id); };

  // Une dos esquinas (al soltar una sobre otra)
  M.mergeNodes = (keepId, dropId) => {
    const L = M.level;
    const seen = new Set();
    const removed = [];
    L.walls.forEach(w => {
      if (w.a === dropId) w.a = keepId;
      if (w.b === dropId) w.b = keepId;
    });
    L.walls = L.walls.filter(w => {
      const key = [w.a, w.b].sort().join('|');
      if (w.a === w.b || seen.has(key)) { removed.push(w.id); return false; }
      seen.add(key);
      return true;
    });
    L.openings = L.openings.filter(o => !removed.includes(o.wallId));
    delete L.nodes[dropId];
    M.cleanupNodes();
  };

  // Medida inteligente: fija el largo del muro moviendo su extremo final
  M.setWallLength = (wallId, length) => {
    const w = M.wall(wallId);
    const a = M.node(w.a), b = M.node(w.b);
    const cur = Math.hypot(b.x - a.x, b.y - a.y);
    if (!cur || !(length > 0)) return;
    b.x = a.x + ((b.x - a.x) / cur) * length;
    b.y = a.y + ((b.y - a.y) / cur) * length;
  };

  // Calibración: reescala la mensura del piso y, si corresponde, el dibujo calcado sobre ella
  M.scaleAll = (k, includeGeometry) => {
    const L = M.level;
    if (L.plan) {
      L.plan.x *= k; L.plan.y *= k; L.plan.mPerPx *= k;
      L.plan.calibrated = true;
    }
    if (includeGeometry) {
      for (const id in L.nodes) { L.nodes[id].x *= k; L.nodes[id].y *= k; }
      L.objects.forEach(o => { o.x *= k; o.y *= k; });
      L.labels.forEach(l => { l.x *= k; l.y *= k; });
      L.shapes.forEach(sh => {
        sh.points.forEach(p => { p.x *= k; p.y *= k; });
        if (sh.width) sh.width *= k;
      });
    }
  };

  // True cuando las medidas mostradas son metros reales
  M.isMetric = () => !(M.level.plan && !M.level.plan.calibrated && M.level.geomFollowsPlan);

  // ---------- pisos ----------
  const ORDINALS = ['Planta baja', '1° piso', '2° piso', '3° piso', '4° piso', '5° piso', '6° piso', '7° piso', '8° piso', '9° piso'];

  // Agrega un piso arriba de todo. Con copyWalls repite los muros y aberturas del piso activo.
  M.addLevel = (copyWalls) => {
    const P = M.project;
    const src = M.level;
    const level = emptyLevel(M.newId('L'), ORDINALS[P.levels.length] || `Piso ${P.levels.length}`, src.height);
    if (copyWalls) {
      const nodeMap = {}, wallMap = {};
      for (const id in src.nodes) {
        nodeMap[id] = M.newId('n');
        level.nodes[nodeMap[id]] = { x: src.nodes[id].x, y: src.nodes[id].y };
      }
      src.walls.forEach(w => {
        wallMap[w.id] = M.newId('w');
        level.walls.push({ id: wallMap[w.id], a: nodeMap[w.a], b: nodeMap[w.b], thickness: w.thickness });
      });
      src.openings.forEach(o => level.openings.push(Object.assign({}, o, { id: M.newId('o'), wallId: wallMap[o.wallId] })));
    }
    P.levels.push(level);
    P.active = P.levels.length - 1;
    M.commit();
  };

  M.removeLevel = (index) => {
    const P = M.project;
    if (P.levels.length <= 1) return false;
    delete M._planImages[P.levels[index].id];
    P.levels.splice(index, 1);
    P.active = Math.min(P.active, P.levels.length - 1);
    M.commit();
    return true;
  };

  M.renameLevel = (index, name) => {
    if (!name) return;
    M.project.levels[index].name = name;
    M.commit();
  };

  // Cambiar de piso no es una edición: no entra en el historial
  M.setActiveLevel = (index) => {
    if (index < 0 || index >= M.project.levels.length) return;
    M.project.active = index;
    M._notify();
  };

  // ---------- ambientes: caras cerradas del grafo de muros ----------
  function pointInPoly(pt, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  }
  M.pointInPoly = pointInPoly;

  M.faces = () => {
    const L = M.level;
    const adj = {};
    L.walls.forEach(w => {
      if (w.a === w.b) return;
      (adj[w.a] = adj[w.a] || []).push(w.b);
      (adj[w.b] = adj[w.b] || []).push(w.a);
    });
    for (const id in adj) {
      const n = L.nodes[id];
      adj[id] = [...new Set(adj[id])].sort((p, q) =>
        Math.atan2(L.nodes[p].y - n.y, L.nodes[p].x - n.x) - Math.atan2(L.nodes[q].y - n.y, L.nodes[q].x - n.x));
    }

    const visited = new Set();
    const faces = [];
    for (const u in adj) {
      for (const v of adj[u]) {
        if (visited.has(`${u}>${v}`)) continue;
        const ids = [];
        let a = u, b = v, guard = 0;
        do {
          visited.add(`${a}>${b}`);
          ids.push(a);
          const list = adj[b];
          const c = list[(list.indexOf(a) - 1 + list.length) % list.length];
          a = b; b = c;
        } while (!(a === u && b === v) && guard++ < 100000);

        const poly = ids.map(id => L.nodes[id]);
        let area2 = 0, cx = 0, cy = 0;
        for (let i = 0; i < poly.length; i++) {
          const p = poly[i], q = poly[(i + 1) % poly.length];
          const cross = p.x * q.y - q.x * p.y;
          area2 += cross;
          cx += (p.x + q.x) * cross;
          cy += (p.y + q.y) * cross;
        }
        // Área con signo positivo = cara interior (ambiente); la negativa es el contorno exterior
        if (area2 / 2 > 1e-9) {
          const face = {
            poly: poly.map(p => ({ x: p.x, y: p.y })),
            area: area2 / 2,
            centroid: { x: cx / (3 * area2), y: cy / (3 * area2) }
          };
          if (!pointInPoly(face.centroid, face.poly)) {
            // Ambiente en L o U: busco un punto que sí quede adentro
            const p0 = face.poly[0], p1 = face.poly[1], p2 = face.poly[2 % face.poly.length];
            face.centroid = { x: (p0.x + p1.x + p2.x) / 3, y: (p0.y + p1.y + p2.y) / 3 };
          }
          face.label = L.labels.find(l => pointInPoly(l, face.poly)) || null;
          faces.push(face);
        }
      }
    }
    return faces;
  };

  M.totalArea = () => M.faces().reduce((sum, f) => sum + f.area, 0);

  // Superficie de todos los pisos
  M.buildingArea = () => M.project.levels.reduce((sum, l, i) => sum + M.withLevel(i, () => M.totalArea()), 0);

  // ---------- historial, guardado y carga ----------
  M.on = (fn) => M._listeners.push(fn);
  M._notify = () => M._listeners.forEach(fn => fn());

  M.serialize = (withImages) => {
    const data = JSON.parse(JSON.stringify(M.project));
    if (withImages) {
      data.planImages = {};
      M.project.levels.forEach(l => {
        if (l.plan && M._planImages[l.id]) data.planImages[l.id] = M._planImages[l.id].src;
      });
    }
    return data;
  };

  function autosave() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(M.serialize(true)));
    } catch (e) {
      // Las imágenes de mensura pueden superar el cupo del navegador: guardo sin ellas
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(M.serialize(false))); } catch (e2) { /* sin almacenamiento */ }
    }
  }

  // Registrar un cambio terminado: historial + autoguardado + refresco de vistas
  M.commit = () => {
    M._history.push(JSON.stringify(M.project));
    if (M._history.length > 100) M._history.shift();
    M._future = [];
    autosave();
    M._notify();
  };

  M.canUndo = () => M._history.length > 1;

  M.undo = () => {
    if (M._history.length <= 1) return false;
    M._future.push(M._history.pop());
    M.project = JSON.parse(M._history[M._history.length - 1]);
    autosave();
    M._notify();
    return true;
  };

  M.redo = () => {
    if (!M._future.length) return false;
    const snap = M._future.pop();
    M._history.push(snap);
    M.project = JSON.parse(snap);
    autosave();
    M._notify();
    return true;
  };

  // Proyectos de la versión anterior (un solo piso) pasan a ser la planta baja
  function migrate(data) {
    if (data.version === 2) return data;
    const level = emptyLevel('L1', 'Planta baja', (data.settings && data.settings.wallHeight) || DEFAULT_HEIGHT);
    ['nodes', 'walls', 'openings', 'objects', 'labels', 'plan', 'geomFollowsPlan'].forEach(k => {
      if (data[k] !== undefined) level[k] = data[k];
    });
    return {
      version: 2,
      name: data.name || 'Inmueble',
      seq: Math.max(data.seq || 1, 2),
      settings: { wallThickness: (data.settings && data.settings.wallThickness) || 0.15 },
      levels: [level],
      active: 0,
      planImages: data.planImageSrc ? { L1: data.planImageSrc } : {}
    };
  }

  M.isProjectData = (data) => !!data && (
    (data.version === 2 && Array.isArray(data.levels) && data.levels.length > 0) ||
    (data.version === 1 && data.nodes && Array.isArray(data.walls))
  );

  const loadImage = (src) => new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });

  // Carga un proyecto (archivo .json o autoguardado). Devuelve una promesa.
  M.load = async (raw) => {
    const data = migrate(raw);
    const images = data.planImages || {};
    delete data.planImages;
    const base = emptyProject();
    const project = Object.assign(base, data);
    project.settings = Object.assign(emptyProject().settings, data.settings || {});
    project.levels = project.levels.map(l => Object.assign(emptyLevel(l.id, l.name, l.height), l));
    project.active = Math.min(Math.max(project.active || 0, 0), project.levels.length - 1);

    M._planImages = {};
    for (const level of project.levels) {
      const img = level.plan && images[level.id] ? await loadImage(images[level.id]) : null;
      if (img) M._planImages[level.id] = { img, src: images[level.id] };
      else level.plan = null; // sin imagen no tiene sentido conservar la ubicación de la mensura
    }
    M.project = project;
    M._history = [];
    M._future = [];
    M.commit();
  };

  M.reset = () => M.load(emptyProject());

  M.restoreAutosave = () => {
    let data = null;
    try { data = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch (e) { data = null; }
    return M.load(M.isProjectData(data) ? data : emptyProject());
  };

  SA.model = M;
})();
