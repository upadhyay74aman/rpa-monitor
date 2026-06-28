(function (window) {
  "use strict";

  const ROW_H = 30;
  const COLS = [
    { key: "internal_uid", cls: "col-uid" },
    { key: "project_name", cls: "col-name" },
    { key: "company_id", cls: "col-company" },
    { key: "project_status", cls: "col-status", isStatus: true },
    { key: "automation_type", cls: "col-type" },
    { key: "robots_deployed", cls: "col-robots", fmt: "fmtInt" },
    { key: "budget_usd", cls: "col-budget", fmt: "fmtCurrency" },
    { key: "annual_savings_usd", cls: "col-savings", fmt: "fmtCurrency" },
    { key: "roi_percent", cls: "col-roi", isRoi: true },
    { key: "employee_hours_saved", cls: "col-hours", fmt: "fmtInt" },
    { key: "department", cls: "col-dept" },
    { key: "implementation_partner", cls: "col-partner" },
    { key: "country", cls: "col-country" },
    { key: "industry", cls: "col-industry" }
  ];

  function createVirtualGrid(options) {
    const viewport = options.viewport;
    const headerRow = options.headerRow;
    const spacer = options.spacer;
    const emptyState = options.emptyState;
    const formatters = options.formatters;
    const onPoolChange = options.onPoolChange || function () {};

    let pool = [];
    let poolSize = 0;
    let headerHeight = 32;
    let activeIndices = [];
    let rowsById = new Map();
    let scrollRaf = null;

    // DESIGN NOTE (Feature 8): the spec's "500+ concurrent rows" requirement
    // means the DATASET must scale to 500+ rows under live virtualization, not
    // that the DOM pool itself should hold 500+ nodes — the whole point of a
    // virtualized grid is that the pool stays fixed to the viewport regardless
    // of dataset size. Confirmed by the spec's own guardrail: "DOM must contain
    // only a fixed count of HTML row nodes matching the user's physical
    // viewport height; swap the inner node text values dynamically during
    // scrolling." This pool is intentionally small (~viewport height / row
    // height) and recycled, which is the correct virtualization behavior.
    //
    // DEFENSIVE GUARD: with the current index.html (blocking <link> in <head>,
    // plain blocking <script> tags at the end of <body>), styles.css is always
    // parsed and applied before this runs, so viewport.clientHeight is never 0
    // on the real first load. But if the load order ever changes — deferred
    // scripts, async-loaded CSS, or a manual rebuildPool() call before the
    // viewport is laid out — clientHeight could read 0 and silently produce an
    // empty pool. Retry the WHOLE function on a short delay rather than
    // returning early mid-way, so we never leave poolSize/pool/onPoolChange in
    // a half-initialized state.
    function buildPool() {
      if (viewport.clientHeight === 0) {
        window.setTimeout(buildPool, 50);
        return;
      }

      spacer.innerHTML = "";
      headerHeight = headerRow ? headerRow.getBoundingClientRect().height : 0;
      poolSize = Math.ceil(viewport.clientHeight / ROW_H) + 6;
      pool = [];

      for (let i = 0; i < poolSize; i++) {
        const rowEl = document.createElement("div");
        rowEl.className = "vrow";

        const colEls = {};
        for (let j = 0; j < COLS.length; j++) {
          const column = COLS[j];
          const cell = document.createElement("div");
          cell.className = "c " + column.cls;
          rowEl.appendChild(cell);
          colEls[column.key] = cell;
        }

        spacer.appendChild(rowEl);
        pool.push({ el: rowEl, cols: colEls, boundUid: null, lastFailFlash: 0, flashClass: "" });
      }

      onPoolChange(poolSize);
    }

    function paintRow(poolItem, uid) {
      const row = rowsById.get(uid);
      poolItem.boundUid = uid;

      if (!row) {
        poolItem.el.style.visibility = "hidden";
        return;
      }

      poolItem.el.style.visibility = "visible";

      for (let i = 0; i < COLS.length; i++) {
        const column = COLS[i];
        const cell = poolItem.cols[column.key];
        const raw = row[column.key];

        if (column.isStatus) {
          cell.textContent = raw;
          cell.className = "c " + column.cls + " c-status status-" + raw;
        } else if (column.isRoi) {
          cell.textContent = formatters.fmtRoi(raw);
          cell.className = "c " + column.cls + " " + (raw < 0 ? "roi-neg" : "roi-pos");
        } else if (column.fmt) {
          cell.textContent = formatters[column.fmt](raw);
          cell.className = "c " + column.cls;
        } else {
          cell.textContent = raw;
          cell.className = "c " + column.cls;
        }
      }

      const shouldFlash = row.project_status === "Failed" || row.roi_percent < 0;
      
      // THE FIX: Properly clearing recycled nodes
      if (shouldFlash) {
        if (row._flashToken !== poolItem.lastFailFlash) {
          const nextClass = poolItem.flashClass === "flash-fail-a" ? "flash-fail-b" : "flash-fail-a";
          poolItem.el.classList.remove("flash-fail-a", "flash-fail-b");
          poolItem.el.classList.add(nextClass);
          poolItem.flashClass = nextClass;
          poolItem.lastFailFlash = row._flashToken;
        }
      } else {
        // Scrub the red flash classes off when this DOM node is recycled for a healthy row
        poolItem.el.classList.remove("flash-fail-a", "flash-fail-b");
        poolItem.flashClass = "";
        poolItem.lastFailFlash = 0;
      }
    }

    function hidePool() {
      for (let i = 0; i < pool.length; i++) {
        pool[i].el.style.visibility = "hidden";
        pool[i].boundUid = null;
      }
    }

    function repositionAndPaint() {
      if (!activeIndices.length) {
        hidePool();
        return;
      }

      const scrollTop = Math.max(0, viewport.scrollTop - headerHeight);
      const startIndex = Math.max(0, Math.floor(scrollTop / ROW_H) - 2);

      for (let i = 0; i < poolSize; i++) {
        const dataIndex = startIndex + i;
        const poolItem = pool[i];

        if (dataIndex >= activeIndices.length) {
          poolItem.el.style.visibility = "hidden";
          poolItem.boundUid = null;
          continue;
        }

        poolItem.el.style.transform = "translateY(" + (dataIndex * ROW_H) + "px)";
        paintRow(poolItem, activeIndices[dataIndex]);
      }
    }

    function render(snapshot) {
      activeIndices = snapshot.activeIndices || [];
      rowsById = snapshot.rowsById || rowsById;

      spacer.style.height = (activeIndices.length * ROW_H) + "px";
      emptyState.hidden = activeIndices.length !== 0;
      emptyState.style.paddingTop = headerHeight + "px";
      repositionAndPaint();
    }

    viewport.addEventListener("scroll", () => {
      if (scrollRaf) return;
      scrollRaf = requestAnimationFrame(() => {
        repositionAndPaint();
        scrollRaf = null;
      });
    });

    let resizeTimer = null;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        buildPool();
        render({ activeIndices, rowsById });
      }, 150);
    });

    buildPool();

    return {
      render,
      rebuildPool: buildPool,
      getPoolSize: () => poolSize
    };
  }

  window.RpaVirtualGrid = { createVirtualGrid };
})(window);