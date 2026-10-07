// Entradas y salidas: mensura (imagen / PDF / DXF), archivo de proyecto y exportaciones.
(function () {
  const SA = window.SA;
  const M = SA.model;

  const X = {};

  function download(content, filename, mimeType) {
    const blob = content instanceof Blob ? content : new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const baseName = () => (M.project.name || 'inmueble').trim().toLowerCase().replace(/[^a-z0-9áéíóúñ]+/gi, '-') || 'inmueble';
  const hasWalls = () => {
    if (M.project.levels.some(l => l.walls.length)) return true;
    alert('Primero dibujá al menos un muro.');
    return false;
  };

  // ---------- proyecto ----------
  X.saveProject = () => {
    download(JSON.stringify(M.serialize(true)), `${baseName()}.plano.json`, 'application/json');
  };

  X.openProject = async (file) => {
    try {
      const data = JSON.parse(await file.text());
      if (!M.isProjectData(data)) throw new Error('formato');
      await M.load(data);
      return true;
    } catch (err) {
      alert('No se pudo abrir el archivo. Tiene que ser un proyecto .plano.json guardado desde esta app.');
      return false;
    }
  };

  // ---------- mensura ----------
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  const readAsDataURL = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

  // Devuelve 'image' | 'dxf' | null según lo importado
  X.importPlan = async (file) => {
    const name = file.name.toLowerCase();
    try {
      if (name.endsWith('.dxf')) {
        const dxf = new window.DxfParser().parseSync(await file.text());
        return importDxf(dxf) ? 'dxf' : null;
      }
      let src;
      if (name.endsWith('.pdf')) {
        const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
        const page = await pdf.getPage(1);
        const viewport = page.getViewport({ scale: 2 });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        src = canvas.toDataURL('image/jpeg', 0.85);
      } else if (file.type.startsWith('image/')) {
        src = await readAsDataURL(file);
      } else {
        alert('Formato no soportado. Usá una imagen, un PDF o un DXF.');
        return null;
      }
      SA.editor.setPlanImage(await loadImage(src), src);
      return 'image';
    } catch (err) {
      console.error(err);
      alert('No se pudo leer el archivo de mensura.');
      return null;
    }
  };

  // DXF: cada línea pasa a ser un muro (las unidades del archivo se toman como metros)
  function importDxf(dxf) {
    if (!dxf || !dxf.entities) return false;
    const segments = [];
    dxf.entities.forEach(ent => {
      if (!ent.vertices || ent.vertices.length < 2) return;
      if (ent.type === 'LINE') {
        segments.push([ent.vertices[0], ent.vertices[1]]);
      } else if (ent.type === 'LWPOLYLINE' || ent.type === 'POLYLINE') {
        for (let i = 0; i < ent.vertices.length - 1; i++) segments.push([ent.vertices[i], ent.vertices[i + 1]]);
        if (ent.shape) segments.push([ent.vertices[ent.vertices.length - 1], ent.vertices[0]]);
      }
    });
    if (!segments.length) { alert('El DXF no tiene líneas ni polilíneas.'); return false; }

    const keyOf = (v) => `${Math.round(v.x * 1000)}|${Math.round(-v.y * 1000)}`;
    const ids = {};
    const nodeFor = (v) => ids[keyOf(v)] || (ids[keyOf(v)] = M.addNode(v.x, -v.y)); // DXF tiene Y hacia arriba
    segments.forEach(([p, q]) => {
      const a = nodeFor(p), b = nodeFor(q);
      if (a !== b && !M.wallBetween(a, b)) {
        M.level.walls.push({ id: M.newId('w'), a, b, thickness: M.project.settings.wallThickness });
      }
    });
    M.commit();
    return true;
  }

  // ---------- exportaciones ----------
  X.exportPNG = () => {
    const url = SA.editor.toPNG();
    if (!url) { alert('No hay nada para exportar todavía.'); return; }
    const a = document.createElement('a');
    a.href = url;
    a.download = `${baseName()}-${M.level.name.toLowerCase().replace(/[^a-z0-9áéíóúñ]+/gi, '-')}.png`;
    a.click();
  };

  X.exportDXF = () => {
    if (!M.project.levels.some(l => l.walls.length || l.shapes.length)) { alert('Primero dibujá un muro, un lote o una calle.'); return; }
    let dxf = '0\nSECTION\n2\nHEADER\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n';
    // Cada piso en su propia capa
    M.project.levels.forEach((level, index) => level.walls.forEach(w => {
      const a = level.nodes[w.a], b = level.nodes[w.b];
      dxf += `0\nLINE\n8\nMUROS_PISO_${index}\n`;
      dxf += `10\n${a.x.toFixed(4)}\n20\n${(-a.y).toFixed(4)}\n30\n0.0\n`;
      dxf += `11\n${b.x.toFixed(4)}\n21\n${(-b.y).toFixed(4)}\n31\n0.0\n`;
    }));
    // Lotes (cerrados) y ejes de calles
    M.project.levels.forEach((level, index) => level.shapes.forEach(sh => {
      const pts = sh.points;
      const count = sh.kind === 'lote' ? pts.length : pts.length - 1;
      for (let i = 0; i < count; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        dxf += `0\nLINE\n8\n${sh.kind === 'lote' ? 'LOTES' : 'CALLES'}_PISO_${index}\n`;
        dxf += `10\n${a.x.toFixed(4)}\n20\n${(-a.y).toFixed(4)}\n30\n0.0\n`;
        dxf += `11\n${b.x.toFixed(4)}\n21\n${(-b.y).toFixed(4)}\n31\n0.0\n`;
      }
    }));
    dxf += '0\nENDSEC\n0\nEOF\n';
    download(dxf, `${baseName()}.dxf`, 'application/dxf');
  };

  X.exportOBJ = () => {
    if (!hasWalls()) return;
    download(new THREE.OBJExporter().parse(SA.view3d.build()), `${baseName()}.obj`, 'text/plain');
  };

  X.exportGLB = () => {
    if (!hasWalls()) return;
    new THREE.GLTFExporter().parse(
      SA.view3d.build(),
      (result) => download(new Blob([result], { type: 'model/gltf-binary' }), `${baseName()}.glb`),
      { binary: true }
    );
  };

  // Nube de puntos: muestreo de las caras de los muros (para herramientas de escaneo)
  X.exportPLY = () => {
    if (!hasWalls()) return;
    const step = 0.1;
    const rows = [];
    M.project.levels.forEach((level, index) => level.walls.forEach(w => {
      const H = level.height;
      const base = SA.view3d.elevation(index);
      const a = level.nodes[w.a], b = level.nodes[w.b];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const n = Math.max(1, Math.round(len / step));
      const m = Math.max(1, Math.round(H / step));
      for (let i = 0; i <= n; i++) {
        const x = a.x + ((b.x - a.x) * i) / n, z = a.y + ((b.y - a.y) * i) / n;
        for (let j = 0; j <= m; j++) rows.push(`${x.toFixed(3)} ${(base + (H * j) / m).toFixed(3)} ${z.toFixed(3)}`);
      }
    }));
    const header = `ply\nformat ascii 1.0\ncomment ScanArch Studio\nelement vertex ${rows.length}\nproperty float x\nproperty float y\nproperty float z\nend_header\n`;
    download(header + rows.join('\n') + '\n', `${baseName()}-nube.ply`, 'text/plain');
  };

  SA.exporters = X;
})();
