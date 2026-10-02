// Interfaz: pestañas, menú, barra de herramientas y arranque de la aplicación.
(function () {
  const SA = window.SA;
  const M = SA.model;
  const $ = (id) => document.getElementById(id);

  const A = { activeTab: 'cad' };
  const views = { cad: 'view-cad', cam: 'view-camera', '3d': 'view-3d' };
  let view3dReady = false;

  A.switchTab = (tab) => {
    A.activeTab = tab;
    Object.keys(views).forEach(key => {
      $(views[key]).classList.toggle('hidden', key !== tab);
      const btn = $(`tab-${key}`);
      btn.classList.toggle('text-emerald-400', key === tab);
      btn.classList.toggle('text-slate-400', key !== tab);
    });

    if (tab === 'cad') {
      SA.editor.resize();
    } else if (tab === 'cam') {
      SA.capture.start();
    } else if (tab === '3d') {
      if (!view3dReady) {
        SA.view3d.init($('three-container'));
        view3dReady = true;
      }
      SA.view3d.resize();
      SA.view3d.refresh();
      updateMetrics();
    }
  };

  function updateMetrics() {
    const P = M.project;
    const metric = M.isMetric();
    $('metric-area-top').innerText = metric ? `${M.totalArea().toFixed(2).replace('.', ',')} m²` : 'sin escala';
    $('hud-3d-walls').innerText = P.walls.length;
    $('hud-3d-openings').innerText = P.openings.length;
    $('hud-3d-objects').innerText = P.objects.length;
    $('plan-loaded-banner').classList.toggle('hidden', !(P.plan && M.planImage));
    $('plan-status').innerText = P.plan && P.plan.calibrated ? 'Escala calibrada' : 'Falta calibrar la escala';
    $('btn-undo').disabled = !M.canUndo();
    $('input-wall-height').value = P.settings.wallHeight.toFixed(2);
    $('input-wall-thickness').value = P.settings.wallThickness.toFixed(2);
    if (A.activeTab === '3d' && view3dReady) SA.view3d.refresh();
  }

  // ---------- barra de herramientas del plano ----------
  function initToolbar() {
    const toolButtons = document.querySelectorAll('[data-tool]');
    toolButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.dataset.tool === 'object') { $('object-picker').classList.remove('hidden'); return; }
        SA.editor.setTool(btn.dataset.tool);
      });
    });
    SA.editor.onTool = (tool) => {
      toolButtons.forEach(btn => {
        const active = btn.dataset.tool === tool;
        btn.classList.toggle('bg-sky-600', active);
        btn.classList.toggle('text-white', active);
        btn.classList.toggle('text-slate-300', !active);
      });
    };

    $('btn-undo').addEventListener('click', () => M.undo());
    $('btn-redo').addEventListener('click', () => M.redo());
    $('btn-fit-view').addEventListener('click', () => SA.editor.fitView());
    $('btn-finish-wall').addEventListener('click', () => SA.editor.endChain());
    $('btn-remove-plan-bg').addEventListener('click', () => SA.editor.removePlan());

    // Selector de objetos, agrupado por categoría
    const grid = $('object-grid');
    const cats = [...new Set(SA.library.OBJECT_TYPES.map(o => o.cat))];
    grid.innerHTML = cats.map(cat => `
      <div class="mb-3">
        <div class="text-[11px] font-bold text-sky-400 uppercase tracking-wider mb-1.5">${cat}</div>
        <div class="grid grid-cols-3 sm:grid-cols-4 gap-2">
          ${SA.library.OBJECT_TYPES.filter(o => o.cat === cat).map(o => `
            <button data-object="${o.type}" class="px-2 py-2 rounded-lg bg-slate-800 border border-slate-700 hover:bg-slate-700 text-slate-100 text-xs text-left">
              <div class="font-semibold">${o.name}</div>
              <div class="text-[10px] text-slate-400">${o.w.toFixed(2)} × ${o.d.toFixed(2)} m</div>
            </button>`).join('')}
        </div>
      </div>`).join('');
    grid.querySelectorAll('[data-object]').forEach(btn => {
      btn.addEventListener('click', () => {
        $('object-picker').classList.add('hidden');
        SA.editor.setTool('object', btn.dataset.object);
      });
    });
    $('btn-close-picker').addEventListener('click', () => $('object-picker').classList.add('hidden'));
  }

  // ---------- menú principal ----------
  function initMenu() {
    const menu = $('main-menu');
    $('btn-menu').addEventListener('click', (e) => { e.stopPropagation(); menu.classList.toggle('hidden'); });
    document.addEventListener('click', () => menu.classList.add('hidden'));

    $('input-plan-file').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      A.switchTab('cad');
      const kind = await SA.exporters.importPlan(file);
      if (kind === 'dxf') SA.editor.fitView();
      if (kind === 'image') SA.editor.setTool('calibrate');
    });

    $('input-project-file').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      if (await SA.exporters.openProject(file)) { A.switchTab('cad'); SA.editor.fitView(); }
    });

    $('btn-save-project').addEventListener('click', SA.exporters.saveProject);
    $('btn-new-project').addEventListener('click', async () => {
      if (!confirm('¿Empezar un proyecto nuevo? Se borra el plano actual (guardalo antes si lo necesitás).')) return;
      await M.reset();
      SA.editor.setTool('select');
    });
    $('btn-export-png').addEventListener('click', SA.exporters.exportPNG);
    $('btn-export-dxf').addEventListener('click', SA.exporters.exportDXF);
    $('btn-export-glb').addEventListener('click', SA.exporters.exportGLB);
    $('btn-export-obj').addEventListener('click', SA.exporters.exportOBJ);
    $('btn-export-ply').addEventListener('click', SA.exporters.exportPLY);
  }

  // ---------- parámetros 3D ----------
  function init3dControls() {
    $('input-wall-height').addEventListener('change', (e) => {
      const v = parseFloat(e.target.value);
      if (v > 0) { M.project.settings.wallHeight = v; M.commit(); }
    });
    $('input-wall-thickness').addEventListener('change', (e) => {
      const v = parseFloat(e.target.value);
      if (v > 0) {
        M.project.settings.wallThickness = v;
        M.project.walls.forEach(w => { w.thickness = v; });
        M.commit();
      }
    });
    $('select-render-mode').addEventListener('change', (e) => {
      SA.view3d.renderMode = e.target.value;
      SA.view3d.refresh(true);
    });
    $('btn-frame-3d').addEventListener('click', () => SA.view3d.frame());
  }

  window.addEventListener('DOMContentLoaded', async () => {
    if (window.lucide) lucide.createIcons();

    SA.editor.init({
      container: $('cad-stage'), panel: $('sel-panel'), hint: $('cad-hint'), finishBtn: $('btn-finish-wall')
    });
    initToolbar();
    initMenu();
    init3dControls();
    SA.capture.init();

    Object.keys(views).forEach(key => $(`tab-${key}`).addEventListener('click', () => A.switchTab(key)));
    window.addEventListener('resize', () => {
      SA.editor.resize();
      if (view3dReady) SA.view3d.resize();
    });

    M.on(updateMetrics);
    await M.restoreAutosave();
    A.switchTab('cad');
    SA.editor.setTool(M.project.walls.length ? 'select' : 'wall');
    SA.editor.fitView();
  });

  SA.app = A;
})();
