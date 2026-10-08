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

  X.exportBrochure = async () => {
    const url = SA.editor.toPNG();
    if (!url) { alert('No hay nada para exportar todavía.'); return; }
    const img = await loadImage(url);

    const canvas = document.createElement('canvas');
    canvas.width = 1920;
    canvas.height = 1350;
    const ctx = canvas.getContext('2d');

    // Fondo blanco elegante
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Cabecera superior inmobiliaria
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, canvas.width, 140);

    const agency = (M.project.settings && M.project.settings.agencyName) || 'Ficha Inmobiliaria';
    ctx.fillStyle = '#10b981';
    ctx.font = 'bold 36px sans-serif';
    ctx.fillText(agency.toUpperCase(), 60, 60);

    ctx.fillStyle = '#94a3b8';
    ctx.font = '22px sans-serif';
    ctx.fillText(`PLANO DE DISTRIBUCIÓN & AMBIENTES · ${M.project.name.toUpperCase()} (${M.level.name})`, 60, 105);

    // Métrica total en cabecera
    const totalAreaStr = M.isMetric() ? `${M.totalArea().toFixed(2).replace('.', ',')} m²` : 'Sin calibrar';
    ctx.fillStyle = '#10b981';
    ctx.font = 'bold 38px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(totalAreaStr, canvas.width - 60, 70);

    ctx.fillStyle = '#cbd5e1';
    ctx.font = '18px sans-serif';
    ctx.fillText('SUPERFICIE TOTAL ESTIMADA', canvas.width - 60, 105);
    ctx.textAlign = 'left';

    // Área para el plano 2D (izquierda / centro)
    const planW = 1250;
    const planH = 1100;
    const planX = 60;
    const planY = 180;

    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.06)';
    ctx.shadowBlur = 15;
    ctx.fillRect(planX, planY, planW, planH);
    ctx.shadowBlur = 0;

    const scale = Math.min((planW - 60) / img.width, (planH - 60) / img.height);
    const drawW = img.width * scale;
    const drawH = img.height * scale;
    const drawX = planX + (planW - drawW) / 2;
    const drawY = planY + (planH - drawH) / 2;
    ctx.drawImage(img, drawX, drawY, drawW, drawH);

    // Panel lateral derecho: Distribución de Ambientes
    const sideX = 1350;
    const sideY = 180;
    const sideW = 510;
    const sideH = 1100;

    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.06)';
    ctx.shadowBlur = 15;
    ctx.fillRect(sideX, sideY, sideW, sideH);
    ctx.shadowBlur = 0;

    ctx.fillStyle = '#0f172a';
    ctx.font = 'bold 24px sans-serif';
    ctx.fillText('DISTRIBUCIÓN DE AMBIENTES', sideX + 30, sideY + 50);

    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(sideX + 30, sideY + 70);
    ctx.lineTo(sideX + sideW - 30, sideY + 70);
    ctx.stroke();

    let curY = sideY + 110;
    const faces = M.faces();
    if (!faces.length) {
      ctx.fillStyle = '#64748b';
      ctx.font = '18px sans-serif';
      ctx.fillText('No se han delimitado ambientes.', sideX + 30, curY);
    } else {
      faces.forEach((face) => {
        if (curY > sideY + sideH - 120) return;
        const rt = SA.library.roomType(face.label ? face.label.type : 'otro');
        const name = face.label ? face.label.name : rt.name;
        const areaStr = (face.label && face.label.customArea) ? face.label.customArea : (face.label && face.label.hideArea ? '-' : `${face.area.toFixed(2).replace('.', ',')} m²`);

        // Círculo de color
        ctx.fillStyle = rt.color || '#3b82f6';
        ctx.beginPath();
        ctx.arc(sideX + 45, curY - 6, 8, 0, Math.PI * 2);
        ctx.fill();

        // Nombre de ambiente
        ctx.fillStyle = '#1e293b';
        ctx.font = 'bold 18px sans-serif';
        ctx.fillText(name, sideX + 70, curY);

        // m²
        ctx.fillStyle = '#059669';
        ctx.font = 'bold 18px monospace';
        ctx.textAlign = 'right';
        ctx.fillText(areaStr, sideX + sideW - 30, curY);
        ctx.textAlign = 'left';

        curY += 45;
      });
    }

    // Pie de página
    ctx.fillStyle = '#64748b';
    ctx.font = '14px sans-serif';
    ctx.fillText('Plano generado con ScanArch Studio · Documentación gráfica orientativa.', 60, canvas.height - 20);

    // La imagen sale del lienzo como texto base64: la convierto a bytes para guardar un PNG real
    const bytes = atob(canvas.toDataURL('image/png').split(',')[1]);
    const buffer = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) buffer[i] = bytes.charCodeAt(i);
    download(new Blob([buffer], { type: 'image/png' }), `${baseName()}-ficha-comercial.png`);
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
      const pts = M.shapePath(sh); // los lados curvos ya vienen divididos en tramos cortos
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
