/* ============================================================
   Kwara State ISS — Field Monitoring Dashboard
   All scoring logic mirrors the XLSForm `calculate` fields exactly:
   domain score = 100 * (sum of numeric responses) / (sum of max points,
   where blank/N-A responses contribute 0 to both numerator and
   denominator); overall score = weighted sum of domain scores;
   classification = CRITICAL if any critical item scored 0, else
   GREEN >=85, AMBER >=70, else RED.
   ============================================================ */

(function () {
  "use strict";

  const CLASS_COLOR = {
    GREEN: "var(--green)",
    AMBER: "var(--amber)",
    RED: "var(--red)",
    CRITICAL: "var(--critical)",
  };
  const CLASS_ORDER = ["CRITICAL", "RED", "AMBER", "GREEN"];

  const state = {
    schema: null,
    lookups: null,
    records: [],
    meta: null,
    filters: { lga: "", ward: "", facility: "", visitType: "", period: "all" },
    openDomain: null,
    openKpi: null,
    sort: { key: "score", dir: "asc" },
    registerSearch: "",
  };

  // ---------------------------------------------------------
  // Data loading
  // ---------------------------------------------------------
  async function loadJSON(path, fallback) {
    try {
      const res = await fetch(path, { cache: "no-store" });
      if (!res.ok) throw new Error(res.status);
      return await res.json();
    } catch (e) {
      console.warn("Could not load", path, e);
      return fallback;
    }
  }

  async function init() {
    const [schema, liveSubs, liveMeta] = await Promise.all([
      loadJSON("assets/schema.json", null),
      loadJSON("data/live_submissions.json", []),
      loadJSON("data/live_meta.json", null),
    ]);
    state.schema = schema;
    state.records = liveSubs || [];
    state.meta = liveMeta;
    state.lookups = buildLookups(schema);

    populateStaticSelects();
    wireEvents();
    render();
  }

  function buildLookups(schema) {
    const lga = {}, ward = {}, facility = {};
    schema.lga.forEach((l) => (lga[l.code] = l.label));
    schema.ward.forEach((w) => (ward[w.code] = { label: w.label, lga: w.lga }));
    schema.facility.forEach((f) => (facility[f.code] = { label: f.label, ward: f.ward }));
    return { lga, ward, facility };
  }

  // ---------------------------------------------------------
  // Scoring (mirrors XLSForm calculate fields)
  // ---------------------------------------------------------
  function computeVisit(rec, schema) {
    const domainScores = {};
    const criticalFlags = [];
    schema.domains.forEach((d) => {
      let num = 0, max = 0;
      d.items.forEach((item) => {
        const v = rec[item.name];
        if (v === undefined || v === null || v === "" || v === "na") return;
        num += Number(v);
        max += 2;
        if (item.critical && v === "0") {
          criticalFlags.push({ domain: d.key, domainLabel: d.label, item: item.name, label: item.label });
        }
      });
      domainScores[d.key] = max === 0 ? 0 : Math.round((1000 * num) / max) / 10;
    });
    let overall = 0;
    schema.domains.forEach((d) => {
      overall += (domainScores[d.key] * d.weight) / 100;
    });
    overall = Math.round(overall * 10) / 10;
    let classification;
    if (criticalFlags.length > 0) classification = "CRITICAL";
    else if (overall >= 85) classification = "GREEN";
    else if (overall >= 70) classification = "AMBER";
    else classification = "RED";
    return { domainScores, overall, classification, criticalFlags };
  }

  function visitDate(rec) {
    return rec.today || (rec._submission_time || "").slice(0, 10) || null;
  }

  // ---------------------------------------------------------
  // Filtering
  // ---------------------------------------------------------
  function currentRecords() {
    return state.records || [];
  }

  function facilitiesInScope() {
    const { schema, filters } = state;
    if (filters.facility) return schema.facility.filter((f) => f.code === filters.facility);
    if (filters.ward) return schema.facility.filter((f) => f.ward === filters.ward);
    if (filters.lga) {
      const wardsInLga = new Set(schema.ward.filter((w) => w.lga === filters.lga).map((w) => w.code));
      return schema.facility.filter((f) => wardsInLga.has(f.ward));
    }
    return schema.facility;
  }

  function filteredRecords() {
    const { filters } = state;
    let recs = currentRecords();
    if (filters.facility) recs = recs.filter((r) => r.facility === filters.facility);
    else if (filters.ward) recs = recs.filter((r) => r.ward === filters.ward);
    else if (filters.lga) recs = recs.filter((r) => r.lga === filters.lga);
    if (filters.visitType) recs = recs.filter((r) => r.visit_type === filters.visitType);
    if (filters.period !== "all") {
      const days = Number(filters.period);
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - days);
      recs = recs.filter((r) => {
        const d = visitDate(r);
        return d && new Date(d) >= cutoff;
      });
    }
    return recs;
  }

  function withComputed(recs) {
    return recs.map((r) => ({ rec: r, m: computeVisit(r, state.schema) }));
  }

  // ---------------------------------------------------------
  // Static selects
  // ---------------------------------------------------------
  function populateStaticSelects() {
    const { schema } = state;
    const selLga = document.getElementById("selLga");
    schema.lga
      .slice()
      .sort((a, b) => a.label.localeCompare(b.label))
      .forEach((l) => {
        const o = document.createElement("option");
        o.value = l.code;
        o.textContent = l.label;
        selLga.appendChild(o);
      });

    const selVisitType = document.getElementById("selVisitType");
    schema.visit_type.forEach((v) => {
      const o = document.createElement("option");
      o.value = v.code;
      o.textContent = v.label;
      selVisitType.appendChild(o);
    });
  }

  function refreshWardOptions() {
    const { schema, filters } = state;
    const selWard = document.getElementById("selWard");
    selWard.innerHTML = '<option value="">All wards</option>';
    if (!filters.lga) {
      selWard.disabled = true;
      return;
    }
    selWard.disabled = false;
    schema.ward
      .filter((w) => w.lga === filters.lga)
      .sort((a, b) => a.label.localeCompare(b.label))
      .forEach((w) => {
        const o = document.createElement("option");
        o.value = w.code;
        o.textContent = w.label;
        selWard.appendChild(o);
      });
  }

  function refreshFacilityOptions() {
    const { schema, filters } = state;
    const selFacility = document.getElementById("selFacility");
    selFacility.innerHTML = '<option value="">All facilities</option>';
    if (!filters.ward) {
      selFacility.disabled = true;
      return;
    }
    selFacility.disabled = false;
    schema.facility
      .filter((f) => f.ward === filters.ward)
      .sort((a, b) => a.label.localeCompare(b.label))
      .forEach((f) => {
        const o = document.createElement("option");
        o.value = f.code;
        o.textContent = f.label;
        selFacility.appendChild(o);
      });
  }

  // ---------------------------------------------------------
  // Events
  // ---------------------------------------------------------
  function wireEvents() {
    document.getElementById("selLga").addEventListener("change", (e) => {
      state.filters.lga = e.target.value;
      state.filters.ward = "";
      state.filters.facility = "";
      refreshWardOptions();
      refreshFacilityOptions();
      render();
    });
    document.getElementById("selWard").addEventListener("change", (e) => {
      state.filters.ward = e.target.value;
      state.filters.facility = "";
      refreshFacilityOptions();
      render();
    });
    document.getElementById("selFacility").addEventListener("change", (e) => {
      state.filters.facility = e.target.value;
      render();
    });
    document.getElementById("btnResetGeo").addEventListener("click", () => {
      state.filters.lga = state.filters.ward = state.filters.facility = "";
      document.getElementById("selLga").value = "";
      refreshWardOptions();
      refreshFacilityOptions();
      render();
    });
    document.getElementById("selVisitType").addEventListener("change", (e) => {
      state.filters.visitType = e.target.value;
      render();
    });
    document.getElementById("selPeriod").addEventListener("change", (e) => {
      state.filters.period = e.target.value;
      render();
    });
    document.getElementById("registerSearch").addEventListener("input", (e) => {
      state.registerSearch = e.target.value || "";
      renderRegister(getBundle());
    });

    document.getElementById("btnExportExcel").addEventListener("click", () => exportExcel(getBundle()));
    document.getElementById("btnExportWord").addEventListener("click", () => exportWord(getBundle()));

    document.getElementById("drawerClose").addEventListener("click", closeDrawer);
    document.getElementById("drawerOverlay").addEventListener("click", closeDrawer);

    document.getElementById("registerTable").querySelectorAll("th[data-sort]").forEach((th) => {
      th.addEventListener("click", () => {
        const key = th.getAttribute("data-sort");
        if (state.sort.key === key) state.sort.dir = state.sort.dir === "asc" ? "desc" : "asc";
        else {
          state.sort.key = key;
          state.sort.dir = "asc";
        }
        renderRegister(getBundle());
      });
    });
  }

  // ---------------------------------------------------------
  // Rendering — orchestration
  // ---------------------------------------------------------
  function getBundle() {
    const filtered = filteredRecords();
    const computed = withComputed(filtered);
    return { filtered, computed };
  }

  function render() {
    const bundle = getBundle();
    renderScopeLine(bundle);
    renderUpdatedNote();
    renderStatStrip(bundle);
    renderDomainGrid(bundle);
    renderKpiGrid(bundle);
    renderFlags(bundle);
    renderActionTracker(bundle);
    renderRegister(bundle);
    renderMiniRank(bundle);
  }

  function scopeLabel() {
    const { filters, lookups } = state;
    if (filters.facility) return lookups.facility[filters.facility].label;
    if (filters.ward) return lookups.ward[filters.ward].label + " ward";
    if (filters.lga) return lookups.lga[filters.lga];
    return "all 16 LGAs";
  }

  function renderScopeLine(bundle) {
    document.getElementById("scopeLine").innerHTML =
      "Showing <b>" + scopeLabel() + "</b> &middot; <b id=\"scopeCount\">" + bundle.filtered.length + "</b> supervision visit" + (bundle.filtered.length === 1 ? "" : "s");
  }

  function renderUpdatedNote() {
    const meta = state.meta;
    const el = document.getElementById("updatedNote");
    if (!meta || !meta.fetched_at) {
      el.textContent = "Awaiting first data refresh";
      return;
    }
    const dt = new Date(meta.fetched_at);
    el.textContent = "Updated " + dt.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  }

  // ---------------------------------------------------------
  // Summary strip
  // ---------------------------------------------------------
  function renderStatStrip(bundle) {
    const strip = document.getElementById("statStrip");
    const { computed } = bundle;
    const facScope = facilitiesInScope();
    const visitedFacilities = new Set(computed.map((c) => c.rec.facility));
    const coverage = facScope.length ? Math.round((visitedFacilities.size / facScope.length) * 100) : 0;
    const avgScore = computed.length ? Math.round((computed.reduce((s, c) => s + c.m.overall, 0) / computed.length) * 10) / 10 : null;
    const classCounts = { GREEN: 0, AMBER: 0, RED: 0, CRITICAL: 0 };
    computed.forEach((c) => classCounts[c.m.classification]++);
    const criticalVisits = classCounts.CRITICAL;
    const actions = collectActions(computed);
    const openActions = actions.filter((a) => a.action_status !== "closed").length;
    const overdueActions = actions.filter((a) => isOverdue(a)).length;

    const cells = [
      { num: computed.length, lbl: "Supervision visits", sub: scopeLabel() },
      { num: visitedFacilities.size + " / " + facScope.length, lbl: "Facilities covered", sub: coverage + "% of scope" },
      { num: avgScore === null ? "—" : avgScore + "%", lbl: "Average overall score", sub: "weighted across 6 domains" },
      { num: classCounts.GREEN, lbl: "GREEN visits", sub: pct(classCounts.GREEN, computed.length) + " of visits", color: CLASS_COLOR.GREEN },
      { num: criticalVisits, lbl: "CRITICAL visits", sub: "red-flag override triggered", color: CLASS_COLOR.CRITICAL },
      { num: openActions, lbl: "Open corrective actions", sub: overdueActions + " overdue", color: overdueActions ? CLASS_COLOR.RED : null },
    ];
    strip.innerHTML = cells
      .map(
        (c) =>
          '<div class="stat-cell"><span class="num tabular"' +
          (c.color ? ' style="color:' + c.color + '"' : "") +
          ">" +
          c.num +
          '</span><div class="lbl">' +
          c.lbl +
          '</div><div class="sub">' +
          c.sub +
          "</div></div>"
      )
      .join("");
  }

  function pct(n, total) {
    if (!total) return "0%";
    return Math.round((n / total) * 100) + "%";
  }

  // ---------------------------------------------------------
  // Domain cards + analysis panel
  // ---------------------------------------------------------
  function renderDomainGrid(bundle) {
    const grid = document.getElementById("domainGrid");
    const { schema } = state;
    const { computed } = bundle;

    if (!computed.length) {
      grid.innerHTML = domainEmptyCards();
      document.getElementById("domainPanel").classList.remove("is-visible");
      return;
    }

    grid.innerHTML = schema.domains
      .map((d) => {
        const scores = computed.map((c) => c.m.domainScores[d.key]);
        const avg = Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10;
        const flagCount = computed.reduce((s, c) => s + c.m.criticalFlags.filter((f) => f.domain === d.key).length, 0);
        const barColor = avg >= 85 ? "var(--green)" : avg >= 70 ? "var(--amber)" : "var(--red)";
        return (
          '<button class="card' +
          (state.openDomain === d.key ? " is-open" : "") +
          (flagCount ? " has-flag" : "") +
          '" data-domain="' +
          d.key +
          '">' +
          '<div class="card-top"><span class="card-title">' +
          d.label +
          '</span><span class="card-weight">' +
          d.weight +
          '% weight</span></div>' +
          '<div class="card-score-row"><span class="card-score tabular" style="color:' +
          barColor +
          '">' +
          avg +
          "%</span>" +
          (flagCount ? '<span class="card-flagcount">' + flagCount + " red flag" + (flagCount > 1 ? "s" : "") + "</span>" : "") +
          "</div>" +
          '<div class="bar-track"><div class="bar-fill" style="width:' +
          Math.min(100, avg) +
          "%;background:" +
          barColor +
          '"></div></div>' +
          '<div class="card-foot"><span>' +
          d.items.length +
          " checklist items</span><span>" +
          scores.length +
          " visits</span></div>" +
          "</button>"
        );
      })
      .join("");

    grid.querySelectorAll(".card[data-domain]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.getAttribute("data-domain");
        state.openDomain = state.openDomain === key ? null : key;
        renderDomainGrid(getBundle());
      });
    });

    if (state.openDomain) renderDomainPanel(bundle, state.openDomain);
    else document.getElementById("domainPanel").classList.remove("is-visible");
  }

  function domainEmptyCards() {
    return state.schema.domains
      .map(
        (d) =>
          '<div class="card"><div class="card-top"><span class="card-title">' +
          d.label +
          '</span><span class="card-weight">' +
          d.weight +
          '% weight</span></div><div class="card-score tabular" style="color:var(--text-faint)">—</div>' +
          '<div class="bar-track"><div class="bar-fill" style="width:0%"></div></div>' +
          '<div class="card-foot"><span>' +
          d.items.length +
          ' checklist items</span><span>no visits yet</span></div></div>'
      )
      .join("");
  }

  function renderDomainPanel(bundle, domainKey) {
    const { schema, lookups } = state;
    const domain = schema.domains.find((d) => d.key === domainKey);
    const { computed } = bundle;
    const panel = document.getElementById("domainPanel");
    panel.classList.add("is-visible");

    // Item-level averages
    const itemStats = domain.items.map((item) => {
      let num = 0, count = 0, flagCount = 0;
      computed.forEach((c) => {
        const v = c.rec[item.name];
        if (v === undefined || v === null || v === "" || v === "na") return;
        num += Number(v);
        count += 1;
        if (item.critical && v === "0") flagCount++;
      });
      const pctVal = count ? Math.round((100 * num) / (2 * count)) : null;
      return { item, pctVal, count, flagCount };
    });
    const scored = itemStats.filter((s) => s.pctVal !== null).sort((a, b) => a.pctVal - b.pctVal);
    const weakest = scored.slice(0, 6);

    // Weakest LGA for this domain
    const byLga = {};
    computed.forEach((c) => {
      const lga = c.rec.lga;
      byLga[lga] = byLga[lga] || [];
      byLga[lga].push(c.m.domainScores[domainKey]);
    });
    const lgaRows = Object.keys(byLga)
      .map((code) => ({
        code,
        label: lookups.lga[code] || code,
        avg: Math.round((byLga[code].reduce((a, b) => a + b, 0) / byLga[code].length) * 10) / 10,
        n: byLga[code].length,
      }))
      .sort((a, b) => a.avg - b.avg);

    const totalFlags = computed.reduce((s, c) => s + c.m.criticalFlags.filter((f) => f.domain === domainKey).length, 0);
    const insight = totalFlags
      ? weakest[0]
        ? "The most common gap is \u201C" + weakest[0].item.label + "\u201D, unmet in " + (100 - weakest[0].pctVal) + "% of applicable checks, with " + totalFlags + " critical red flag" + (totalFlags > 1 ? "s" : "") + " triggered in this domain."
        : totalFlags + " critical red flag" + (totalFlags > 1 ? "s" : "") + " triggered in this domain."
      : weakest[0]
      ? "Strongest domain overall — the softest spot is \u201C" + weakest[0].item.label + "\u201D at " + weakest[0].pctVal + "% compliance."
      : "No scored responses yet in the current scope.";

    panel.innerHTML =
      '<div class="analysis-head"><div><h4>' +
      domain.label +
      ' — item-level breakdown</h4><p>' +
      domain.items.length +
      " items, weighted " +
      domain.weight +
      '% of the overall score. Ranked from weakest to strongest across the current filter.</p></div>' +
      '<button class="analysis-close" id="closeDomainPanel">&times;</button></div>' +
      '<div class="' +
      (totalFlags ? "insight-line warn" : "insight-line") +
      '">' +
      insight +
      "</div>" +
      '<div class="analysis-body">' +
      '<div><p class="subhead">Weakest checklist items</p><div class="hbar-list">' +
      weakest
        .map(
          (s) =>
            '<div class="hbar-row"><div class="hbar-label">' +
            s.item.label +
            (s.item.critical ? '<span class="tag">CRITICAL</span>' : "") +
            '</div><div class="hbar-track"><div class="hbar-fill" style="width:' +
            s.pctVal +
            "%;background:" +
            (s.pctVal >= 70 ? "var(--green)" : s.pctVal >= 40 ? "var(--amber)" : "var(--red)") +
            '"></div></div><div class="hbar-val tabular">' +
            s.pctVal +
            "%</div></div>"
        )
        .join("") +
      "</div></div>" +
      '<div><p class="subhead">By LGA (weakest first)</p><table class="table-mini"><thead><tr><th>LGA</th><th>Visits</th><th>Score</th></tr></thead><tbody>' +
      lgaRows
        .slice(0, 8)
        .map(
          (r) =>
            "<tr><td>" + r.label + '</td><td class="tabular">' + r.n + '</td><td class="tabular" style="font-weight:600;color:' +
            (r.avg >= 85 ? "var(--green)" : r.avg >= 70 ? "var(--amber)" : "var(--red)") +
            '">' + r.avg + "%</td></tr>"
        )
        .join("") +
      "</tbody></table></div>" +
      "</div>";

    document.getElementById("closeDomainPanel").addEventListener("click", () => {
      state.openDomain = null;
      renderDomainGrid(getBundle());
    });
  }

  // ---------------------------------------------------------
  // KPI (tracer indicator) cards + analysis panel
  // ---------------------------------------------------------
  function trendGood(direction, current, previous) {
    if (current === null || previous === null || current === undefined || previous === undefined) return null;
    const delta = current - previous;
    if (Math.abs(delta) < 0.05) return "flat";
    if (direction === "higher") return delta > 0 ? "up" : "down";
    if (direction === "lower") return delta < 0 ? "up" : "down"; // "up" = good direction
    return delta > 0 ? "up" : "down";
  }

  function renderKpiGrid(bundle) {
    const grid = document.getElementById("kpiGrid");
    const { schema } = state;
    const { computed } = bundle;

    if (!computed.length) {
      grid.innerHTML = kpiEmptyCards();
      document.getElementById("kpiPanel").classList.remove("is-visible");
      return;
    }

    grid.innerHTML = schema.tracers
      .map((t) => {
        const domain = schema.domains.find((d) => d.key === t.domain);
        const curVals = computed.map((c) => c.rec[t.field + "_current"]).filter((v) => v !== undefined && v !== null && v !== "");
        const prevVals = computed.map((c) => c.rec[t.field + "_previous"]).filter((v) => v !== undefined && v !== null && v !== "");
        const avgCur = curVals.length ? round1(curVals.reduce((a, b) => a + Number(b), 0) / curVals.length) : null;
        const avgPrev = prevVals.length ? round1(prevVals.reduce((a, b) => a + Number(b), 0) / prevVals.length) : null;
        const trend = trendGood(t.direction, avgCur, avgPrev);
        const unit = t.unit === "%" ? "%" : "";
        return (
          '<button class="kpi-card' +
          (state.openKpi === t.field ? " is-open" : "") +
          '" data-kpi="' +
          t.field +
          '">' +
          '<span class="kpi-domain-tag">' +
          domain.label +
          "</span>" +
          '<span class="kpi-label">' +
          t.label +
          "</span>" +
          '<div class="kpi-value-row"><span class="kpi-value tabular">' +
          (avgCur === null ? "—" : avgCur + unit) +
          "</span>" +
          (trend
            ? '<span class="kpi-delta ' +
              trend +
              '">' +
              (trend === "up" ? "▲" : trend === "down" ? "▼" : "▬") +
              " vs " +
              avgPrev +
              unit +
              "</span>"
            : "") +
          "</div>" +
          miniCompareBars(avgPrev, avgCur, t.unit) +
          "</button>"
        );
      })
      .join("");

    grid.querySelectorAll(".kpi-card[data-kpi]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.getAttribute("data-kpi");
        state.openKpi = state.openKpi === key ? null : key;
        renderKpiGrid(getBundle());
      });
    });

    if (state.openKpi) renderKpiPanel(bundle, state.openKpi);
    else document.getElementById("kpiPanel").classList.remove("is-visible");
  }

  function kpiEmptyCards() {
    return state.schema.tracers
      .map(
        (t) =>
          '<div class="kpi-card"><span class="kpi-domain-tag">' +
          state.schema.domains.find((d) => d.key === t.domain).label +
          '</span><span class="kpi-label">' +
          t.label +
          '</span><div class="kpi-value tabular" style="color:var(--text-faint)">—</div></div>'
      )
      .join("");
  }

  function round1(n) {
    return Math.round(n * 10) / 10;
  }

  function miniCompareBars(prev, cur, unit) {
    if (prev === null || cur === null) return "";
    const maxScale = unit === "%" ? 100 : Math.max(prev, cur, 1) * 1.15;
    const pctPrev = Math.min(100, (prev / maxScale) * 100);
    const pctCur = Math.min(100, (cur / maxScale) * 100);
    return (
      '<div style="display:flex;gap:4px;align-items:flex-end;height:20px;">' +
      '<div title="Previous" style="width:10px;height:' +
      Math.max(3, pctPrev) +
      '%;background:var(--rule-strong);border-radius:1px;"></div>' +
      '<div title="Current" style="width:10px;height:' +
      Math.max(3, pctCur) +
      '%;background:var(--moss);border-radius:1px;"></div>' +
      '<span style="font-size:10px;color:var(--text-faint);margin-left:4px;">prev &rarr; current</span>' +
      "</div>"
    );
  }

  function renderKpiPanel(bundle, field) {
    const { schema, lookups } = state;
    const t = schema.tracers.find((tr) => tr.field === field);
    const { computed } = bundle;
    const panel = document.getElementById("kpiPanel");
    panel.classList.add("is-visible");

    const rows = computed
      .map((c) => ({
        date: visitDate(c.rec),
        cur: c.rec[field + "_current"],
        prev: c.rec[field + "_previous"],
        lga: c.rec.lga,
        facility: c.rec.facility,
      }))
      .filter((r) => r.cur !== undefined && r.cur !== null && r.cur !== "")
      .sort((a, b) => (a.date > b.date ? 1 : -1));

    // by-LGA averages
    const byLga = {};
    rows.forEach((r) => {
      byLga[r.lga] = byLga[r.lga] || [];
      byLga[r.lga].push(Number(r.cur));
    });
    const lgaRows = Object.keys(byLga)
      .map((code) => ({
        label: lookups.lga[code] || code,
        avg: round1(byLga[code].reduce((a, b) => a + b, 0) / byLga[code].length),
        n: byLga[code].length,
      }))
      .sort((a, b) => (t.direction === "lower" ? b.avg - a.avg : a.avg - b.avg));

    const worstFacilities = rows
      .slice()
      .sort((a, b) => (t.direction === "lower" ? Number(a.cur) - Number(b.cur) : Number(b.cur) - Number(a.cur)))
      .reverse()
      .slice(0, 6);

    const unit = t.unit === "%" ? "%" : "";
    const svg = lineSvg(rows, t);

    panel.innerHTML =
      '<div class="analysis-head"><div><h4>' +
      t.label +
      '</h4><p>' +
      rows.length +
      " visit" +
      (rows.length === 1 ? "" : "s") +
      " with a recorded value in the current scope. Direction of improvement: " +
      (t.direction === "lower" ? "lower is better" : t.direction === "higher" ? "higher is better" : "monitor") +
      ".</p></div>" +
      '<button class="analysis-close" id="closeKpiPanel">&times;</button></div>' +
      '<div class="analysis-body">' +
      '<div><p class="subhead">Trend across visits</p>' +
      svg +
      "</div>" +
      '<div><p class="subhead">By LGA</p><table class="table-mini"><thead><tr><th>LGA</th><th>Visits</th><th>Avg.</th></tr></thead><tbody>' +
      lgaRows
        .slice(0, 8)
        .map((r) => "<tr><td>" + r.label + '</td><td class="tabular">' + r.n + '</td><td class="tabular" style="font-weight:600;">' + r.avg + unit + "</td></tr>")
        .join("") +
      "</tbody></table>" +
      '<p class="subhead" style="margin-top:16px;">Facilities furthest from target</p><table class="table-mini"><thead><tr><th>Facility</th><th>Value</th></tr></thead><tbody>' +
      worstFacilities
        .map(
          (r) =>
            "<tr><td>" + (lookups.facility[r.facility] ? lookups.facility[r.facility].label : r.facility) + '</td><td class="tabular" style="font-weight:600;">' + r.cur + unit + "</td></tr>"
        )
        .join("") +
      "</tbody></table></div>" +
      "</div>";

    document.getElementById("closeKpiPanel").addEventListener("click", () => {
      state.openKpi = null;
      renderKpiGrid(getBundle());
    });
  }

  function lineSvg(rows, tracer) {
    if (!rows.length) return '<p style="font-size:12.5px;color:var(--text-muted);">No data points in scope.</p>';
    const w = 460, h = 170, padL = 34, padR = 14, padT = 14, padB = 26;
    const vals = rows.map((r) => Number(r.cur));
    const maxV = tracer.unit === "%" ? 100 : Math.max(...vals) * 1.2 || 1;
    const minV = 0;
    const xStep = rows.length > 1 ? (w - padL - padR) / (rows.length - 1) : 0;
    const xy = rows.map((r, i) => {
      const x = padL + i * xStep;
      const y = padT + (1 - (Number(r.cur) - minV) / (maxV - minV || 1)) * (h - padT - padB);
      return [x, y];
    });
    const path = xy.map((p, i) => (i === 0 ? "M" : "L") + p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" ");
    const areaPath = path + " L" + xy[xy.length - 1][0].toFixed(1) + "," + (h - padB) + " L" + xy[0][0].toFixed(1) + "," + (h - padB) + " Z";
    const gridY = [0, 0.5, 1].map((f) => padT + f * (h - padT - padB));
    const dots = xy
      .map((p, i) => '<circle cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="2.6" fill="#3C6B52" />')
      .join("");
    const lastLabel = rows[rows.length - 1];
    return (
      '<svg viewBox="0 0 ' + w + " " + h + '" width="100%" height="' + h + '" role="img" aria-label="Trend chart">' +
      gridY.map((y) => '<line x1="' + padL + '" x2="' + (w - padR) + '" y1="' + y + '" y2="' + y + '" stroke="#DBD5C0" stroke-width="1"/>').join("") +
      '<text x="4" y="' + (padT + 4) + '" font-size="9" fill="#8A9186" font-family="IBM Plex Sans">' + Math.round(maxV) + "</text>" +
      '<text x="4" y="' + (h - padB + 4) + '" font-size="9" fill="#8A9186" font-family="IBM Plex Sans">0</text>' +
      '<path d="' + areaPath + '" fill="#3C6B52" fill-opacity="0.08" stroke="none"/>' +
      '<path d="' + path + '" fill="none" stroke="#3C6B52" stroke-width="1.8"/>' +
      dots +
      '<text x="' + xy[xy.length - 1][0].toFixed(1) + '" y="' + (xy[xy.length - 1][1] - 8).toFixed(1) + '" font-size="10" font-weight="600" fill="#294B39" font-family="IBM Plex Sans" text-anchor="end">' +
      lastLabel.cur + (tracer.unit === "%" ? "%" : "") +
      "</text>" +
      "</svg>"
    );
  }

  // ---------------------------------------------------------
  // Data quality flags
  // ---------------------------------------------------------
  function renderFlags(bundle) {
    const { computed } = bundle;
    const { lookups } = state;
    const list = document.getElementById("flagList");
    if (!computed.length) {
      list.innerHTML = '<div class="empty-state"><p>No visits in scope, so no flags to show.</p></div>';
      return;
    }
    const flags = [];
    computed.forEach((c) => {
      const facLabel = (lookups.facility[c.rec.facility] || {}).label || c.rec.facility;
      const lgaLabel = lookups.lga[c.rec.lga] || c.rec.lga;
      const date = visitDate(c.rec);
      if (c.m.criticalFlags.length) {
        flags.push({
          severity: "critical",
          text: c.m.criticalFlags.length + " critical red flag" + (c.m.criticalFlags.length > 1 ? "s" : "") + " — " + c.m.criticalFlags[0].label + (c.m.criticalFlags.length > 1 ? " and others" : ""),
          meta: facLabel + " · " + lgaLabel + " · " + fmtDate(date),
          date,
        });
      }
      ["report_completeness", "report_timeliness"].forEach((f) => {
        const v = c.rec[f + "_current"];
        if (v !== undefined && v !== null && v !== "" && Number(v) < 80) {
          flags.push({
            severity: "warn",
            text: (f === "report_completeness" ? "Low report completeness" : "Low report timeliness") + " (" + v + "%)",
            meta: facLabel + " · " + lgaLabel + " · " + fmtDate(date),
            date,
          });
        }
      });
      state.schema.tracers.forEach((t) => {
        const cur = c.rec[t.field + "_current"], prev = c.rec[t.field + "_previous"];
        if (cur !== undefined && prev !== undefined && cur !== "" && prev !== "" && t.unit === "%") {
          if (Math.abs(Number(cur) - Number(prev)) > 40) {
            flags.push({
              severity: "warn",
              text: "Unusual swing in " + t.label + " (" + prev + "% \u2192 " + cur + "%) — verify against source records",
              meta: facLabel + " · " + lgaLabel + " · " + fmtDate(date),
              date,
            });
          }
        }
      });
    });
    flags.sort((a, b) => (a.date < b.date ? 1 : -1));
    if (!flags.length) {
      list.innerHTML = '<div class="empty-state"><p>No data-quality flags in the current scope.</p></div>';
      return;
    }
    list.innerHTML = flags
      .slice(0, 14)
      .map(
        (f) =>
          '<div class="flag-row"><span class="flag-icon' +
          (f.severity === "warn" ? " warn" : "") +
          '"></span><div><div class="flag-main">' +
          f.text +
          '</div><div class="flag-meta">' +
          f.meta +
          "</div></div></div>"
      )
      .join("");
  }

  function fmtDate(d) {
    if (!d) return "no date";
    const dt = new Date(d);
    if (isNaN(dt)) return d;
    return dt.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  }

  // ---------------------------------------------------------
  // Action tracker
  // ---------------------------------------------------------
  function collectActions(computed) {
    const out = [];
    computed.forEach((c) => {
      (c.rec.actions || []).forEach((a) => {
        out.push(Object.assign({}, a, { facility: c.rec.facility, lga: c.rec.lga, visitDate: visitDate(c.rec) }));
      });
    });
    return out;
  }

  function isOverdue(a) {
    if (!a.due_date || a.action_status === "closed") return false;
    return new Date(a.due_date) < new Date();
  }

  function renderActionTracker(bundle) {
    const actions = collectActions(bundle.computed);
    const counts = { open: 0, in_progress: 0, escalated: 0, closed: 0 };
    actions.forEach((a) => {
      if (counts[a.action_status] !== undefined) counts[a.action_status]++;
    });
    const overdue = actions.filter(isOverdue);

    document.getElementById("actionCounts").innerHTML = [
      ["Open", counts.open],
      ["In progress", counts.in_progress],
      ["Escalated", counts.escalated],
      ["Closed", counts.closed],
      ["Overdue", overdue.length],
    ]
      .map(
        (c) =>
          '<div class="action-count"><span class="n tabular"' +
          (c[0] === "Overdue" && c[1] > 0 ? ' style="color:var(--red)"' : "") +
          ">" +
          c[1] +
          '</span><span class="t">' +
          c[0] +
          "</span></div>"
      )
      .join("");

    const { lookups } = state;
    const overdueList = document.getElementById("actionOverdue");
    if (!overdue.length) {
      overdueList.innerHTML = '<p style="font-size:12px;color:var(--text-muted);">No overdue actions in the current scope.</p>';
      return;
    }
    overdue.sort((a, b) => (a.due_date < b.due_date ? -1 : 1));
    overdueList.innerHTML =
      '<p class="subhead">Overdue, oldest first</p><table class="table-mini"><thead><tr><th>Gap</th><th>Facility</th><th>Due</th></tr></thead><tbody>' +
      overdue
        .slice(0, 8)
        .map(
          (a) =>
            "<tr><td>" + (a.action_gap || "—") + "</td><td>" + ((lookups.facility[a.facility] || {}).label || a.facility) + '</td><td class="tabular" style="color:var(--red);font-weight:600;">' + fmtDate(a.due_date) + "</td></tr>"
        )
        .join("") +
      "</tbody></table>";
  }

  // ---------------------------------------------------------
  // Facility register + drawer
  // ---------------------------------------------------------
  function buildFacilityRows(computed) {
    const { lookups } = state;
    const byFacility = {};
    computed.forEach((c) => {
      const code = c.rec.facility;
      byFacility[code] = byFacility[code] || [];
      byFacility[code].push(c);
    });
    return Object.keys(byFacility).map((code) => {
      const visits = byFacility[code].slice().sort((a, b) => (visitDate(a.rec) < visitDate(b.rec) ? 1 : -1));
      const latest = visits[0];
      const flagTotal = visits.reduce((s, v) => s + v.m.criticalFlags.length, 0);
      const wardCode = (lookups.facility[code] || {}).ward;
      const wardInfo = lookups.ward[wardCode] || {};
      return {
        code,
        label: (lookups.facility[code] || {}).label || code,
        lgaLabel: lookups.lga[wardInfo.lga] || "—",
        wardLabel: wardInfo.label || "—",
        visits: visits.length,
        lastDate: visitDate(latest.rec),
        score: latest.m.overall,
        classification: latest.m.classification,
        flags: flagTotal,
        history: visits,
      };
    });
  }

  function renderRegister(bundle) {
    let rows = buildFacilityRows(bundle.computed);
    const tbody = document.getElementById("registerBody");
    if (!bundle.computed.length) {
      tbody.innerHTML =
        '<tr><td colspan="7"><div class="empty-state"><h4>No supervision visits yet</h4><p>Once field teams start submitting visits through the KoboToolbox form, every supervised facility will appear here with its latest score and classification.</p></div></td></tr>';
      return;
    }
    const q = (state.registerSearch || "").trim().toLowerCase();
    if (q) rows = rows.filter((r) => r.label.toLowerCase().includes(q));
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state"><p>No facilities match "' + q + '".</p></div></td></tr>';
      return;
    }
    const dir = state.sort.dir === "asc" ? 1 : -1;
    const key = state.sort.key;
    rows.sort((a, b) => {
      let va, vb;
      switch (key) {
        case "facility": va = a.label; vb = b.label; break;
        case "lga": va = a.lgaLabel; vb = b.lgaLabel; break;
        case "visits": va = a.visits; vb = b.visits; break;
        case "last": va = a.lastDate || ""; vb = b.lastDate || ""; break;
        case "class": va = CLASS_ORDER.indexOf(a.classification); vb = CLASS_ORDER.indexOf(b.classification); break;
        case "flags": va = a.flags; vb = b.flags; break;
        default: va = a.score; vb = b.score;
      }
      if (va < vb) return -1 * dir;
      if (va > vb) return 1 * dir;
      return 0;
    });

    tbody.innerHTML = rows
      .map(
        (r) =>
          '<tr data-facility="' +
          r.code +
          '"><td><div class="reg-name">' +
          r.label +
          '</div></td><td><div>' +
          r.lgaLabel +
          '</div><div class="reg-sub">' +
          r.wardLabel +
          '</div></td><td class="tabular">' +
          r.visits +
          "</td><td>" +
          fmtDate(r.lastDate) +
          '</td><td class="tabular" style="font-weight:600;">' +
          r.score +
          '%</td><td><span class="badge ' +
          r.classification.toLowerCase() +
          '">' +
          r.classification +
          '</span></td><td class="tabular">' +
          (r.flags || "—") +
          "</td></tr>"
      )
      .join("");

    tbody.querySelectorAll("tr[data-facility]").forEach((tr) => {
      tr.addEventListener("click", () => openDrawer(tr.getAttribute("data-facility"), rows.find((r) => r.code === tr.getAttribute("data-facility"))));
    });
  }

  function openDrawer(code, row) {
    const { lookups } = state;
    document.getElementById("drawerTitle").textContent = row.label;
    document.getElementById("drawerSub").textContent = row.wardLabel + " ward, " + row.lgaLabel + " LGA";
    document.getElementById("drawerBody").innerHTML =
      '<div class="timeline">' +
      row.history
        .map((v) => {
          const c = CLASS_COLOR[v.m.classification];
          return (
            '<div class="tl-item"><div class="tl-date">' +
            fmtDate(visitDate(v.rec)) +
            '</div><div><span class="tl-score tabular" style="color:' +
            c +
            '">' +
            v.m.overall +
            '%</span> <span class="badge ' +
            v.m.classification.toLowerCase() +
            '">' +
            v.m.classification +
            "</span>" +
            (v.m.criticalFlags.length ? '<div class="flag-meta" style="color:var(--critical);margin-top:4px;">' + v.m.criticalFlags.length + " critical red flag" + (v.m.criticalFlags.length > 1 ? "s" : "") + "</div>" : "") +
            '<div class="flag-meta" style="margin-top:3px;">Visit type: ' +
            (v.rec.visit_type || "—") +
            " · Supervisor: " +
            (v.rec.supervisor_name || "—") +
            "</div></div></div>"
          );
        })
        .join("") +
      "</div>";
    document.getElementById("drawer").classList.add("is-visible");
    document.getElementById("drawerOverlay").classList.add("is-visible");
  }

  function closeDrawer() {
    document.getElementById("drawer").classList.remove("is-visible");
    document.getElementById("drawerOverlay").classList.remove("is-visible");
  }

  // ---------------------------------------------------------
  // Sidebar: weakest facilities
  // ---------------------------------------------------------
  function renderMiniRank(bundle) {
    const rows = buildFacilityRows(bundle.computed).sort((a, b) => a.score - b.score);
    document.getElementById("geoVisitCount").textContent = bundle.filtered.length;
    const el = document.getElementById("miniRank");
    if (!rows.length) {
      el.innerHTML = '<p style="font-size:11.5px;color:var(--ink-text-dim);">No visits yet in scope.</p>';
      return;
    }
    el.innerHTML = rows
      .slice(0, 6)
      .map(
        (r) =>
          '<button class="mini-rank-row" data-facility="' +
          r.code +
          '"><span class="mini-dot" style="background:' +
          CLASS_COLOR[r.classification] +
          '"></span><span class="mini-rank-name">' +
          r.label +
          '</span><span class="mini-rank-score tabular">' +
          r.score +
          "%</span></button>"
      )
      .join("");
    el.querySelectorAll(".mini-rank-row").forEach((btn) => {
      btn.addEventListener("click", () => {
        const code = btn.getAttribute("data-facility");
        const facInfo = state.lookups.facility[code];
        const wardInfo = state.lookups.ward[facInfo.ward];
        state.filters.lga = wardInfo.lga;
        state.filters.ward = facInfo.ward;
        state.filters.facility = code;
        document.getElementById("selLga").value = wardInfo.lga;
        refreshWardOptions();
        document.getElementById("selWard").value = facInfo.ward;
        refreshFacilityOptions();
        document.getElementById("selFacility").value = code;
        render();
      });
    });
  }

  // ---------------------------------------------------------
  // Export — Excel (raw submissions) and Word (summary report)
  // ---------------------------------------------------------
  function exportFileNameBase() {
    const d = new Date();
    const stamp = d.toISOString().slice(0, 10);
    const scope = scopeLabel().replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "");
    return "kwara_iss_" + scope + "_" + stamp;
  }

  function exportExcel(bundle) {
    if (!window.XLSX) {
      alert("Export library did not load — check your internet connection and try again.");
      return;
    }
    const { schema, lookups } = state;
    const qFields = schema.domains.flatMap((d) => d.items.map((it) => it.name));
    const tracerFields = schema.tracers.flatMap((t) => [t.field + "_current", t.field + "_previous"]);
    const header = [
      "visit_id", "date", "lga", "ward", "facility", "facility_type", "visit_type",
      "supervisor_name", "supervisor_level", "overall_score", "classification", "critical_red_flags",
    ].concat(qFields, tracerFields, ["report_completeness_current", "report_completeness_previous", "report_timeliness_current", "report_timeliness_previous"]);

    const rows = bundle.computed.map((c) => {
      const r = c.rec;
      const facInfo = lookups.facility[r.facility] || {};
      const wardInfo = lookups.ward[facInfo.ward] || {};
      const base = [
        r._id || r._uuid || "",
        visitDate(r) || "",
        lookups.lga[r.lga] || r.lga || "",
        wardInfo.label || r.ward || "",
        facInfo.label || r.facility || "",
        r.facility_type || "",
        r.visit_type || "",
        r.supervisor_name || "",
        r.supervisor_level || "",
        c.m.overall,
        c.m.classification,
        c.m.criticalFlags.length,
      ];
      const qVals = qFields.map((f) => (r[f] === undefined ? "" : r[f]));
      const tVals = tracerFields.map((f) => (r[f] === undefined ? "" : r[f]));
      const repVals = [r.report_completeness_current, r.report_completeness_previous, r.report_timeliness_current, r.report_timeliness_previous].map((v) => (v === undefined ? "" : v));
      return base.concat(qVals, tVals, repVals);
    });

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([header].concat(rows));
    XLSX.utils.book_append_sheet(wb, ws, "Submissions");

    const actionHeader = ["facility", "lga", "visit_date", "gap", "further_action", "responsible_level", "responsible_person", "due_date", "status"];
    const actionRows = [];
    bundle.computed.forEach((c) => {
      const facInfo = lookups.facility[c.rec.facility] || {};
      (c.rec.actions || []).forEach((a) => {
        actionRows.push([
          facInfo.label || c.rec.facility || "",
          lookups.lga[c.rec.lga] || c.rec.lga || "",
          visitDate(c.rec) || "",
          a.action_gap || "",
          a.further_action || "",
          a.responsible_level || "",
          a.responsible_person || "",
          a.due_date || "",
          a.action_status || "",
        ]);
      });
    });
    const wsActions = XLSX.utils.aoa_to_sheet([actionHeader].concat(actionRows));
    XLSX.utils.book_append_sheet(wb, wsActions, "Corrective actions");

    XLSX.writeFile(wb, exportFileNameBase() + ".xlsx");
  }

  // Minimal canvas bar chart, returns a PNG data URL.
  function chartImage(items, opts) {
    opts = opts || {};
    const w = opts.width || 640;
    const rowH = opts.rowH || 30;
    const padL = opts.padL || 230;
    const padR = 70;
    const padTop = 30;
    const h = padTop + items.length * rowH + 20;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#FBFAF4";
    ctx.fillRect(0, 0, w, h);
    ctx.font = "600 14px Arial";
    ctx.fillStyle = "#16241D";
    ctx.fillText(opts.title || "", 12, 20);
    const max = opts.max || 100;
    const barMaxW = w - padL - padR;
    items.forEach((item, i) => {
      const y = padTop + i * rowH;
      ctx.font = "12px Arial";
      ctx.fillStyle = "#16241D";
      ctx.textAlign = "right";
      ctx.fillText(item.label, padL - 10, y + rowH / 2 + 4);
      ctx.textAlign = "left";
      const barW = Math.max(2, (item.value / max) * barMaxW);
      ctx.fillStyle = item.color || "#3C6B52";
      ctx.fillRect(padL, y + 5, barW, rowH - 12);
      ctx.fillStyle = "#16241D";
      ctx.font = "600 12px Arial";
      ctx.fillText(String(item.value) + (opts.suffix || ""), padL + barW + 8, y + rowH / 2 + 4);
    });
    return canvas.toDataURL("image/png");
  }

  function exportWord(bundle) {
    const { schema, lookups } = state;
    const { computed } = bundle;
    const scope = scopeLabel();
    const genDate = new Date().toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });

    const domainRows = schema.domains.map((d) => {
      const scores = computed.map((c) => c.m.domainScores[d.key]);
      const avg = scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : 0;
      const flags = computed.reduce((s, c) => s + c.m.criticalFlags.filter((f) => f.domain === d.key).length, 0);
      return { label: d.label, avg, flags, color: avg >= 85 ? "#2E7D46" : avg >= 70 ? "#B07A1E" : "#A23B2D" };
    });
    const domainChart = computed.length
      ? chartImage(domainRows.map((r) => ({ label: r.label, value: r.avg, color: r.color })), { title: "Domain scores (%)", max: 100, suffix: "%" })
      : null;

    const classCounts = { GREEN: 0, AMBER: 0, RED: 0, CRITICAL: 0 };
    computed.forEach((c) => classCounts[c.m.classification]++);
    const classChart = computed.length
      ? chartImage(
          [
            { label: "GREEN", value: classCounts.GREEN, color: "#2E7D46" },
            { label: "AMBER", value: classCounts.AMBER, color: "#B07A1E" },
            { label: "RED", value: classCounts.RED, color: "#A23B2D" },
            { label: "CRITICAL", value: classCounts.CRITICAL, color: "#7B1F22" },
          ],
          { title: "Visits by classification", max: Math.max(1, computed.length), suffix: "" }
        )
      : null;

    const avgScore = computed.length ? Math.round((computed.reduce((s, c) => s + c.m.overall, 0) / computed.length) * 10) / 10 : "—";

    const tracerRows = schema.tracers
      .map((t) => {
        const curVals = computed.map((c) => c.rec[t.field + "_current"]).filter((v) => v !== undefined && v !== null && v !== "");
        const prevVals = computed.map((c) => c.rec[t.field + "_previous"]).filter((v) => v !== undefined && v !== null && v !== "");
        if (!curVals.length) return null;
        const avgCur = round1(curVals.reduce((a, b) => a + Number(b), 0) / curVals.length);
        const avgPrev = prevVals.length ? round1(prevVals.reduce((a, b) => a + Number(b), 0) / prevVals.length) : null;
        return "<tr><td>" + t.label + "</td><td>" + avgCur + (t.unit === "%" ? "%" : "") + "</td><td>" + (avgPrev === null ? "—" : avgPrev + (t.unit === "%" ? "%" : "")) + "</td></tr>";
      })
      .filter(Boolean)
      .join("");

    const facRows = buildFacilityRows(computed)
      .sort((a, b) => a.score - b.score)
      .map((r) => "<tr><td>" + r.label + "</td><td>" + r.lgaLabel + "</td><td>" + r.visits + "</td><td>" + r.score + "%</td><td>" + r.classification + "</td></tr>")
      .join("");

    const actions = collectActions(computed);
    const overdue = actions.filter(isOverdue);
    const actionRows = overdue
      .map((a) => "<tr><td>" + (a.action_gap || "—") + "</td><td>" + ((lookups.facility[a.facility] || {}).label || a.facility) + "</td><td>" + fmtDate(a.due_date) + "</td></tr>")
      .join("");

    const html =
      "<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>" +
      "<head><meta charset='utf-8'><title>Kwara ISS Report</title>" +
      "<style>body{font-family:Calibri,Arial,sans-serif;color:#16241D;} h1{color:#16241D;font-size:22px;margin-bottom:2px;} h2{color:#294B39;font-size:16px;margin-top:26px;border-bottom:1px solid #C7BFA3;padding-bottom:4px;} " +
      "p.meta{color:#5A6459;font-size:12px;margin-top:0;} table{border-collapse:collapse;width:100%;margin-top:8px;} td,th{border:1px solid #C7BFA3;padding:6px 8px;font-size:12px;text-align:left;} th{background:#E4ECE4;} img{margin-top:8px;}</style>" +
      "</head><body>" +
      "<h1>Kwara State Integrated Supportive Supervision</h1>" +
      "<p class='meta'>Field monitoring report — " + scope + " &middot; generated " + genDate + " &middot; " + computed.length + " supervision visit" + (computed.length === 1 ? "" : "s") + " in scope</p>" +
      "<h2>Summary</h2>" +
      "<table><tr><th>Supervision visits</th><td>" + computed.length + "</td></tr>" +
      "<tr><th>Average overall score</th><td>" + avgScore + (computed.length ? "%" : "") + "</td></tr>" +
      "<tr><th>GREEN / AMBER / RED / CRITICAL</th><td>" + classCounts.GREEN + " / " + classCounts.AMBER + " / " + classCounts.RED + " / " + classCounts.CRITICAL + "</td></tr>" +
      "<tr><th>Open corrective actions</th><td>" + actions.filter((a) => a.action_status !== "closed").length + " (" + overdue.length + " overdue)</td></tr></table>" +
      "<h2>Thematic performance</h2>" +
      (domainChart ? "<img src='" + domainChart + "' width='560'>" : "<p>No scored visits in scope.</p>") +
      "<table><tr><th>Domain</th><th>Average score</th><th>Critical red flags</th></tr>" +
      domainRows.map((r) => "<tr><td>" + r.label + "</td><td>" + r.avg + "%</td><td>" + r.flags + "</td></tr>").join("") +
      "</table>" +
      "<h2>Visit classification</h2>" +
      (classChart ? "<img src='" + classChart + "' width='560'>" : "") +
      "<h2>Tracer indicators</h2>" +
      "<table><tr><th>Indicator</th><th>Current</th><th>Previous</th></tr>" + (tracerRows || "<tr><td colspan='3'>No recorded values in scope.</td></tr>") + "</table>" +
      "<h2>Facility register (weakest first)</h2>" +
      "<table><tr><th>Facility</th><th>LGA</th><th>Visits</th><th>Score</th><th>Classification</th></tr>" + (facRows || "<tr><td colspan='5'>No facilities in scope.</td></tr>") + "</table>" +
      "<h2>Overdue corrective actions</h2>" +
      "<table><tr><th>Gap</th><th>Facility</th><th>Due</th></tr>" + (actionRows || "<tr><td colspan='3'>None.</td></tr>") + "</table>" +
      "</body></html>";

    const blob = new Blob(["\ufeff", html], { type: "application/msword" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = exportFileNameBase() + ".doc";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  document.addEventListener("DOMContentLoaded", init);
})();
