// Modelo único del inmueble: fuente de verdad para el editor 2D, el 3D y las exportaciones.
// Coordenadas en metros, con Y hacia abajo (igual que la pantalla).
(function () {
  const SA = (window.SA = window.SA || {});
  const STORAGE_KEY = 'scanarch.project.v1';

  function emptyProject() {
    return {
      version: 1,
      name: 'Inmueble',
      seq: 1,
      nodes: {},        // { id: {x, y} } esquinas compartidas entre muros
      walls: [],        // [{id, a, b, thickness}] a/b = ids de nodo
      openings: [],     // [{id, type: 'door'|'window', wallId, t, width, flip}]
      objects: [],      // [{id, type, x, y, rotation, w, d, h}]
      labels: [],       // [{id, x, y, type, name}] etiqueta del ambiente que contiene el punto
      plan: null,       // {x, y, mPerPx, calibrated} mensura de fondo
      geomFollowsPlan: false, // el dibujo se calcó sobre la mensura: se reescala con ella
      settings: { wallHeight: 2.6, wallThickness: 0.15 }
    };
  }

  const M = {
    project: emptyProject(),
    planImage: null, // HTMLImageElement / canvas de la mensura (no entra en el historial)
    planSrc: null,   // dataURL para guardar el proyecto
    _history: [],
    _future: [],
    _listeners: []
  };

  // ---------- utilidades ----------
  M.newId = (prefix) => `${prefix}${M.project.seq++}`;
  M.node = (id) => M.project.nodes[id];
  M.wall = (id) => M.project.walls.find(w => w.id === id);

  M.wallLength = (w) => {
    const a = M.node(w.a), b = M.node(w.b);
    return Math.hypot(b.x - a.x, b.y - a.y);
  };

  M.addNode = (x, y) => {
    const id = M.newId('n');
    M.project.nodes[id] = { x, y };
    return id;
  };

  M.nodeAt = (pt, eps, excludeId) => {
    let best = null, bestD = eps;
    for (const id in M.project.nodes) {
      if (id === excludeId) continue;
      const n = M.project.nodes[id];
      const d = Math.hypot(n.x - pt.x, n.y - pt.y);
      if (d <= bestD) { best = id; bestD = d; }
    }
    return best;
  };

  // Muro más cercano a un punto: {wall, t, point, dist}
  M.wallNear = (pt, maxDist, excludeNodeId) => {
    let best = null;
    M.project.walls.forEach(w => {
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

  M.wallBetween = (a, b) => M.project.walls.find(w => (w.a === a && w.b === b) || (w.a === b && w.b === a));

  // Parte un muro en dos insertando un nodo; reparte las aberturas entre ambas mitades
  M.splitWall = (wallId, pt) => {
    const w = M.wall(wallId);
    const a = M.node(w.a), b = M.node(w.b);
    const dx = b.x - a.x, dy = b.y - a.y;
    const ts = ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / (dx * dx + dy * dy);
    const nid = M.addNode(a.x + dx * ts, a.y + dy * ts);
    const second = { id: M.newId('w'), a: nid, b: w.b, thickness: w.thickness };
    w.b = nid;
    M.project.walls.push(second);
    M.project.openings.forEach(o => {
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
  M.addWall = (p1, p2, eps = 1e-6) => {
    const A = typeof p1 === 'string' ? { id: p1, existed: true } : M.resolvePoint(p1, eps);
    const B = typeof p2 === 'string' ? { id: p2, existed: true } : M.resolvePoint(p2, eps);
    if (A.id === B.id) return { endId: B.id, endExisted: true, created: 0 };

    const a = M.node(A.id), b = M.node(B.id);
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const cuts = [{ t: 0, id: A.id }, { t: 1, id: B.id }];
    const hasCut = (id) => cuts.some(c => c.id === id);

    // Esquinas existentes que caen sobre el nuevo muro
    for (const id in M.project.nodes) {
      if (hasCut(id)) continue;
      const n = M.project.nodes[id];
      const t = ((n.x - a.x) * dx + (n.y - a.y) * dy) / len2;
      if (t <= 0 || t >= 1) continue;
      if (Math.hypot(n.x - (a.x + dx * t), n.y - (a.y + dy * t)) <= eps) cuts.push({ t, id });
    }

    // Cruces con otros muros
    M.project.walls.slice().forEach(w => {
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
      M.project.walls.push({ id: M.newId('w'), a: n1, b: n2, thickness: M.project.settings.wallThickness });
      created++;
    }
    return { endId: B.id, endExisted: B.existed, created };
  };

  M.cleanupNodes = () => {
    const used = new Set();
    M.project.walls.forEach(w => { used.add(w.a); used.add(w.b); });
    for (const id in M.project.nodes) if (!used.has(id)) delete M.project.nodes[id];
  };

  M.removeWall = (id) => {
    M.project.walls = M.project.walls.filter(w => w.id !== id);
    M.project.openings = M.project.openings.filter(o => o.wallId !== id);
    M.cleanupNodes();
  };

  M.removeOpening = (id) => { M.project.openings = M.project.openings.filter(o => o.id !== id); };
  M.removeObject = (id) => { M.project.objects = M.project.objects.filter(o => o.id !== id); };

  // Une dos esquinas (al soltar una sobre otra)
  M.mergeNodes = (keepId, dropId) => {
    const seen = new Set();
    const removed = [];
    M.project.walls.forEach(w => {
      if (w.a === dropId) w.a = keepId;
      if (w.b === dropId) w.b = keepId;
    });
    M.project.walls = M.project.walls.filter(w => {
      const key = [w.a, w.b].sort().join('|');
      if (w.a === w.b || seen.has(key)) { removed.push(w.id); return false; }
      seen.add(key);
      return true;
    });
    M.project.openings = M.project.openings.filter(o => !removed.includes(o.wallId));
    delete M.project.nodes[dropId];
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

  // Calibración: reescala la mensura y, si corresponde, todo el dibujo calcado sobre ella
  M.scaleAll = (k, includeGeometry) => {
    const P = M.project;
    if (P.plan) {
      P.plan.x *= k; P.plan.y *= k; P.plan.mPerPx *= k;
      P.plan.calibrated = true;
    }
    if (includeGeometry) {
      for (const id in P.nodes) { P.nodes[id].x *= k; P.nodes[id].y *= k; }
      P.objects.forEach(o => { o.x *= k; o.y *= k; });
      P.labels.forEach(l => { l.x *= k; l.y *= k; });
    }
  };

  // True cuando las medidas mostradas son metros reales
  M.isMetric = () => !(M.project.plan && !M.project.plan.calibrated && M.project.geomFollowsPlan);

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
    const P = M.project;
    const adj = {};
    P.walls.forEach(w => {
      if (w.a === w.b) return;
      (adj[w.a] = adj[w.a] || []).push(w.b);
      (adj[w.b] = adj[w.b] || []).push(w.a);
    });
    for (const id in adj) {
      const n = P.nodes[id];
      adj[id] = [...new Set(adj[id])].sort((p, q) =>
        Math.atan2(P.nodes[p].y - n.y, P.nodes[p].x - n.x) - Math.atan2(P.nodes[q].y - n.y, P.nodes[q].x - n.x));
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

        const poly = ids.map(id => P.nodes[id]);
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
          face.label = P.labels.find(l => pointInPoly(l, face.poly)) || null;
          faces.push(face);
        }
      }
    }
    return faces;
  };

  M.totalArea = () => M.faces().reduce((sum, f) => sum + f.area, 0);

  // ---------- historial, guardado y carga ----------
  M.on = (fn) => M._listeners.push(fn);
  M._notify = () => M._listeners.forEach(fn => fn());

  M.serialize = (withImage) => {
    const data = JSON.parse(JSON.stringify(M.project));
    if (withImage && M.project.plan && M.planSrc) data.planImageSrc = M.planSrc;
    return data;
  };

  function autosave() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(M.serialize(true)));
    } catch (e) {
      // La imagen de la mensura puede superar el cupo del navegador: guardo sin ella
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

  // Carga un proyecto (archivo .json o autoguardado). Devuelve una promesa.
  M.load = (data) => new Promise((resolve) => {
    const src = data.planImageSrc || null;
    const clean = Object.assign(emptyProject(), data);
    delete clean.planImageSrc;
    clean.settings = Object.assign(emptyProject().settings, data.settings || {});
    M.project = clean;
    M.planImage = null;
    M.planSrc = null;
    const finish = () => {
      if (M.project.plan && !M.planImage) M.project.plan = null;
      M._history = [];
      M._future = [];
      M.commit();
      resolve();
    };
    if (src && clean.plan) {
      const img = new Image();
      img.onload = () => { M.planImage = img; M.planSrc = src; finish(); };
      img.onerror = finish;
      img.src = src;
    } else {
      finish();
    }
  });

  M.reset = () => M.load(emptyProject());

  M.restoreAutosave = () => {
    let data = null;
    try { data = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch (e) { data = null; }
    return M.load(data && data.version === 1 ? data : emptyProject());
  };

  SA.model = M;
})();
