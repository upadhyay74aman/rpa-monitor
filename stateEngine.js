(function (window) {
  "use strict";

  const INT_FIELDS = ["robots_deployed", "budget_usd", "annual_savings_usd", "employee_hours_saved"];
  const FLOAT_FIELDS = ["roi_percent"];
  const SEARCH_FIELDS = ["project_name", "company_id", "implementation_partner", "country"];
  const NUMERIC_KEYS = new Set([
    "robots_deployed",
    "budget_usd",
    "annual_savings_usd",
    "roi_percent",
    "employee_hours_saved"
  ]);

  const fmtCurrency = (n) => "$" + Math.round(n || 0).toLocaleString("en-US");
  const fmtInt = (n) => Math.round(n || 0).toLocaleString("en-US");
  const fmtRoi = (n) => {
    // roi_percent can't physically go below -100% (you can't lose more than
    // 100% of the investment), so that floor is real. There's no dataset-backed
    // upper bound, so don't clip legitimately high ROI values — just round to
    // 2 decimal places as the spec asks.
    const v = Math.max(-100, Number(n) || 0);
    return (v >= 0 ? "+" : "") + v.toFixed(2) + "%";
  };

  function createStateEngine() {
    const rowsById = new Map();
    const allUids = [];
    const allUidSet = new Set();
    const deptStats = new Map();
    const listeners = new Set();

    let activeIndices = [];
    let sortChain = [];
    let activeFilters = { automation_type: "", department: "", industry: "" };
    let searchTokens = [];
    let isPaused = false;
    let pendingBuffer = [];
    let pendingBufferedRows = 0;
    let totalStreamedRows = 0;
    let cumRobots = 0;
    let cumSavings = 0;
    let totalTicks = 0;
    let flashCounter = 0;
    let lastTickSize = 0;

    function notify(reason) {
      const snapshot = getSnapshot();
      listeners.forEach((listener) => listener(snapshot, reason));
    }

    function subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }

    function getSnapshot() {
      return {
        rowsById,
        allUids,
        activeIndices,
        sortChain,
        activeFilters,
        searchTokens,
        isPaused,
        pendingBufferedRows,
        totalStreamedRows,
        cumRobots,
        cumSavings,
        totalTicks,
        lastTickSize
      };
    }

    function rowMatchesFilters(row) {
      if (!row) return false;
      if (activeFilters.automation_type && row.automation_type !== activeFilters.automation_type) return false;
      if (activeFilters.department && row.department !== activeFilters.department) return false;
      if (activeFilters.industry && row.industry !== activeFilters.industry) return false;
      return true;
    }

    function rowMatchesSearch(row) {
      if (!row || searchTokens.length === 0) return !!row;
      const haystack = SEARCH_FIELDS.map((field) => String(row[field] || "").toLowerCase()).join(" | ");
      return searchTokens.every((token) => haystack.includes(token));
    }

    function rowIsActive(row) {
      return rowMatchesFilters(row) && rowMatchesSearch(row);
    }

    // uid strings look like "uid-row-2" / "uid-row-10". Comparing them as plain
    // strings sorts "uid-row-10" before "uid-row-2" (lexicographic), so ties on
    // the active sort key would jitter on every tick instead of staying put.
    // Pull the trailing integer out and compare numerically for a true stable tiebreak.
    function uidOrdinal(uid) {
      const n = parseInt(String(uid).slice(uid.lastIndexOf("-") + 1), 10);
      return Number.isNaN(n) ? 0 : n;
    }

    function compareRows(uidA, uidB) {
      const a = rowsById.get(uidA);
      const b = rowsById.get(uidB);
      for (const { key, dir } of sortChain) {
        const av = a ? a[key] : "";
        const bv = b ? b[key] : "";
        if (NUMERIC_KEYS.has(key)) {
          if (av !== bv) return (Number(av) - Number(bv)) * dir;
        } else {
          const as = String(av).toLowerCase();
          const bs = String(bv).toLowerCase();
          if (as !== bs) return as < bs ? -1 * dir : 1 * dir;
        }
      }
      if (uidA === uidB) return 0;
      return uidOrdinal(uidA) - uidOrdinal(uidB);
    }

    function updateDeptForNewRow(row) {
      if (!deptStats.has(row.department)) deptStats.set(row.department, { count: 0, savingsSum: 0 });
      const stat = deptStats.get(row.department);
      stat.count++;
      stat.savingsSum += row.annual_savings_usd || 0;
    }

    function updateDeptForChangedRow(existing, freshRow) {
      const oldSavings = existing.annual_savings_usd || 0;
      const newSavings = freshRow.annual_savings_usd || 0;

      if (existing.department === freshRow.department) {
        const stat = deptStats.get(freshRow.department);
        if (stat) stat.savingsSum += newSavings - oldSavings;
        return;
      }

      const oldStat = deptStats.get(existing.department);
      if (oldStat) {
        oldStat.count--;
        oldStat.savingsSum -= oldSavings;
      }
      updateDeptForNewRow(freshRow);
    }

    function rebuildActiveIndices(reason) {
      activeIndices = allUids.filter((uid) => rowIsActive(rowsById.get(uid)));
      if (sortChain.length) activeIndices.sort(compareRows);
      notify(reason || "rebuild");
    }

    function mergeTouchedRows(touchedOrder) {
      if (!touchedOrder.length) return;

      const touchedSet = new Set(touchedOrder);

      if (!sortChain.length) {
        // No sort active -> baseline order is allUids (dataset/insertion order).
        // Keep all untouched active rows exactly where they were, then walk
        // allUids once to find the correct insertion slot for each touched row
        // that just became active, so it lands in dataset order rather than
        // always at the end of the list.
        const positionInAllUids = new Map();
        for (let i = 0; i < activeIndices.length; i++) {
          positionInAllUids.set(activeIndices[i], i);
        }

        const stillActive = [];
        for (let i = 0; i < activeIndices.length; i++) {
          const uid = activeIndices[i];
          if (touchedSet.has(uid)) {
            if (rowIsActive(rowsById.get(uid))) stillActive.push(uid);
          } else {
            stillActive.push(uid);
          }
        }

        const newlyActive = [];
        for (let i = 0; i < touchedOrder.length; i++) {
          const uid = touchedOrder[i];
          if (positionInAllUids.has(uid)) continue;
          if (rowIsActive(rowsById.get(uid))) newlyActive.push(uid);
        }

        if (newlyActive.length === 0) {
          activeIndices = stillActive;
          return;
        }

        const allUidPos = new Map();
        for (let i = 0; i < allUids.length; i++) allUidPos.set(allUids[i], i);
        newlyActive.sort((a, b) => allUidPos.get(a) - allUidPos.get(b));

        const merged = [];
        let ni = 0;
        for (let i = 0; i < stillActive.length; i++) {
          const uid = stillActive[i];
          const uidPos = allUidPos.get(uid);
          while (ni < newlyActive.length && allUidPos.get(newlyActive[ni]) < uidPos) {
            merged.push(newlyActive[ni]);
            ni++;
          }
          merged.push(uid);
        }
        while (ni < newlyActive.length) {
          merged.push(newlyActive[ni]);
          ni++;
        }

        activeIndices = merged;
        return;
      }

      const untouchedActive = [];
      for (let i = 0; i < activeIndices.length; i++) {
        const uid = activeIndices[i];
        if (!touchedSet.has(uid)) untouchedActive.push(uid);
      }

      const changedVisible = [];
      for (let i = 0; i < touchedOrder.length; i++) {
        const uid = touchedOrder[i];
        if (rowIsActive(rowsById.get(uid))) changedVisible.push(uid);
      }
      changedVisible.sort(compareRows);

      const merged = [];
      let left = 0;
      let right = 0;

      while (left < untouchedActive.length && right < changedVisible.length) {
        if (compareRows(untouchedActive[left], changedVisible[right]) <= 0) {
          merged.push(untouchedActive[left]);
          left++;
        } else {
          merged.push(changedVisible[right]);
          right++;
        }
      }
      while (left < untouchedActive.length) {
        merged.push(untouchedActive[left]);
        left++;
      }
      while (right < changedVisible.length) {
        merged.push(changedVisible[right]);
        right++;
      }

      activeIndices = merged;
    }

    function applyBatch(batch, options) {
      const opts = options || {};
      if (!Array.isArray(batch) || batch.length === 0) return;

      const touchedOrder = [];
      const touchedSet = new Set();
      totalStreamedRows += batch.length;
      totalTicks++;
      lastTickSize = batch.length;

      for (let i = 0; i < batch.length; i++) {
        const freshRow = batch[i];
        const uid = freshRow.internal_uid;
        const existing = rowsById.get(uid);

        if (!touchedSet.has(uid)) {
          touchedSet.add(uid);
          touchedOrder.push(uid);
        }

        if (existing) {
          cumRobots += (freshRow.robots_deployed || 0) - (existing.robots_deployed || 0);
          cumSavings += (freshRow.annual_savings_usd || 0) - (existing.annual_savings_usd || 0);
          updateDeptForChangedRow(existing, freshRow);
        } else {
          allUidSet.add(uid);
          allUids.push(uid);
          cumRobots += freshRow.robots_deployed || 0;
          cumSavings += freshRow.annual_savings_usd || 0;
          updateDeptForNewRow(freshRow);
        }

        if (freshRow.project_status === "Failed" || freshRow.roi_percent < 0) {
          freshRow._flashToken = ++flashCounter;
        } else {
          freshRow._flashToken = 0;
        }
        rowsById.set(uid, freshRow);
      }

      mergeTouchedRows(touchedOrder);
      if (!opts.silent) notify("batch");
    }

    function handleIncomingBatch(batch) {
      if (isPaused) {
        pendingBuffer.push(batch);
        pendingBufferedRows += batch.length;
        lastTickSize = batch.length;
        notify("buffer");
        return;
      }
      applyBatch(batch);
    }

    function togglePause() {
      isPaused = !isPaused;
      if (isPaused) {
        notify("pause");
        return true;
      }

      const buffered = pendingBuffer;
      pendingBuffer = [];
      pendingBufferedRows = 0;
      for (let i = 0; i < buffered.length; i++) {
        applyBatch(buffered[i], { silent: true });
      }
      notify("resume");
      return false;
    }

    function setSort(key, append) {
      if (!append) {
        const existing = sortChain.find((item) => item.key === key);
        if (sortChain.length === 1 && existing) existing.dir *= -1;
        else sortChain = [{ key, dir: 1 }];
      } else {
        const existing = sortChain.find((item) => item.key === key);
        if (existing) existing.dir *= -1;
        else sortChain = sortChain.concat({ key, dir: 1 });
      }
      rebuildActiveIndices("sort");
    }

    function setFilter(key, value) {
      activeFilters = Object.assign({}, activeFilters, { [key]: value });
      rebuildActiveIndices("filter");
    }

    function setSearchQuery(query) {
      searchTokens = String(query || "").toLowerCase().trim().split(/\s+/).filter(Boolean);
      rebuildActiveIndices("search");
    }

    function clearFiltersAndSearch() {
      activeFilters = { automation_type: "", department: "", industry: "" };
      searchTokens = [];
      rebuildActiveIndices("clear");
    }

    function getFilterOptions() {
      const automationTypes = new Set();
      const departments = new Set();
      const industries = new Set();
      rowsById.forEach((row) => {
        automationTypes.add(row.automation_type);
        departments.add(row.department);
        industries.add(row.industry);
      });
      return {
        automationTypes: Array.from(automationTypes).sort(),
        departments: Array.from(departments).sort(),
        industries: Array.from(industries).sort()
      };
    }

    function getDepartmentRankings(limit) {
      return Array.from(deptStats.entries())
        .filter((entry) => entry[1].count > 0)
        .sort((a, b) => b[1].savingsSum - a[1].savingsSum)
        .slice(0, limit || 14);
    }

    function parseCsvRows(csvText) {
      const lines = String(csvText || "").trim().split("\n");
      if (lines.length < 2) return [];

      const headers = lines[0].split(",").map((header) => header.trim().replace(/\r$/, ""));
      const rows = [];

      for (let i = 1; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        const values = lines[i].split(",");
        if (values.length !== headers.length) continue;

        const row = { internal_uid: "uid-row-" + i };
        for (let j = 0; j < headers.length; j++) {
          const header = headers[j];
          const value = values[j].trim().replace(/\r$/, "");
          if (INT_FIELDS.includes(header)) row[header] = parseInt(value, 10) || 0;
          else if (FLOAT_FIELDS.includes(header)) row[header] = parseFloat(value) || 0;
          else row[header] = value;
        }
        row._flashToken = 0;
        rows.push(row);
      }

      return rows;
    }

    function initializeFromCsv(csvText) {
      const rows = parseCsvRows(csvText);

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (!allUidSet.has(row.internal_uid)) {
          allUidSet.add(row.internal_uid);
          allUids.push(row.internal_uid);
        }
        rowsById.set(row.internal_uid, row);
        cumRobots += row.robots_deployed || 0;
        cumSavings += row.annual_savings_usd || 0;
        updateDeptForNewRow(row);
      }

      activeIndices = allUids.slice();
      notify("init");
    }

    return {
      subscribe,
      getSnapshot,
      initializeFromCsv,
      applyBatch,
      handleIncomingBatch,
      togglePause,
      setSort,
      setFilter,
      setSearchQuery,
      clearFiltersAndSearch,
      getFilterOptions,
      getDepartmentRankings,
      formatters: { fmtCurrency, fmtInt, fmtRoi }
    };
  }

  window.RpaStateEngine = { createStateEngine };
})(window);