// Biblioteca inmobiliaria: tipos de ambiente y objetos paramétricos.
// Los símbolos 2D se describen con primitivas normalizadas (0..1 del ancho y la profundidad),
// independientes del motor gráfico, para poder reutilizarlos en otras salidas.
// El lado y = 0 es el "fondo" del objeto (el que va contra la pared).
(function () {
  const SA = (window.SA = window.SA || {});

  const ROOM_TYPES = [
    { type: 'living', name: 'Living', color: '#fde68a' },
    { type: 'comedor', name: 'Comedor', color: '#fed7aa' },
    { type: 'cocina', name: 'Cocina', color: '#fecaca' },
    { type: 'dormitorio', name: 'Dormitorio', color: '#bfdbfe' },
    { type: 'bano', name: 'Baño', color: '#a5f3fc' },
    { type: 'toilette', name: 'Toilette', color: '#99f6e4' },
    { type: 'lavadero', name: 'Lavadero', color: '#ddd6fe' },
    { type: 'pasillo', name: 'Pasillo', color: '#e2e8f0' },
    { type: 'garage', name: 'Garage', color: '#d6d3d1' },
    { type: 'galeria', name: 'Galería', color: '#d9f99d' },
    { type: 'patio', name: 'Patio', color: '#bbf7d0' },
    { type: 'oficina', name: 'Oficina', color: '#c7d2fe' },
    { type: 'local', name: 'Local', color: '#fbcfe8' },
    { type: 'deposito', name: 'Depósito', color: '#e7e5e4' },
    { type: 'otro', name: 'Ambiente', color: '#f1f5f9' }
  ];

  const R = (x, y, w, h, r) => ({ k: 'rect', x, y, w, h, r: r || 0 });
  const E = (cx, cy, rx, ry) => ({ k: 'ellipse', cx, cy, rx, ry });
  const C = (cx, cy, r) => ({ k: 'circle', cx, cy, r });
  const L = (...pts) => ({ k: 'line', pts });
  const BOX = R(0, 0, 1, 1);

  const OBJECT_TYPES = [
    // Sanitarios
    { type: 'inodoro', name: 'Inodoro', cat: 'Sanitarios', w: 0.38, d: 0.65, h: 0.4, sym: [R(0.05, 0, 0.9, 0.28, 0.03), E(0.5, 0.63, 0.42, 0.35)] },
    { type: 'bidet', name: 'Bidet', cat: 'Sanitarios', w: 0.38, d: 0.58, h: 0.4, sym: [E(0.5, 0.52, 0.44, 0.46), C(0.5, 0.14, 0.07)] },
    { type: 'lavatorio', name: 'Lavatorio', cat: 'Sanitarios', w: 0.55, d: 0.45, h: 0.85, sym: [BOX, E(0.5, 0.56, 0.36, 0.32), C(0.5, 0.13, 0.05)] },
    { type: 'ducha', name: 'Ducha', cat: 'Sanitarios', w: 0.9, d: 0.9, h: 0.1, sym: [BOX, L(0, 0, 1, 1), L(1, 0, 0, 1), C(0.5, 0.5, 0.07)] },
    { type: 'banera', name: 'Bañera', cat: 'Sanitarios', w: 1.6, d: 0.7, h: 0.55, sym: [BOX, R(0.05, 0.1, 0.9, 0.8, 0.12), C(0.12, 0.5, 0.06)] },
    // Cocina y lavadero
    { type: 'cocina', name: 'Cocina', cat: 'Cocina', w: 0.6, d: 0.6, h: 0.9, sym: [BOX, C(0.28, 0.28, 0.13), C(0.72, 0.28, 0.13), C(0.28, 0.72, 0.13), C(0.72, 0.72, 0.13)] },
    { type: 'heladera', name: 'Heladera', cat: 'Cocina', w: 0.7, d: 0.7, h: 1.8, sym: [BOX, L(0, 0.86, 1, 0.86)] },
    { type: 'bacha', name: 'Mesada con bacha', cat: 'Cocina', w: 1.2, d: 0.6, h: 0.9, sym: [BOX, R(0.12, 0.2, 0.45, 0.6, 0.05), C(0.345, 0.12, 0.05)] },
    { type: 'mesada', name: 'Mesada', cat: 'Cocina', w: 1.2, d: 0.6, h: 0.9, sym: [BOX] },
    { type: 'lavarropas', name: 'Lavarropas', cat: 'Cocina', w: 0.6, d: 0.6, h: 0.85, sym: [BOX, C(0.5, 0.56, 0.3)] },
    // Dormitorio
    { type: 'cama2', name: 'Cama 2 plazas', cat: 'Dormitorio', w: 1.4, d: 1.9, h: 0.5, sym: [BOX, R(0.07, 0.04, 0.39, 0.16, 0.03), R(0.54, 0.04, 0.39, 0.16, 0.03), L(0, 0.27, 1, 0.27)] },
    { type: 'cama1', name: 'Cama 1 plaza', cat: 'Dormitorio', w: 0.9, d: 1.9, h: 0.5, sym: [BOX, R(0.14, 0.04, 0.72, 0.16, 0.03), L(0, 0.27, 1, 0.27)] },
    { type: 'placard', name: 'Placard', cat: 'Dormitorio', w: 1.5, d: 0.6, h: 2.4, sym: [BOX, L(0, 0, 1, 1), L(0, 1, 1, 0)] },
    { type: 'mesaluz', name: 'Mesa de luz', cat: 'Dormitorio', w: 0.45, d: 0.4, h: 0.5, sym: [BOX, C(0.5, 0.5, 0.18)] },
    // Estar y trabajo
    { type: 'sillon', name: 'Sillón', cat: 'Estar', w: 1.8, d: 0.85, h: 0.8, sym: [BOX, R(0, 0, 1, 0.26), R(0, 0, 0.11, 1), R(0.89, 0, 0.11, 1)] },
    { type: 'mesa', name: 'Mesa', cat: 'Estar', w: 1.4, d: 0.8, h: 0.75, sym: [BOX, R(0.06, 0.1, 0.88, 0.8)] },
    { type: 'silla', name: 'Silla', cat: 'Estar', w: 0.45, d: 0.45, h: 0.45, sym: [R(0, 0, 1, 1, 0.08), L(0.08, 0.16, 0.92, 0.16)] },
    { type: 'tv', name: 'Mueble TV', cat: 'Estar', w: 1.4, d: 0.4, h: 0.5, sym: [BOX, L(0.15, 0.5, 0.85, 0.5)] },
    { type: 'escritorio', name: 'Escritorio', cat: 'Estar', w: 1.2, d: 0.6, h: 0.75, sym: [BOX] },
    // Otros
    { type: 'escalera', name: 'Escalera', cat: 'Otros', w: 1.0, d: 2.5, h: 2.6, sym: [BOX, L(0, 0.1, 1, 0.1), L(0, 0.2, 1, 0.2), L(0, 0.3, 1, 0.3), L(0, 0.4, 1, 0.4), L(0, 0.5, 1, 0.5), L(0, 0.6, 1, 0.6), L(0, 0.7, 1, 0.7), L(0, 0.8, 1, 0.8), L(0, 0.9, 1, 0.9), L(0.5, 0.95, 0.5, 0.05), L(0.4, 0.15, 0.5, 0.05, 0.6, 0.15)] },
    { type: 'auto', name: 'Auto', cat: 'Otros', w: 1.8, d: 4.5, h: 1.5, sym: [R(0, 0, 1, 1, 0.18), R(0.12, 0.22, 0.76, 0.14, 0.03), R(0.12, 0.72, 0.76, 0.1, 0.03)] },
    { type: 'columna', name: 'Columna', cat: 'Otros', w: 0.3, d: 0.3, h: 2.6, sym: [BOX, L(0, 0, 1, 1), L(1, 0, 0, 1)] }
  ];

  SA.library = {
    ROOM_TYPES,
    OBJECT_TYPES,
    roomType: (type) => ROOM_TYPES.find(r => r.type === type) || ROOM_TYPES[ROOM_TYPES.length - 1],
    objectType: (type) => OBJECT_TYPES.find(o => o.type === type)
  };
})();
