/**
 * ============================================================================
 * OFFICIAL HACKATHON TELEMETRY PIPELINE ENGINE (dataStream.js)
 * — PATCHED FOR ACTUAL DATASET SCHEMA (rpa_database_2026.csv / automation_projects.csv) —
 * ============================================================================
 *
 * PUBLIC API (unchanged from original kit):
 *   window.initializeRpaStream(callback, csvUrl)
 *   - callback(incomingBatch): incomingBatch is an array of updated/new row objects
 *   - csvUrl: path to the CSV, served from your project's public folder
 *
 * PATCH NOTES:
 * 1) Original mutation logic referenced placeholder fields (employee_count,
 *    annual_revenue_usd, customer_count, market_share_percent) that do not
 *    exist in the real dataset. Mutation now targets the REAL columns:
 *    budget_usd, annual_savings_usd, roi_percent, robots_deployed,
 *    employee_hours_saved, project_status.
 * 2) Added explicit anomaly injection required by Feature 3 of the spec:
 *    a small fraction of ticks now inject project_status = 'Failed' and/or
 *    a negative roi_percent, so the alert system has real signal to react to.
 * ============================================================================
 */

(function () {
  let memoryPool = [];
  let isInitialized = false;

  const randomRange = (min, max) => Math.random() * (max - min) + min;

  const INT_FIELDS = ['robots_deployed', 'budget_usd', 'annual_savings_usd', 'employee_hours_saved'];
  const FLOAT_FIELDS = ['roi_percent'];

  const parseCSV = (csvText) => {
    console.log('⚡ [Pipeline Engine] Parsing Official Hackathon CSV into Memory Pool...');
    const lines = csvText.trim().split('\n');

    const headers = (lines[0].split('\t').length > lines[0].split(',').length
      ? lines[0].split('\t')
      : lines[0].split(',')
    ).map((h) => h.trim().replace(/\r$/, ''));

    const parsedData = [];

    for (let i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      const values = (lines[i].includes('\t') ? lines[i].split('\t') : lines[i].split(','));
      if (values.length !== headers.length) continue;

      const rowObject = { internal_uid: `uid-row-${i}` };
      headers.forEach((header, index) => {
        let val = values[index].trim().replace(/\r$/, '');
        if (INT_FIELDS.includes(header)) {
          rowObject[header] = parseInt(val, 10) || 0;
        } else if (FLOAT_FIELDS.includes(header)) {
          rowObject[header] = parseFloat(val) || 0;
        } else {
          rowObject[header] = val;
        }
      });
      parsedData.push(rowObject);
    }
    return parsedData;
  };

  window.initializeRpaStream = async function (callback, csvUrl = '/rpa_database_2026.csv') {
    if (typeof callback !== 'function') {
      console.error('❌ [Pipeline Error] initializeRpaStream requires a callback function execution loop.');
      return;
    }
    if (isInitialized) {
      console.warn('⚠️ [Pipeline Warning] Telemetry stream has already been initialized.');
      return;
    }

    try {
      console.log(`📦 [Pipeline Engine] Fetching schema baseline from target destination: ${csvUrl}`);
      const response = await fetch(csvUrl);
      if (!response.ok) throw new Error(`HTTP network error! status: ${response.status}`);

      const csvText = await response.text();
      memoryPool = parseCSV(csvText);
      isInitialized = true;

      console.log(`✅ [Pipeline Engine] Successfully mapped ${memoryPool.length} rows directly into RAM.`);
      console.log('🚀 [Pipeline Engine] Starting high-frequency 200ms background execution firehose...');

      setInterval(() => {
        if (memoryPool.length === 0) return;

        const batchSize = Math.floor(randomRange(5, 50));
        const incomingBatch = [];

        for (let i = 0; i < batchSize; i++) {
          const targetIndex = Math.floor(randomRange(0, memoryPool.length));
          const row = { ...memoryPool[targetIndex] };

          const roll = Math.random();

          if (roll > 0.985) {
            // ~1.5% chance: critical failure injection (required by alert spec)
            row.project_status = 'Failed';
            row.roi_percent = parseFloat((-1 * randomRange(1, 40)).toFixed(2));
            row.annual_savings_usd = Math.max(0, row.annual_savings_usd - Math.floor(randomRange(10000, 80000)));
          } else if (roll > 0.95) {
            // ~3.5% chance: negative-ROI anomaly without full failure
            row.roi_percent = parseFloat((-1 * randomRange(0.5, 15)).toFixed(2));
            row.budget_usd += Math.floor(randomRange(-50000, 50000));
          } else {
            // Standard high-frequency operational noise
            row.annual_savings_usd += Math.floor(randomRange(-500, 1500));
            row.employee_hours_saved += Math.floor(randomRange(-20, 60));
            row.roi_percent = parseFloat((row.roi_percent + randomRange(-0.5, 0.8)).toFixed(2));
            row.budget_usd += Math.floor(randomRange(-10000, 20000));
          }

          row.budget_usd = Math.max(0, row.budget_usd);
          row.annual_savings_usd = Math.max(0, row.annual_savings_usd);
          row.robots_deployed = Math.max(1, row.robots_deployed);
          row.employee_hours_saved = Math.max(0, row.employee_hours_saved);
          row.roi_percent = parseFloat(Math.max(-100, row.roi_percent).toFixed(2));

          memoryPool[targetIndex] = row;
          incomingBatch.push(row);
        }

        callback(incomingBatch);
      }, 200);
    } catch (error) {
      console.error('❌ [Pipeline Critical Crash] Could not initialize telemetry stream:', error);
      console.error('👉 Fix Checklist: Verify server configuration, absolute path constraints, or check if the asset is missing inside your root public/ directory.');
    }
  };
})();