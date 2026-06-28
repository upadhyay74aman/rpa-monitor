(function () {
  "use strict";
  const LAYOUT_KEY = "rpaMonitor.layout.v1";
  const engine = window.RpaStateEngine.createStateEngine();
  const els = {
    fpsReadout: document.getElementById("fpsReadout"),
    activeRowsReadout: document.getElementById("activeRowsReadout"),
    domNodesReadout: document.getElementById("domNodesReadout"),
    kpiStreamed: document.getElementById("kpiStreamed"),
    kpiRobots: document.getElementById("kpiRobots"),
    kpiSavings: document.getElementById("kpiSavings"),
    pauseBtn: document.getElementById("pauseBtn"),
    analyticsBtn: document.getElementById("analyticsBtn"),
    analyticsOverlay: document.getElementById("analyticsOverlay"),
    closeAnalyticsBtn: document.getElementById("closeAnalyticsBtn"),
    bountyChartCtx: document.getElementById("bountyChart").getContext("2d"),
    bufferBadge: document.getElementById("bufferBadge"),
    searchInput: document.getElementById("searchInput"),
    filterAutomationType: document.getElementById("filterAutomationType"),
    filterDepartment: document.getElementById("filterDepartment"),
    filterIndustry: document.getElementById("filterIndustry"),
    clearFiltersBtn: document.getElementById("clearFiltersBtn"),
    toggleAnalytics: document.getElementById("toggleAnalytics"),
    toggleInfra: document.getElementById("toggleInfra"),
    sideAnalytics: document.getElementById("sideAnalytics"),
    deptList: document.getElementById("deptList"),
    headerRow: document.getElementById("headerRow"),
    footerLeft: document.getElementById("footerLeft"),
    footerRight: document.getElementById("footerRight"),
    debugDomNodes: document.getElementById("debugDomNodes"),
    debugRowPool: document.getElementById("debugRowPool")
  };

  // The live DOM node count only changes on buildPool() (init/resize/panel
  // reflow) or when paintRow swaps a sort indicator in/out of the header.
  // Walking the whole document tree every second with getElementsByTagName('*')
  // forces a full-tree traversal on a timer for no reason — a MutationObserver
  // lets the browser tell us the count changed instead of us asking it, on a
  // budget, forever. Declared before grid setup so onPoolChange can't
  // accidentally write the row-pool size into the actual DOM-node readouts.
  //
  // NOTE: MutationObserver callbacks run as a microtask, not synchronously.
  // That means right after buildPool() appends its pool nodes, cachedDomNodeCount
  // hasn't been refreshed yet when onPoolChange fires in the same call stack.
  // refreshDomNodeCount() does a direct, synchronous recount for exactly that
  // moment; the observer keeps cachedDomNodeCount current the rest of the time
  // (sort-indicator add/remove, future structural changes) without polling.
  let cachedDomNodeCount = document.getElementsByTagName("*").length;
  function refreshDomNodeCount() {
    cachedDomNodeCount = document.getElementsByTagName("*").length;
    return cachedDomNodeCount;
  }
  const domNodeObserver = new MutationObserver(refreshDomNodeCount);
  domNodeObserver.observe(document.documentElement, { childList: true, subtree: true });

  const grid = window.RpaVirtualGrid.createVirtualGrid({
    viewport: document.getElementById("viewport"),
    headerRow: els.headerRow,
    spacer: document.getElementById("spacer"),
    emptyState: document.getElementById("emptyState"),
    formatters: engine.formatters,
    onPoolChange: (poolSize) => {
      // poolSize is the recycled row-pool count, NOT the live DOM node count —
      // these are two different numbers. domNodesReadout (top bar) and
      // debugDomNodes (bottom-right overlay) both show the real DOM node count;
      // only debugRowPool shows poolSize. Recount synchronously here since the
      // MutationObserver's own callback hasn't run yet at this point.
      els.debugRowPool.textContent = poolSize.toLocaleString("en-US");
      refreshDomNodeCount();
      updateDebugOverlay();
    }
  });

  let lastDeptUpdate = 0;
  let bountyChartInstance = null;

  function renderBountyChart(snapshot) {
    const deptTotals = {};
    for (let i = 0; i < snapshot.activeIndices.length; i++) {
      const row = snapshot.rowsById.get(snapshot.activeIndices[i]);
      if (!deptTotals[row.department]) deptTotals[row.department] = 0;
      deptTotals[row.department] += row.budget_usd;
    }
    if (bountyChartInstance) bountyChartInstance.destroy();
    bountyChartInstance = new window.Chart(els.bountyChartCtx, {
      type: 'bar',
      data: { labels: Object.keys(deptTotals), datasets: [{ label: 'Budget by Dept', data: Object.values(deptTotals), backgroundColor: '#3b82f6' }] },
      options: { responsive: true, maintainAspectRatio: false }
    });
  }

  function updateDebugOverlay() {
    els.domNodesReadout.textContent = cachedDomNodeCount.toLocaleString("en-US");
    els.debugDomNodes.textContent = cachedDomNodeCount.toLocaleString("en-US");
  }

  function updateKpis(snapshot) {
    els.kpiStreamed.textContent = engine.formatters.fmtInt(snapshot.totalStreamedRows);
    els.kpiRobots.textContent = engine.formatters.fmtInt(snapshot.cumRobots);
    els.kpiSavings.textContent = engine.formatters.fmtCurrency(snapshot.cumSavings);
  }

  function updateDeptPanel() {
    const fragment = document.createDocumentFragment();
    const rankings = engine.getDepartmentRankings(14);
    for (let i = 0; i < rankings.length; i++) {
      const row = document.createElement("div");
      row.className = "dept-row";
      row.innerHTML = `<span>${rankings[i][0]}</span><span>${engine.formatters.fmtCurrency(rankings[i][1].savingsSum)}</span>`;
      fragment.appendChild(row);
    }
    els.deptList.replaceChildren(fragment);
  }

  function updatePauseUi(snapshot) {
    els.pauseBtn.textContent = snapshot.isPaused ? "Play" : "Pause";
    els.pauseBtn.classList.toggle("primary", !snapshot.isPaused);
    els.pauseBtn.classList.toggle("paused", snapshot.isPaused);
    els.bufferBadge.textContent = "buffer: " + snapshot.pendingBufferedRows.toLocaleString("en-US");
    els.bufferBadge.classList.toggle("buffering", snapshot.pendingBufferedRows > 0);
  }

  function updateFooter(snapshot) {
    els.footerLeft.textContent = snapshot.activeIndices.length.toLocaleString("en-US") + " rows in view";
    els.footerRight.textContent = "tick #" + snapshot.totalTicks.toLocaleString("en-US");
  }

  function renderSortIndicators(sortChain) {
    const cols = els.headerRow.querySelectorAll(".col");
    for (let i = 0; i < cols.length; i++) {
      const col = cols[i];
      col.querySelectorAll(".sort-ind, .sort-rank").forEach((node) => node.remove());
      const idx = sortChain.findIndex((item) => item.key === col.dataset.key);
      if (idx === -1) continue;
      const arrow = document.createElement("span");
      arrow.className = "sort-ind";
      arrow.textContent = sortChain[idx].dir === 1 ? "▲" : "▼";
      col.appendChild(arrow);
      if (sortChain.length > 1) {
        const rank = document.createElement("span");
        rank.className = "sort-rank";
        rank.textContent = idx + 1;
        col.appendChild(rank);
      }
    }
  }

  function render(snapshot, reason) {
    updateKpis(snapshot);
    const now = performance.now();
    if (reason === "init" || now - lastDeptUpdate >= 1000) {
      updateDeptPanel();
      lastDeptUpdate = now;
    }
    updatePauseUi(snapshot);
    updateFooter(snapshot);
    if (reason === "sort" || reason === "init") {
      renderSortIndicators(snapshot.sortChain);
    }
    els.activeRowsReadout.textContent = snapshot.activeIndices.length.toLocaleString("en-US");
    grid.render(snapshot);
    updateDebugOverlay();
  }

  function rebuildGridAfterReflow() {
    requestAnimationFrame(() => {
      grid.rebuildPool();
      grid.render(engine.getSnapshot());
    });
  }

  function fillSelect(selectEl, values) {
    const current = selectEl.value;
    const firstOption = selectEl.options[0];
    const fragment = document.createDocumentFragment();
    selectEl.textContent = "";
    fragment.appendChild(firstOption);
    for (let i = 0; i < values.length; i++) {
      const option = document.createElement("option");
      option.value = values[i];
      option.textContent = values[i];
      fragment.appendChild(option);
    }
    selectEl.appendChild(fragment);
    selectEl.value = values.includes(current) ? current : "";
  }

  function populateFilterOptions() {
    const options = engine.getFilterOptions();
    fillSelect(els.filterAutomationType, options.automationTypes);
    fillSelect(els.filterDepartment, options.departments);
    fillSelect(els.filterIndustry, options.industries);
  }

  function saveLayout() {
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify({
        analyticsVisible: els.toggleAnalytics.checked,
        infraVisible: els.toggleInfra.checked
      }));
    } catch (error) {}
  }

  function restoreLayout() {
    let state = null;
    try { state = JSON.parse(localStorage.getItem(LAYOUT_KEY)); } catch (e) {}
    if (!state || typeof state !== "object") return;
    els.toggleAnalytics.checked = state.analyticsVisible !== false;
    els.sideAnalytics.style.display = state.analyticsVisible === false ? "none" : "block";
    els.toggleInfra.checked = state.infraVisible !== false;
    document.querySelector(".kpis").style.display = state.infraVisible === false ? "none" : "grid";
  }

  function wireEvents() {
    els.pauseBtn.addEventListener("click", () => {
      engine.togglePause();
      const snapshot = engine.getSnapshot();
      els.analyticsBtn.style.display = snapshot.isPaused ? "inline-block" : "none";
      if (!snapshot.isPaused) els.analyticsOverlay.style.display = "none";
    });

    els.analyticsBtn.addEventListener("click", () => {
      els.analyticsOverlay.style.display = "flex";
      renderBountyChart(engine.getSnapshot());
    });
    els.closeAnalyticsBtn.addEventListener("click", () => {
      els.analyticsOverlay.style.display = "none";
    });

    els.headerRow.addEventListener("click", (event) => {
      const col = event.target.closest(".col");
      if (!col) return;
      engine.setSort(col.dataset.key, event.shiftKey);
    });

    els.filterAutomationType.addEventListener("change", (e) => engine.setFilter("automation_type", e.target.value));
    els.filterDepartment.addEventListener("change", (e) => engine.setFilter("department", e.target.value));
    els.filterIndustry.addEventListener("change", (e) => engine.setFilter("industry", e.target.value));

    els.clearFiltersBtn.addEventListener("click", () => {
      els.filterAutomationType.value = "";
      els.filterDepartment.value = "";
      els.filterIndustry.value = "";
      els.searchInput.value = "";
      engine.clearFiltersAndSearch();
    });

    let searchDebounce = null;
    els.searchInput.addEventListener("input", (e) => {
      const query = e.target.value;
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => engine.setSearchQuery(query), 120);
    });

    els.toggleAnalytics.addEventListener("change", (e) => {
      els.sideAnalytics.style.display = e.target.checked ? "block" : "none";
      saveLayout();
      rebuildGridAfterReflow();
    });

    els.toggleInfra.addEventListener("change", (e) => {
      document.querySelector(".kpis").style.display = e.target.checked ? "grid" : "none";
      saveLayout();
      rebuildGridAfterReflow();
    });
  }

  function startFpsReadout() {
    let lastFrameTime = performance.now();
    let frameCount = 0;
    function fpsLoop(now) {
      frameCount++;
      const delta = now - lastFrameTime;
      if (delta >= 500) {
        els.fpsReadout.textContent = Math.round((frameCount * 1000) / delta);
        frameCount = 0;
        lastFrameTime = now;
      }
      requestAnimationFrame(fpsLoop);
    }
    requestAnimationFrame(fpsLoop);
  }

  function bootstrap() {
    restoreLayout();
    wireEvents();
    engine.subscribe(render);
    startFpsReadout();
    updateDebugOverlay();
    fetch("./automation_projects.csv")
      .then((r) => r.text())
      .then((text) => {
        engine.initializeFromCsv(text);
        populateFilterOptions();
        window.initializeRpaStream((batch) => engine.handleIncomingBatch(batch), "./automation_projects.csv");
      });
    window.setInterval(updateDebugOverlay, 1000);
  }
  bootstrap();
})();