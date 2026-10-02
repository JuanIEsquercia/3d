// Vista 3D: interpreta el mismo modelo del inmueble como geometría (Three.js).
(function () {
  const SA = window.SA;
  const M = SA.model;
  const LIB = SA.library;

  const DOOR_HEIGHT = 2.05;
  const WINDOW_SILL = 0.9;
  const WINDOW_TOP = 2.1;

  const V = { group: null, renderMode: 'solid' };
  let scene, camera, renderer, controls, container;
  let dirty = true;

  V.init = (el) => {
    container = el;
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0xe2e8f0);

    camera = new THREE.PerspectiveCamera(55, 1, 0.05, 2000);
    camera.position.set(6, 9, 10);

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    container.appendChild(renderer.domElement);

    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI / 2 - 0.02;

    scene.add(new THREE.HemisphereLight(0xffffff, 0x94a3b8, 0.75));
    const sun = new THREE.DirectionalLight(0xffffff, 0.6);
    sun.position.set(8, 20, 12);
    scene.add(sun);

    M.on(() => { dirty = true; });

    (function animate() {
      requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    })();
  };

  V.resize = () => {
    if (!renderer || !container.clientWidth) return;
    renderer.setSize(container.clientWidth, container.clientHeight);
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
  };

  // Construye la geometría a partir del modelo. Devuelve el grupo (también lo usan los exportadores).
  // withEdges agrega aristas oscuras para leer mejor los volúmenes (no se exportan).
  V.build = (withEdges) => {
    const P = M.project;
    const H = P.settings.wallHeight;
    const wire = V.renderMode === 'wireframe';
    const group = new THREE.Group();
    group.name = P.name || 'Inmueble';

    const wallMat = new THREE.MeshStandardMaterial({ color: 0xe7e2d9, roughness: 0.9, wireframe: wire });
    const edgeMat = new THREE.LineBasicMaterial({ color: 0x475569 });
    const outline = (mesh) => {
      if (withEdges && !wire) mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry), edgeMat));
    };
    const glassMat = new THREE.MeshStandardMaterial({ color: 0x7dd3fc, transparent: true, opacity: 0.45, roughness: 0.1 });
    const objMat = new THREE.MeshStandardMaterial({ color: 0x94a3b8, roughness: 0.7, wireframe: wire });

    // Muros, partidos alrededor de puertas y ventanas
    P.walls.forEach(w => {
      const a = M.node(w.a), b = M.node(w.b);
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (!len) return;
      const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
      const angle = Math.atan2(uy, ux);

      const addBox = (s0, s1, y0, y1, material, thickness) => {
        if (s1 - s0 < 1e-4 || y1 - y0 < 1e-4) return;
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(s1 - s0, y1 - y0, thickness || w.thickness), material);
        const mid = (s0 + s1) / 2;
        mesh.position.set(a.x + ux * mid, (y0 + y1) / 2, a.y + uy * mid);
        mesh.rotation.y = -angle;
        if (material === wallMat) outline(mesh);
        group.add(mesh);
      };

      const spans = P.openings
        .filter(o => o.wallId === w.id)
        .map(o => {
          const half = Math.min(o.width, len) / 2;
          return { o, s0: Math.max(0, o.t * len - half), s1: Math.min(len, o.t * len + half) };
        })
        .sort((p, q) => p.s0 - q.s0);

      let cursor = 0;
      spans.forEach(sp => {
        if (sp.s0 < cursor) return; // aberturas superpuestas: se ignora la segunda
        addBox(cursor, sp.s0, 0, H, wallMat);
        if (sp.o.type === 'door') {
          addBox(sp.s0, sp.s1, Math.min(DOOR_HEIGHT, H), H, wallMat);
        } else {
          addBox(sp.s0, sp.s1, 0, Math.min(WINDOW_SILL, H), wallMat);
          addBox(sp.s0, sp.s1, Math.min(WINDOW_TOP, H), H, wallMat);
          addBox(sp.s0, sp.s1, Math.min(WINDOW_SILL, H), Math.min(WINDOW_TOP, H), glassMat, 0.03);
        }
        cursor = sp.s1;
      });
      addBox(cursor, len, 0, H, wallMat);
    });

    // Piso de cada ambiente, con el color de su tipo
    M.faces().forEach(face => {
      const shape = new THREE.Shape();
      face.poly.forEach((p, i) => (i ? shape.lineTo(p.x, p.y) : shape.moveTo(p.x, p.y)));
      const rt = LIB.roomType(face.label ? face.label.type : 'otro');
      const floor = new THREE.Mesh(
        new THREE.ShapeGeometry(shape),
        new THREE.MeshStandardMaterial({ color: new THREE.Color(rt.color), roughness: 0.95, side: THREE.DoubleSide })
      );
      floor.rotation.x = Math.PI / 2; // plano XY del dibujo -> piso XZ
      floor.name = face.label ? face.label.name : rt.name;
      group.add(floor);
    });

    // Objetos como volúmenes simples con sus medidas reales
    P.objects.forEach(o => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(o.w, o.h, o.d), objMat);
      mesh.position.set(o.x, o.h / 2, o.y);
      mesh.rotation.y = (-o.rotation * Math.PI) / 180;
      const def = LIB.objectType(o.type);
      mesh.name = def ? def.name : o.type;
      outline(mesh);
      group.add(mesh);
    });

    return group;
  };

  V.refresh = (force) => {
    if (!scene || (!dirty && !force)) return;
    dirty = false;
    const first = !V.group || V.group.children.length === 0;
    if (V.group) scene.remove(V.group);
    V.group = V.build(true);
    scene.add(V.group);
    if (first) V.frame();
  };

  // Encuadra la cámara sobre el modelo
  V.frame = () => {
    if (!V.group || V.group.children.length === 0) return;
    const box = new THREE.Box3().setFromObject(V.group);
    const center = box.getCenter(new THREE.Vector3());
    const size = Math.max(box.getSize(new THREE.Vector3()).length(), 2);
    // En pantalla vertical el campo de visión horizontal es menor: alejo la cámara
    const d = size / Math.max(Math.min(camera.aspect, 1), 0.4);
    controls.target.copy(center);
    camera.position.set(center.x + d * 0.4, center.y + d * 0.75, center.z + d * 0.7);
    camera.near = size / 500;
    camera.far = size * 50;
    camera.updateProjectionMatrix();
  };

  V.counts = () => ({ walls: M.project.walls.length, openings: M.project.openings.length, objects: M.project.objects.length });

  SA.view3d = V;
})();
