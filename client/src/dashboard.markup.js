// Exact body markup ported verbatim from the original dashboard HTML.
// Rendered into the DOM by App.jsx so the original logic (which uses
// getElementById) operates against an identical DOM tree.
/* eslint-disable */
export const DASHBOARD_HTML = `

<!-- Processing loader overlay — shown while an uploaded file is being cleaned & the dashboard rebuilt -->
<div id="processingOverlay" style="display:none;">
  <div class="proc-box">
    <div class="proc-spinner"></div>
    <div class="proc-msg" id="processingMsg">Processing…</div>
  </div>
</div>

<!-- Floating Reorder-Now total panel (draggable; defaults to right-middle of viewport) -->
<div id="reorderFloatingTotal" aria-live="polite">
  <div class="rft-drag" title="Drag to reposition"><span>Drag</span><span class="rft-drag-handle">⠿</span></div>
  <div class="rft-label">Total Order Qty</div>
  <div class="rft-qty" id="rftQty">0</div>
  <div class="rft-meta"><span>Rows: <strong id="rftRows">0</strong></span><span>Vendors: <strong id="rftVendors">0</strong></span></div>
</div>

<!-- AI settings gear (fixed top-right) -->
<button id="aiGearBtn" type="button" class="ai-gear" title="AI settings — API key, model, system prompt" aria-label="AI settings">⚙</button>

<!-- AI settings modal -->
<div id="aiSettingsOverlay" class="ai-overlay" aria-hidden="true">
  <div class="ai-modal" role="dialog" aria-labelledby="aiSettingsTitle">
    <div class="ai-modal-head">
      <h3 id="aiSettingsTitle">AI Settings</h3>
      <button type="button" class="ai-close" id="aiSettingsClose" aria-label="Close">×</button>
    </div>
    <div class="ai-modal-body">
      <label class="ai-field-label">Anthropic API key</label>
      <div class="ai-field-row">
        <input type="password" id="aiApiKeyInput" class="ai-input" placeholder="sk-ant-..." autocomplete="off" spellcheck="false">
        <button type="button" class="ai-input-toggle" id="aiApiKeyShow" title="Show / hide">👁</button>
      </div>
      <div class="ai-help">Stored only in your browser (localStorage). <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener" style="color: var(--accent);">Get a key →</a></div>

      <label class="ai-field-label">Model</label>
      <select id="aiModelSelect" class="ai-input">
        <option value="claude-sonnet-4-6">Sonnet 4.6 — recommended (balanced cost / smarts)</option>
        <option value="claude-opus-4-6">Opus 4.6 — most capable (slowest, most expensive)</option>
        <option value="claude-haiku-4-5-20251001">Haiku 4.5 — fastest, cheapest</option>
      </select>
      <div class="ai-help">Different models have different speed / cost / capability tradeoffs.</div>

      <label class="ai-field-label">System prompt</label>
      <textarea id="aiSystemPromptInput" class="ai-input" rows="6">You are a senior inventory analyst helping the user reason about SKU-level demand, supply, and reorder decisions. The user will paste structured briefs from their inventory dashboard. Be specific: cite numbers from the brief, reference particular months when relevant, distinguish ongoing trends from one-off spikes. When the data is ambiguous, say so plainly. Offer pragmatic recommendations the user can act on this week. Be concise but thorough — short paragraphs and bullet points are fine.</textarea>
      <div class="ai-help">Tune Claude's persona / focus for inventory questions.</div>

      <div class="ai-stats">
        <div><strong id="aiTokensIn">0</strong> input tokens</div>
        <div><strong id="aiTokensOut">0</strong> output tokens</div>
        <div>~<strong id="aiCostEstimate">$0.00</strong> estimated</div>
      </div>
    </div>
    <div class="ai-modal-foot">
      <button type="button" class="dl-btn" id="aiSettingsReset">Reset prompt</button>
      <button type="button" class="dl-btn primary" id="aiSettingsSave">Save</button>
    </div>
  </div>
</div>

<!-- AI chat side panel -->
<aside id="aiChatPanel" class="ai-chat-panel" aria-hidden="true">
  <div class="ai-chat-head">
    <div class="ai-chat-title">
      <span class="ai-chat-sparkle">✦</span>
      <strong id="aiChatSkuName">AI Analysis</strong>
    </div>
    <div class="ai-chat-actions">
      <button type="button" class="dl-btn" id="aiChatCopy" title="Copy current SKU brief to clipboard">Copy brief</button>
      <button type="button" class="dl-btn" id="aiChatNew" title="Start a new conversation">New chat</button>
      <button type="button" class="ai-close" id="aiChatClose" aria-label="Close">×</button>
    </div>
  </div>

  <div class="ai-chat-context" id="aiChatContext">
    <div class="ai-chat-context-head">
      <strong>SKU context</strong>
      <button type="button" class="ai-context-toggle" id="aiChatContextToggle">▾ collapse</button>
    </div>
    <pre id="aiChatContextBody" class="ai-chat-context-body"></pre>
  </div>

  <div class="ai-chat-messages" id="aiChatMessages">
    <div class="ai-chat-empty">Ask anything about this SKU. Try one of the suggested questions in the brief, or type your own.</div>
  </div>

  <div class="ai-chat-input-row">
    <textarea id="aiChatInput" class="ai-input" rows="2" placeholder="Ask why this SKU spiked, whether to order, what trends to watch for..."></textarea>
    <button type="button" class="dl-btn primary" id="aiChatSend">Send</button>
  </div>
  <div class="ai-chat-footer">
    <span id="aiChatStatus"></span>
    <span id="aiChatSessionCost" style="color: var(--text-3); margin-left: auto;"></span>
  </div>
</aside>

<header class="header reveal">
  <div class="brand">
    <span class="brand-tag">v4 · Folders · Children · Editable Reorder</span>
    <h1>Inventory <em>Intelligence</em></h1>
    <p>Parent-child hierarchy · folders · vendors · ABC · slow-mover focus</p>
  </div>
  <div class="header-meta">
    Report generated<br>
    <strong>08 May 2026</strong><br>
    <span style="opacity:0.5">v4.0 · Master-list edition</span><br>
    <button class="theme-toggle" id="themeToggle" aria-label="Toggle light/dark theme" type="button">
      <span data-theme-val="dark">☾ DARK</span>
      <span data-theme-val="light">☀ LIGHT</span>
    </button>
  </div>
</header>

<!-- 01 KPIs -->
<section class="section">
  <div class="section-head">
    <span class="section-num">01 /</span>
    <span class="section-title">Portfolio at a <em>glance</em></span>
    <span class="section-rule"></span>
  </div>
  <div class="kpis" id="kpis"></div>
</section>

<!-- 02 Aggregate flow -->
<section class="section">
  <div class="section-head">
    <span class="section-num">02 /</span>
    <span class="section-title">Aggregate flow — <em>24 months</em></span>
    <span class="section-rule"></span>
  </div>
  <div class="insight reveal reveal-1">
    <span class="insight-icon">↗</span>
    <span class="insight-text" id="aggInsightText"></span>
  </div>
  <div class="panel reveal reveal-2">
    <h3 class="panel-title">Total purchases vs sales · all 3,692 SKU</h3>
    <p class="panel-sub">bars: purchases · line: sales</p>
    <div class="chart-wrap xtall"><canvas id="aggChart"></canvas></div>
  </div>
</section>

<!-- 03 Stock health -->
<section class="section">
  <div class="section-head">
    <span class="section-num">03 /</span>
    <span class="section-title">Stock health & <em>ABC mix</em></span>
    <span class="section-rule"></span>
  </div>
  <div class="grid-3-cols">
    <div class="panel reveal reveal-1">
      <h3 class="panel-title">Stock status</h3>
      <p class="panel-sub">products by inventory state</p>
      <div class="chart-wrap"><canvas id="statusChart"></canvas></div>
    </div>
    <div class="panel reveal reveal-2">
      <h3 class="panel-title">ABC · Pareto</h3>
      <p class="panel-sub">A items drive 80% of revenue</p>
      <div class="chart-wrap"><canvas id="abcChart"></canvas></div>
    </div>
    <div class="panel reveal reveal-3">
      <h3 class="panel-title">Mover status</h3>
      <p class="panel-sub">activity in last 13 months</p>
      <div class="chart-wrap"><canvas id="moverChart"></canvas></div>
    </div>
  </div>
</section>

<!-- 04 Action centre -->
<section class="section">
  <div class="section-head">
    <span class="section-num">04 /</span>
    <span class="section-title">Action centre — <em>monthly view, filters & exports</em></span>
    <span class="section-rule"></span>
  </div>

  <div class="insight danger reveal reveal-1">
    <span class="insight-icon">!</span>
    <span class="insight-text" id="actionInsightText"></span>
  </div>

  <div class="panel reveal reveal-2" id="section4Panel">
    <div class="download-row">
      <button class="dl-btn primary" id="dlReorder"><span class="icn">↓</span> Reorder Plan (uses my edits)</button>
      <button class="dl-btn" id="dlSlow"><span class="icn">↓</span> Slow / Non-Moving</button>
      <button class="dl-btn" id="dlOver"><span class="icn">↓</span> Overstocked</button>
      <button class="dl-btn" id="dlMonthly"><span class="icn">↓</span> Current monthly view</button>
      <button class="dl-btn" id="dlMaster"><span class="icn">↓</span> Master parent-child list</button>
    </div>

    <div class="filter-bar">
      <div class="filter-group multi" data-filter="search">
        <div class="filter-label">Search product <span class="ms-count" id="searchCount"></span></div>
        <input class="ms-input" id="searchInput" placeholder="Type product name — multi-select" autocomplete="off">
        <div class="ms-chips" id="searchChips"></div>
      </div>
      <div class="filter-group multi" data-filter="cat">
        <div class="filter-label">Category <span class="ms-count" id="catCount"></span></div>
        <input class="ms-input" id="catFilter" list="catList" placeholder="Type to add — multi-select" autocomplete="off">
        <datalist id="catList"></datalist>
        <div class="ms-chips" id="catChips"></div>
      </div>
      <div class="filter-group multi" data-filter="vendor">
        <div class="filter-label">Vendor <span class="ms-count" id="vendorCount"></span></div>
        <input class="ms-input" id="vendorFilter" list="vendorList" placeholder="Type vendor code or name" autocomplete="off">
        <datalist id="vendorList"></datalist>
        <div class="ms-chips" id="vendorChips"></div>
      </div>
      <div class="filter-group multi" data-filter="folder">
        <div class="filter-label">Folder <span class="ms-count" id="folderCount"></span></div>
        <input class="ms-input" id="folderFilter" list="folderList" placeholder="Type folder name — multi-select" autocomplete="off">
        <datalist id="folderList"></datalist>
        <div class="ms-chips" id="folderChips"></div>
      </div>
      <div class="filter-group multi" data-filter="abc">
        <div class="filter-label">ABC class <span class="ms-count" id="abcCount"></span></div>
        <div class="ms-toggles" id="abcToggles">
          <button class="ms-toggle" data-val="0">A</button>
          <button class="ms-toggle" data-val="1">B</button>
          <button class="ms-toggle" data-val="2">C</button>
        </div>
      </div>
      <div class="filter-group multi" data-filter="status">
        <div class="filter-label">Status <span class="ms-count" id="statusCount"></span></div>
        <div class="ms-toggles" id="statusToggles"></div>
      </div>
    </div>

    <div id="monthlyControls" style="margin-bottom: 16px;">
      <div class="filter-bar simpler">
        <div class="filter-group">
          <div class="filter-label">Period</div>
          <div class="btn-group" id="periodGroup">
            <button class="btn" data-period="6">6M</button>
            <button class="btn" data-period="12">12M</button>
            <button class="btn active" data-period="24">24M</button>
            <button class="btn" data-period="custom">Custom</button>
          </div>
          <div class="custom-range" id="customRange">
            <select id="customStart"></select>
            <span style="color:var(--text-3); font-family:var(--mono); font-size:11px">→</span>
            <select id="customEnd"></select>
          </div>
        </div>
        <div class="filter-group">
          <div class="filter-label">View</div>
          <div class="btn-group" id="viewGroup">
            <button class="btn active" data-view="sales">Sales only</button>
            <button class="btn" data-view="purchases">Purchases only</button>
            <button class="btn" data-view="both">Both</button>
          </div>
        </div>
        <div class="filter-group" style="display:flex; align-items:center; justify-content:center; gap:14px;">
          <span style="font-family:var(--mono); font-size:10px; color:var(--text-3); letter-spacing:0.1em;">
            <span style="display:inline-block; width:16px; height:2px; background:var(--indigo); margin-right:6px; vertical-align:middle;"></span>Current month
          </span>
          <span style="font-family:var(--mono); font-size:10px; color:var(--text-3); letter-spacing:0.1em;">
            <span style="display:inline-block; width:7px; height:7px; background:var(--red); border-radius:50%; box-shadow:0 0 6px var(--red); margin-right:6px; vertical-align:middle;"></span>Bulk purchase anomaly
          </span>
          <span style="font-family:var(--mono); font-size:10px; color:var(--text-3); letter-spacing:0.1em;">
            <span style="display:inline-block; width:7px; height:7px; background:var(--purple); border-radius:50%; box-shadow:0 0 6px var(--purple); margin-right:6px; vertical-align:middle;"></span>Sales spike (project order)
          </span>
        </div>
      </div>
    </div>

    <div class="tabs">
      <div class="tab active" data-tab="monthly">Monthly P/S Detail <span class="tab-count" id="monthlyCount"></span></div>
      <div class="tab" data-tab="reorder">Reorder Now <span class="tab-count" id="reorderCount"></span></div>
      <div class="tab" data-tab="bulk">Bulk-Order Flags <span class="tab-count" id="bulkCount"></span></div>
      <div class="tab" data-tab="slow">Slow / Non-Moving <span class="tab-count" id="slowCount"></span></div>
      <div class="tab" data-tab="overstock">Overstocked <span class="tab-count" id="overCount"></span></div>
    </div>

    <div class="tab-panel active" id="tab-monthly">
      <div class="mgrid-wrap">
        <table class="mgrid" id="mgridTable">
          <thead id="mgridHead"></thead>
          <tbody id="mgridBody"></tbody>
        </table>
      </div>
      <div class="paginator">
        <div class="pag-info" id="pagInfo">—</div>
        <div class="pag-controls">
          <button class="pag-btn" id="pagPrev">‹ Prev</button>
          <button class="pag-btn" id="pagNext">Next ›</button>
        </div>
      </div>
    </div>

    <div class="tab-panel" id="tab-reorder">
      <div class="reorder-actions">
        <span class="edit-summary"><strong id="editCount">0</strong> manual edits · CSV uses your final values</span>
        <button class="ai-btn" id="aiPortfolioBtn" type="button" title="Copy a portfolio-level AI brief for the currently-filtered list (aggregate stats + one-line summary per SKU). Paste into Claude to ask portfolio-wide questions.">Copy AI portfolio brief</button>
        <button class="reset-btn" id="resetEdits">Reset edits</button>
      </div>
      <div class="planning-bar">
        <div class="planning-row">
          <div class="planning-label">PLAN STOCK FOR:</div>
          <div class="btn-group" id="planningGroup">
            <button class="btn" data-days="30">30 days</button>
            <button class="btn" data-days="45">45 days</button>
            <button class="btn active" data-days="60">60 days</button>
            <button class="btn" data-days="75">75 days</button>
            <button class="btn" data-days="90">90 days</button>
            <button class="btn" data-days="120">120 days</button>
            <button class="btn" data-days="abc">By ABC</button>
          </div>
          <div class="planning-info" style="font-size:10px; line-height: 1.5;" id="planningInfo">
            <!-- populated by renderPlanningInfo() — reflects the currently-selected planning days -->
          </div>
        </div>
        <div class="planning-row">
          <div class="planning-label" title="How to estimate monthly demand from sales history. Auto routes per-SKU based on its detected demand pattern (Smooth / Lumpy / Intermittent / Trending / Erratic / Dead).">DEMAND BASIS:</div>
          <div class="btn-group" id="demandBasisGroup">
            <button class="btn active" data-method="auto"     title="Recommended. Auto-classifies each SKU and uses the right formula: Smooth→Mean, Trending→Weighted recent, Lumpy→Median (excluding spikes), Intermittent→Median 12m, Erratic→Median 6m, Dead→0.">Auto</button>
            <button class="btn"        data-method="mean6"    title="Force arithmetic mean of last 6 months sales for every SKU. Inflated by one-off spikes.">Mean 6m</button>
            <button class="btn"        data-method="median6"  title="Force median of last 6 months for every SKU. Ignores one-off spikes.">Median 6m</button>
            <button class="btn"        data-method="trimmed6" title="Force-drop the single highest month, average the rest.">Trimmed 6m</button>
            <button class="btn"        data-method="median12" title="Force median of last 12 months. Slower-moving, smoothes seasonality.">Median 12m</button>
          </div>
          <div class="planning-info" style="font-size:10px; line-height: 1.5;" id="demandInfo">
            <!-- populated by renderDemandInfo() — reflects the currently-selected method -->
          </div>
        </div>
        <div class="planning-row">
          <div class="planning-label">SHOW:</div>
          <div class="btn-group" id="reorderScopeGroup">
            <button class="btn active" data-scope="needed">Need order now <span id="scopeNeededCount" class="scope-count"></span></button>
            <button class="btn" data-scope="auto">Auto-flagged <span id="scopeAutoCount" class="scope-count"></span></button>
            <button class="btn" data-scope="manual">Manual added <span id="scopeManualCount" class="scope-count"></span></button>
            <button class="btn" data-scope="all">All <span id="scopeAllCount" class="scope-count"></span></button>
          </div>
          <div class="planning-info" style="font-size:10px; line-height: 1.5;" id="scopeInfo">
            <!-- populated by renderScopeInfo() — reflects the currently-selected scope -->
          </div>
        </div>
      </div>
      <div class="manual-add-bar">
        <div class="manual-add-row">
          <input id="manualAddSearch" list="allProductsList" placeholder="Type product name or code to add manually…" autocomplete="off">
          <datalist id="allProductsList"></datalist>
          <button class="dl-btn" id="manualAddBtn"><span class="icn">+</span> Add</button>
        </div>
        <div id="manualAddStatus" class="manual-status"></div>
        <div id="manualChips" class="manual-chips"></div>
      </div>
      <div class="mgrid-wrap compact-grid" style="max-height: 560px;">
        <table class="mgrid compact" id="rmgridTable">
          <thead id="rmgridHead"></thead>
          <tbody id="rmgridBody"></tbody>
        </table>
      </div>
      <div class="paginator">
        <div class="pag-info" id="rPagInfo">—</div>
        <div class="pag-controls">
          <button class="pag-btn" id="rPagPrev">‹ Prev</button>
          <button class="pag-btn" id="rPagNext">Next ›</button>
        </div>
      </div>
    </div>

    <div class="tab-panel" id="tab-bulk">
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>Vendor</th><th>Product</th><th>Folder</th><th>ABC</th>
            <th class="num">Stock</th><th class="num">Anomaly Months</th><th class="num">Total Buy 24M</th><th class="num">Total Sold 24M</th>
            <th>Pattern</th>
          </tr></thead>
          <tbody id="bulkBody"></tbody>
        </table>
      </div>
    </div>

    <div class="tab-panel" id="tab-slow">
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>Status</th><th>Vendor</th><th>Product</th><th>Folder</th>
            <th>ABC</th><th class="num">Stock</th><th class="num">Months Since Sale</th>
            <th class="num">Annual</th><th class="num">Turnover</th><th>Action</th>
          </tr></thead>
          <tbody id="slowBody"></tbody>
        </table>
      </div>
    </div>

    <div class="tab-panel" id="tab-overstock">
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>Vendor</th><th>Product</th><th>Folder</th>
            <th>ABC</th><th class="num">Stock</th><th class="num">Avg/mo</th>
            <th class="num">Days Cover</th><th class="num">Annual</th><th class="num">Turnover</th>
          </tr></thead>
          <tbody id="overBody"></tbody>
        </table>
      </div>
    </div>
  </div>
</section>

<!-- 05 Folder Browser -->
<section class="section">
  <div class="section-head">
    <span class="section-num">05 /</span>
    <span class="section-title">Folder <em>browser</em></span>
    <span class="section-rule"></span>
  </div>
  <div class="panel reveal reveal-1">
    <h3 class="panel-title">Browse SKUs by folder · parent + child codes</h3>
    <p class="panel-sub">select a folder to see every parent and all its children inside it</p>

    <div class="filter-bar simpler" style="margin-bottom: 20px;">
      <div class="filter-group">
        <div class="filter-label">Folder</div>
        <select id="folderSelect">
          <option value="">— Select folder —</option>
        </select>
      </div>
      <div class="filter-group">
        <div class="filter-label">Filter products in folder</div>
        <input id="folderProductFilter" placeholder="Search product name…" autocomplete="off">
      </div>
      <div class="filter-group" style="display:flex; align-items:center; justify-content:center;">
        <button class="dl-btn" id="dlFolder" disabled style="opacity:0.4"><span class="icn">↓</span> Folder contents (CSV)</button>
      </div>
    </div>

    <div class="folder-summary" id="folderSummary" style="display:none;"></div>

    <div class="table-wrap" id="folderTableWrap" style="display:none;">
      <table>
        <thead><tr>
          <th></th><th>Parent Code</th><th>Vendor</th>
          <th>ABC</th><th class="num">Age</th><th class="num">Stock</th><th class="num">Annual Sales</th>
          <th class="num">Children</th><th>Status</th>
        </tr></thead>
        <tbody id="folderBody"></tbody>
      </table>
    </div>
    <div id="folderEmpty" style="text-align:center; padding:40px; color:var(--text-3); font-family:var(--mono); font-size:12px;">
      Select a folder above to see its contents
    </div>
  </div>
</section>

<!-- 06 Vendor rollup -->
<section class="section">
  <div class="section-head">
    <span class="section-num">06 /</span>
    <span class="section-title">Vendor <em>rollup</em></span>
    <span class="section-rule"></span>
  </div>
  <div class="panel reveal reveal-1">
    <h3 class="panel-title">By supplier — SKU mix, sales, reorder pipeline</h3>
    <p class="panel-sub">click any row to filter the action centre to that vendor</p>
    <div class="table-wrap" style="max-height: 460px;">
      <table>
        <thead><tr>
          <th>Code</th><th>Vendor</th><th>City</th>
          <th class="num">SKUs</th><th class="num">Annual Sales</th>
          <th class="num">Stock</th><th class="num">Reorder Qty</th>
          <th class="num">Reorder SKUs</th><th class="num">Slow SKUs</th>
        </tr></thead>
        <tbody id="vendorBody"></tbody>
      </table>
    </div>
  </div>
</section>

<!-- 06.9 Data controls — clear everything to a blank dashboard before importing your own -->
<section class="section">
  <div class="section-head">
    <span class="section-num">DATA /</span>
    <span class="section-title">Start <em>fresh</em></span>
    <span class="section-rule"></span>
  </div>
  <div class="panel reveal reveal-1">
    <h3 class="panel-title">Clear all data</h3>
    <p class="panel-sub">Wipes the built-in demo catalog <strong>and</strong> every uploaded override (master, stock, sales, purchases) — the dashboard goes completely empty so you can build it up from your own uploads below. This cannot be undone.</p>
    <div style="display:flex; gap:12px; align-items:center; flex-wrap:wrap;">
      <button class="reset-btn" id="clearAllDataBtn" style="display:inline-block; background:rgba(255,74,92,0.12); border-color:rgba(255,74,92,0.5); color:var(--red);">⨯ Clear all data (blank dashboard)</button>
      <span id="clearAllDataStatus" style="font-family:var(--mono); font-size:11px; color:var(--text-3);"></span>
    </div>
  </div>
</section>

<!-- 07 Master mapping — direct CSV/Excel upload (also available via Google Sheets Sync). -->
<section class="section">
  <div class="section-head">
    <span class="section-num">07 /</span>
    <span class="section-title">Master parent-child <em>mapping</em></span>
    <span class="section-rule"></span>
  </div>
  <div class="panel reveal reveal-1">
    <h3 class="panel-title">Upload your real parent ↔ child ↔ folder mapping</h3>
    <p class="panel-sub">CSV or Excel (.xlsx / .xls) · once uploaded the dashboard uses your codes everywhere · stays loaded across reloads · upload once, sales data periodically · Use <strong style="color:var(--accent)">↓ Template</strong> to get a starter file</p>

    <div class="upload-zone" id="uploadZone">
      <div class="upload-meta">
        <div class="upload-status" id="uploadStatus">Using synthetic mapping — upload your real master CSV to swap in</div>
        <div class="upload-spec">
          <strong style="color:var(--accent)">Raw Product Master export?</strong> Just upload it — files with columns <span style="color:var(--text-2)">ProductId, Product Name, Parent Product, SupplierName, CreationDate, Category, Product Type</span> are auto-detected and cleaned for you (parent↔child resolved, blank/0-parent rows dropped). A cleaned preview appears below.<br><br>
          Or upload an already-clean file. Required columns (case-insensitive headers): <strong style="color:var(--accent)">parent_id, parent_code, child_code, folder</strong><br>
          Optional: <strong style="color:var(--accent)">vendor_name</strong> (aliases: vendor, vendor_code) — overrides each parent's vendor<br>
          Optional: <strong style="color:var(--accent)">category</strong> (aliases: category_name, cat, product_category) — overrides each parent's category. Shown under the vendor in the row.<br>
          Optional: <strong style="color:var(--accent)">sub_category</strong> (aliases: subcategory, sub_cat, subcat, product_sub_category) — each parent's sub-category. Every product is in exactly one category and one sub-category.<br>
          Optional: <strong style="color:var(--accent)">zone</strong> — folder's zone(s). Values: <span style="color:var(--text-2)">"1" · "1,3" · "1 3 5" · "all" (open to all zones) · "" or "unclassified" (not yet zoned). Zones 1–6.</span><br>
          Optional: <strong style="color:var(--accent)">parent_launch_date</strong> (aliases: parent_created_date, parent_added_date, parent_date) — date the parent code was created. Shown in the row meta line.<br>
          Optional: <strong style="color:var(--accent)">child_launch_date</strong> (aliases: launch_date, added_date, launched_on, date_added) — date the child code was launched / added. Displayed as a small badge in the child rows.
        </div>
      </div>
      <input type="file" accept=".csv,.tsv,.txt,.xlsx,.xls" class="upload-input" id="masterUpload">
      <button class="upload-btn" id="masterTemplateBtn" title="Download a ready-to-fill Excel (.xlsx) template with the correct headers">↓ Excel Template</button>
      <button class="upload-btn" id="uploadBtnTrigger">Choose CSV / Excel</button>
      <button class="reset-btn" id="masterReset" style="display:none;">Clear & reset</button>
    </div>
    <div id="masterPreview" style="display:none; margin-top:14px;"></div>
  </div>
</section>

<!-- 08 Stock data upload — direct CSV/Excel upload (also available via Google Sheets Sync). -->
<section class="section">
  <div class="section-head">
    <span class="section-num">08 /</span>
    <span class="section-title">Stock data <em>upload</em></span>
    <span class="section-rule"></span>
  </div>
  <div class="panel reveal reveal-1">
    <h3 class="panel-title">Refresh stock levels by parent code</h3>
    <p class="panel-sub">CSV or Excel (.xlsx / .xls) · matches by <strong style="color:var(--accent)">parent_code</strong> (case-insensitive) · updates on-hand, in-transit, pending · recalculates available + days of cover · all calcs across the dashboard refresh immediately · saved locally across reloads · Use <strong style="color:var(--accent)">↓ Template</strong> to get a starter file</p>

    <div class="upload-zone" id="stockUploadZone">
      <div class="upload-meta">
        <div class="upload-status" id="stockUploadStatus">No stock override loaded — current values come from the embedded dataset</div>
        <div class="upload-spec">
          <strong style="color:var(--accent)">Raw Stock Master export?</strong> Just upload it — files with columns <span style="color:var(--text-2)">ProductID, Name, Stock</span> are auto-detected and the stock is <strong>summed per parent</strong> (a parent and its child codes are the same physical product, so they're counted once). <em>Requires the Product Master first.</em><br><br>
          Or upload a clean file. Required column: <strong style="color:var(--accent)">parent_code</strong>. Optional (defaults to existing value if missing): <strong style="color:var(--accent)">on_hand, in_transit, pending, discontinued</strong>.
          <br>Headers are case-insensitive. Accepted aliases: <span style="color:var(--text-2)">on_hand → k, stock, qty, quantity</span> · <span style="color:var(--text-2)">in_transit → transit, it</span> · <span style="color:var(--text-2)">pending → po, pending_factory</span> · <span style="color:var(--text-2)">discontinued → disc, status (values: Y/N, 1/0, true/false, active/disc)</span>
        </div>
      </div>
      <input type="file" accept=".csv,.tsv,.txt,.xlsx,.xls" class="upload-input" id="stockUpload">
      <button class="upload-btn" id="stockTemplateBtn" title="Download a ready-to-fill Excel (.xlsx) template with the correct headers">↓ Excel Template</button>
      <button class="upload-btn" id="stockUploadBtnTrigger">Choose CSV / Excel</button>
      <button class="reset-btn" id="stockReset" style="display:none;">Clear & reset</button>
    </div>
    <div id="stockUploadDetail" style="font-family:var(--mono); font-size:10px; color:var(--text-3); margin-top:10px; min-height:14px;"></div>
    <div id="stockPreview" style="display:none; margin-top:14px;"></div>
  </div>
</section>

<!-- 09 Sales & Purchase history — direct CSV/Excel upload (also available via Google Sheets Sync). -->
<section class="section">
  <div class="section-head">
    <span class="section-num">09 /</span>
    <span class="section-title">Sales &amp; Purchase <em>history</em> (24 months)</span>
    <span class="section-rule"></span>
  </div>
  <div class="panel reveal reveal-1">
    <h3 class="panel-title">Upload your monthly sales &amp; purchase data — as separate files</h3>
    <p class="panel-sub">CSV or Excel (.xlsx / .xls) · matches by <strong style="color:var(--accent)">parent_code</strong> · one row per parent per month · upload <strong style="color:var(--accent)">Sales</strong> and <strong style="color:var(--accent)">Purchases</strong> independently — each merges into the same 24-month history without overwriting the other · recalculates annual sales, avg monthly, days of cover, ABC, all KPIs · saved locally across reloads · Use <strong style="color:var(--accent)">↓ Excel Template</strong> in each box for a pre-filled starter</p>

    <div class="upload-status" id="histUploadStatus" style="margin-bottom:6px;">No history override loaded — using embedded 24-month data</div>
    <div class="upload-spec" style="margin-bottom:14px;">
      <strong style="color:var(--accent)">Raw ERP exports accepted.</strong> Drop your raw <strong>Sales</strong> or <strong>Purchase</strong> file straight into the matching box — files with columns <span style="color:var(--text-2)">Date, Product, Product Code, Qty, Company Name, PID</span> are auto-detected, mapped to their parent (via <strong>PID</strong>), aggregated by month, and previewed below. No pre-formatting needed. <em>Requires the Product Master to be cleaned first</em> (that builds the PID → parent map).<br><br>
      Already-clean files also work. Sales columns: <strong style="color:var(--accent)">parent_code, month, sales</strong> · Purchases columns: <strong style="color:var(--accent)">parent_code, month, purchases</strong><br>
      Month formats accepted: <span style="color:var(--text-2)">"2025-04" · "Apr-25" · "Apr 2025" · "April 2025" · "4/2025" · "04/25"</span> · Active 24-month window: <strong style="color:var(--accent)" id="histWindowLabel">—</strong><br>
      <span style="color:var(--text-3)">Very large Excel exports (roughly &gt; 50&nbsp;MB) can exceed the browser's limit — if one won't load, save it as <strong>CSV</strong> and upload that (same columns).</span>
    </div>

    <div class="hist-split" style="display:grid; grid-template-columns:1fr 1fr; gap:14px;">
      <div class="upload-zone" id="salesUploadZone" style="border-left:3px solid rgba(58,255,182,0.6);">
        <div class="upload-meta">
          <div class="upload-status" id="salesUploadStatus"><strong>Sales</strong> — no file loaded</div>
        </div>
        <input type="file" accept=".csv,.tsv,.txt,.xlsx,.xls" class="upload-input" id="salesUpload">
        <button class="upload-btn" id="salesTemplateBtn" title="Download a ready-to-fill Excel (.xlsx) SALES template with all 24 months">↓ Excel Template</button>
        <button class="upload-btn" id="salesUploadBtnTrigger">Choose Sales file</button>
      </div>

      <div class="upload-zone" id="purchUploadZone" style="border-left:3px solid rgba(255,92,58,0.6);">
        <div class="upload-meta">
          <div class="upload-status" id="purchUploadStatus"><strong>Purchases</strong> — no file loaded</div>
        </div>
        <input type="file" accept=".csv,.tsv,.txt,.xlsx,.xls" class="upload-input" id="purchUpload">
        <button class="upload-btn" id="purchTemplateBtn" title="Download a ready-to-fill Excel (.xlsx) PURCHASES template with all 24 months">↓ Excel Template</button>
        <button class="upload-btn" id="purchUploadBtnTrigger">Choose Purchases file</button>
      </div>
    </div>

    <div style="margin-top:12px;"><button class="reset-btn" id="histReset" style="display:none;">Clear &amp; reset history</button></div>
    <div id="histUploadDetail" style="font-family:var(--mono); font-size:10px; color:var(--text-3); margin-top:10px; min-height:14px;"></div>
    <div id="salesPreview" style="display:none; margin-top:14px;"></div>
    <div id="purchasePreview" style="display:none; margin-top:14px;"></div>
  </div>
</section>

<!-- 10.5 Google Sheets Sync — pull from cloud-hosted master template -->
<section class="section">
  <div class="section-head">
    <span class="section-num">SYNC /</span>
    <span class="section-title">Google Sheets <em>sync</em></span>
    <span class="section-rule"></span>
  </div>
  <div class="panel reveal reveal-1">
    <h3 class="panel-title">Live link to your Google Sheets master template</h3>
    <p class="panel-sub">Edit data in your Google Sheets, then click <strong style="color:var(--accent)">Sync All</strong> here to pull the latest values into the dashboard. The 4 sheets below were created in your Drive — open them, fill in your real data, and use this section to keep the dashboard in sync.</p>

    <div style="background: rgba(255,168,58,0.05); border: 1px solid rgba(255,168,58,0.2); padding: 12px 14px; margin-bottom: 14px; border-radius: 3px;">
      <strong style="color: var(--orange); font-family: var(--mono); font-size: 11px; letter-spacing: 0.1em;">SETUP — TWO OPTIONS:</strong>
      <p style="margin: 8px 0 4px; font-size: 12px; color: var(--text-2); line-height: 1.6;"><strong>Option A — Published CSV (recommended, anonymous):</strong></p>
      <ol style="margin: 0 0 8px 24px; font-size: 12px; color: var(--text-2); line-height: 1.6;">
        <li>Open the Google Sheet → <strong>File → Share → Publish to web</strong></li>
        <li>Pick the sheet, format <strong>CSV</strong>, click <strong>Publish</strong>, copy the URL</li>
        <li>Paste into the Published URL field below</li>
      </ol>
      <p style="margin: 8px 0 4px; font-size: 12px; color: var(--text-2); line-height: 1.6;"><strong>Option B — Direct Excel export (.xlsx, anyone-with-link access):</strong></p>
      <ol style="margin: 0 0 8px 24px; font-size: 12px; color: var(--text-2); line-height: 1.6;">
        <li>Open the Google Sheet → <strong>File → Share → Share with others</strong> → set to <strong>Anyone with the link · Viewer</strong></li>
        <li>Use the URL: <code style="color: var(--accent); font-size: 11px;">https://docs.google.com/spreadsheets/d/&lt;ID&gt;/export?format=xlsx</code></li>
        <li>Or paste the sheet's normal /edit URL — the dashboard auto-uses Excel if you append <code>?format=xlsx</code></li>
      </ol>
      <p style="margin-top: 8px; font-size: 11px; color: var(--text-3); font-family: var(--mono);">The dashboard auto-detects CSV vs Excel from the response and parses accordingly. After setup, just edit your sheets and re-click <strong>Sync All</strong> anytime.</p>
    </div>

    <div id="gsyncList" style="display: flex; flex-direction: column; gap: 10px; margin-bottom: 16px;"></div>

    <div style="display: flex; gap: 8px; flex-wrap: wrap; align-items: center;">
      <button class="dl-btn primary" id="gsyncAllBtn"><span class="icn">↻</span> Sync All from Google Sheets</button>
      <button class="dl-btn" id="gsyncSaveUrls"><span class="icn">💾</span> Save URLs</button>
      <button class="reset-btn" id="gsyncResetUrls">Clear all URLs</button>
      <label style="display: inline-flex; align-items: center; gap: 6px; font-family: var(--mono); font-size: 11px; color: var(--text-2); cursor: pointer; margin-left: 8px; padding: 6px 10px; border: 1px solid var(--line); border-radius: 3px;">
        <input type="checkbox" id="gsyncAutoToggle" style="margin: 0;">
        Auto-sync on every page load
      </label>
    </div>
    <div id="gsyncStatus" style="font-family: var(--mono); font-size: 11px; color: var(--text-3); margin-top: 12px; min-height: 16px;"></div>
    <div style="margin-top: 12px; padding: 10px 12px; background: rgba(255,168,58,0.05); border: 1px solid rgba(255,168,58,0.18); border-radius: 3px; font-size: 11px; color: var(--text-2); line-height: 1.6;">
      <strong style="color: var(--orange);">If you see "Failed to fetch":</strong> the sheet is private. Open each sheet → <strong>Share</strong> → change access to <strong>Anyone with the link · Viewer</strong>. Then click Sync All again. (Alternatively, File → Publish to web → CSV and paste that URL instead.)
    </div>
  </div>
</section>

<!-- 10 Zone browser — folders/catalogs grouped into zones 1–6, Open, Unclassified -->
<section class="section">
  <div class="section-head">
    <span class="section-num">10 /</span>
    <span class="section-title">Zone <em>browser</em></span>
    <span class="section-rule"></span>
  </div>
  <div class="panel reveal reveal-1">
    <h3 class="panel-title">Folders grouped by zone</h3>
    <p class="panel-sub">Click a zone to see the folders in it. Each card shows the folder's other zone memberships, child SKU count and parent count. Assign zones via the <strong style="color:var(--accent)">zone</strong> column in the Master CSV (Section 07). A folder can be in multiple zones; <strong style="color:var(--accent)">open</strong> means in all six; blank means not yet classified.</p>

    <div class="zone-tabs" id="zoneTabs"></div>
    <div id="zoneStatusLine" class="zone-status-line"></div>
    <div id="zoneContent"></div>
  </div>
</section>

<footer class="footer">
  <span>3,692 parents · 14,680 child codes · 145 folders · 30 vendors · 24-month window</span>
  <span>v4.0 — CSV exports honour edits · Master upload persists locally</span>
</footer>

`;
