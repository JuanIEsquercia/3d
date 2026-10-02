// Relevamiento con el celular: cámara + rumbo del giroscopio + distancia cargada a mano.
// Cada vértice fijado agrega un muro al mismo modelo que usa el editor 2D.
(function () {
  const SA = window.SA;
  const M = SA.model;
  const $ = (id) => document.getElementById(id);

  const C = {
    distance: 2.5,       // metros hasta el próximo vértice
    heading: 0,          // rumbo del sensor (0-360°)
    headingOffset: 0,    // giro manual (botones ±90°)
    baseHeading: null,   // rumbo del primer muro: referencia de la escuadra
    snap90: true,
    facing: 'environment',
    chain: []            // ids de nodo del recorrido actual
  };

  let stream = null;
  let gyroAttached = false;
  let gotAbsolute = false;
  let sensorActive = false;

  const normalizeDeg = (d) => ((d % 360) + 360) % 360;

  // ---------- cámara ----------
  function setCameraStatus(active) {
    $('cam-start-overlay').classList.toggle('hidden', active);
    $('cam-status-dot').className = `inline-block w-2 h-2 rounded-full ${active ? 'bg-emerald-400 animate-ping' : 'bg-rose-500'}`;
    $('cam-status-text').className = `${active ? 'text-emerald-400' : 'text-rose-400'} font-bold uppercase tracking-wider text-[11px]`;
    $('cam-status-text').innerText = active ? 'Cámara Activa' : 'Cámara Inactiva';
  }

  function showCameraError(msg) {
    setCameraStatus(false);
    $('cam-error').innerText = msg;
  }

  async function startCamera() {
    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showCameraError('La cámara necesita HTTPS y un navegador compatible (Chrome o Safari). Abrí la app desde la URL https:// de Vercel, no desde una app de mensajería.');
      return;
    }
    if (stream) stream.getTracks().forEach(t => t.stop());
    try {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: C.facing }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false
        });
      } catch (err) {
        // Algunos celulares rechazan la resolución pedida: reintento con lo básico
        if (err.name !== 'OverconstrainedError') throw err;
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      }
      const video = $('ar-video');
      video.srcObject = stream;
      await video.play().catch(() => {});
      setCameraStatus(true);
    } catch (err) {
      console.warn('No se pudo iniciar la cámara:', err);
      const messages = {
        NotAllowedError: 'Permiso de cámara denegado. Habilitalo en la configuración del navegador (candado junto a la URL) y tocá de nuevo el botón.',
        NotFoundError: 'No se encontró ninguna cámara en este dispositivo.',
        NotReadableError: 'La cámara está en uso por otra app. Cerrala y volvé a intentar.'
      };
      showCameraError(messages[err.name] || `No se pudo iniciar la cámara (${err.name || err}).`);
    }
  }

  // ---------- giroscopio ----------
  // Rumbo hacia donde apunta la cámara trasera, válido con el celular en vertical
  // (fórmula de referencia de la especificación W3C DeviceOrientation)
  function cameraHeading(alpha, beta, gamma) {
    const d2r = Math.PI / 180;
    const x = (beta || 0) * d2r, y = (gamma || 0) * d2r, z = (alpha || 0) * d2r;
    const vx = -Math.cos(z) * Math.sin(y) - Math.sin(z) * Math.sin(x) * Math.cos(y);
    const vy = -Math.sin(z) * Math.sin(y) + Math.cos(z) * Math.sin(x) * Math.cos(y);
    // Celular casi plano: la proyección es inestable, uso la dirección del borde superior
    if (Math.hypot(vx, vy) < 0.2) return normalizeDeg(360 - alpha);
    return normalizeDeg(Math.atan2(vx, vy) / d2r);
  }
  C._cameraHeading = cameraHeading;

  function onOrientation(e) {
    // Si el equipo entrega orientación absoluta (brújula), ignoro la relativa
    if (e.type === 'deviceorientation' && gotAbsolute) return;
    let heading = null;
    if (typeof e.webkitCompassHeading === 'number' && !isNaN(e.webkitCompassHeading)) {
      heading = e.webkitCompassHeading; // iOS Safari
    } else if (e.alpha !== null && e.alpha !== undefined) {
      heading = cameraHeading(e.alpha, e.beta, e.gamma); // Android Chrome
    }
    if (heading === null) return;
    if (e.type === 'deviceorientationabsolute') gotAbsolute = true;
    C.heading = heading;
    if (!sensorActive) {
      sensorActive = true;
      $('hud-sensor').innerText = 'activo';
      $('hud-sensor').className = 'text-emerald-400 font-bold';
    }
    updateHud();
  }

  function attachGyro() {
    if (gyroAttached) return;
    gyroAttached = true;
    window.addEventListener('deviceorientationabsolute', onOrientation, true);
    window.addEventListener('deviceorientation', onOrientation, true);
  }

  // En iPhone el permiso de movimiento solo se puede pedir desde un toque del usuario
  async function requestGyro() {
    if (typeof DeviceOrientationEvent === 'undefined') return;
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
      try {
        if ((await DeviceOrientationEvent.requestPermission()) !== 'granted') return;
      } catch (e) {
        console.warn(e);
        return;
      }
      $('btn-request-gyro').classList.add('hidden');
    }
    attachGyro();
  }

  // Rumbo final del próximo muro: sensor + giro manual, ajustado a escuadra si corresponde
  function wallHeading() {
    const raw = normalizeDeg(C.heading + C.headingOffset);
    if (C.snap90 && C.baseHeading !== null) {
      return normalizeDeg(C.baseHeading + Math.round((raw - C.baseHeading) / 90) * 90);
    }
    return raw;
  }

  function updateHud() {
    $('hud-heading').innerText = `${Math.round(wallHeading())}°`;
    $('hud-pts').innerText = C.chain.length;
    const d = C.distance.toFixed(2);
    $('label-curr-dist').innerText = d;
    $('hud-segment-dist').innerText = d;
  }

  // Descarta del recorrido los nodos que ya no existen (tras deshacer o borrar)
  function pruneChain() {
    while (C.chain.length && !M.node(C.chain[C.chain.length - 1])) C.chain.pop();
    if (C.chain.length < 2) C.baseHeading = null;
  }

  // ---------- marcado ----------
  function markCorner() {
    pruneChain();
    if (C.chain.length === 0) {
      // Nuevo recorrido: arranca en el origen o al lado de lo ya dibujado
      let x = 0, y = 0;
      const ids = Object.keys(M.project.nodes);
      if (ids.length) {
        x = Math.max(...ids.map(id => M.project.nodes[id].x)) + 2;
        y = Math.min(...ids.map(id => M.project.nodes[id].y));
      }
      C.chain.push(M.addNode(x, y));
      updateHud();
      return;
    }
    if (C.baseHeading === null) C.baseHeading = normalizeDeg(C.heading + C.headingOffset);
    const last = M.node(C.chain[C.chain.length - 1]);
    const rad = (wallHeading() * Math.PI) / 180;
    // Norte hacia arriba: X al este, Y de pantalla hacia abajo
    const next = { x: last.x + Math.sin(rad) * C.distance, y: last.y - Math.cos(rad) * C.distance };
    const res = M.addWall(C.chain[C.chain.length - 1], next, 0.05);
    C.chain.push(res.endId);
    M.commit();
    updateHud();
  }

  function closeLoop() {
    pruneChain();
    if (C.chain.length < 3) {
      alert('Se necesitan al menos 3 vértices para cerrar la planta.');
      return;
    }
    M.addWall(C.chain[C.chain.length - 1], C.chain[0], 0.05);
    C.chain = [];
    C.baseHeading = null;
    M.commit();
    updateHud();
    SA.app.switchTab('cad');
    SA.editor.fitView();
  }

  C.init = () => {
    $('btn-start-camera').addEventListener('click', () => { requestGyro(); startCamera(); });
    $('btn-request-gyro').addEventListener('click', requestGyro);
    $('btn-switch-camera').addEventListener('click', () => {
      C.facing = C.facing === 'environment' ? 'user' : 'environment';
      startCamera();
    });

    $('btn-dist-inc').addEventListener('click', () => { C.distance = +(C.distance + 0.25).toFixed(2); updateHud(); });
    $('btn-dist-dec').addEventListener('click', () => { if (C.distance > 0.25) C.distance = +(C.distance - 0.25).toFixed(2); updateHud(); });
    // Tocar la distancia permite escribir el valor exacto
    $('btn-dist-edit').addEventListener('click', () => {
      const input = prompt('Distancia del tramo en metros:', C.distance.toFixed(2));
      const v = input ? parseFloat(input.replace(',', '.')) : NaN;
      if (v > 0) { C.distance = +v.toFixed(2); updateHud(); }
    });

    $('btn-turn-left').addEventListener('click', () => { C.headingOffset = normalizeDeg(C.headingOffset - 90); updateHud(); });
    $('btn-turn-right').addEventListener('click', () => { C.headingOffset = normalizeDeg(C.headingOffset + 90); updateHud(); });
    $('btn-snap-90').addEventListener('click', () => {
      C.snap90 = !C.snap90;
      $('btn-snap-90').innerText = `Escuadra: ${C.snap90 ? 'SÍ' : 'NO'}`;
      $('btn-snap-90').classList.toggle('text-emerald-400', C.snap90);
      $('btn-snap-90').classList.toggle('text-slate-400', !C.snap90);
      updateHud();
    });

    $('btn-mark-corner').addEventListener('click', markCorner);
    $('btn-close-polygon').addEventListener('click', closeLoop);
    $('btn-undo-ar').addEventListener('click', () => {
      pruneChain();
      if (C.chain.length === 1) { C.chain = []; M.cleanupNodes(); }
      else M.undo();
      pruneChain();
      updateHud();
    });
    $('btn-new-run').addEventListener('click', () => {
      C.chain = [];
      C.baseHeading = null;
      M.cleanupNodes();
      updateHud();
    });

    M.on(() => { pruneChain(); updateHud(); });

    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      $('btn-request-gyro').classList.remove('hidden');
    } else {
      attachGyro();
    }
    updateHud();
  };

  // La cámara se enciende recién al abrir la pestaña de relevamiento
  C.start = () => { if (!stream) startCamera(); };

  SA.capture = C;
})();
