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
  function buildFlags(computed) {
    const { lookups } = state;
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
          facility: facLabel,
          lga: lgaLabel,
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
            facility: facLabel,
            lga: lgaLabel,
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
              facility: facLabel,
              lga: lgaLabel,
              date,
            });
          }
        }
      });
    });
    flags.sort((a, b) => (a.date < b.date ? 1 : -1));
    return flags;
  }

  function renderFlags(bundle) {
    const { computed } = bundle;
    const list = document.getElementById("flagList");
    if (!computed.length) {
      list.innerHTML = '<div class="empty-state"><p>No visits in scope, so no flags to show.</p></div>';
      return;
    }
    const flags = buildFlags(computed);
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

  function tableHtml(headers, rows, emptyMsg) {
    if (!rows.length) return "<table><tr>" + headers.map((h) => "<th>" + h + "</th>").join("") + "</tr><tr><td colspan='" + headers.length + "' class='na'>" + (emptyMsg || "No data available.") + "</td></tr></table>";
    return (
      "<table><tr>" + headers.map((h) => "<th>" + h + "</th>").join("") + "</tr>" +
      rows.map((r) => "<tr>" + r.map((c) => "<td>" + c + "</td>").join("") + "</tr>").join("") +
      "</table>"
    );
  }

  function ulHtml(items, emptyMsg) {
    if (!items.length) return "<p class='na'>" + (emptyMsg || "None recorded.") + "</p>";
    return "<ul>" + items.map((i) => "<li>" + i + "</li>").join("") + "</ul>";
  }

  function olHtml(items, emptyMsg) {
    if (!items.length) return "<p class='na'>" + (emptyMsg || "None recorded.") + "</p>";
    return "<ol>" + items.map((i) => "<li>" + i + "</li>").join("") + "</ol>";
  }

  function globalWeakestItems(schema, computed, limit) {
    const stats = [];
    schema.domains.forEach((d) => {
      d.items.forEach((item) => {
        let num = 0, count = 0;
        computed.forEach((c) => {
          const v = c.rec[item.name];
          if (v === undefined || v === null || v === "" || v === "na") return;
          num += Number(v);
          count += 1;
        });
        if (count) stats.push({ domain: d.label, label: item.label, pct: Math.round((100 * num) / (2 * count)), critical: item.critical });
      });
    });
    return stats.sort((a, b) => a.pct - b.pct).slice(0, limit);
  }

  function exportWord(bundle) {
    const { schema, lookups } = state;
    const { computed } = bundle;
    const scope = scopeLabel();
    const genDate = new Date().toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
    const n = computed.length;

    // ---- core computations ----
    const domainRows = schema.domains.map((d) => {
      const scores = computed.map((c) => c.m.domainScores[d.key]);
      const avg = scores.length ? round1(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
      const flagCount = computed.reduce((s, c) => s + c.m.criticalFlags.filter((f) => f.domain === d.key).length, 0);
      return { key: d.key, label: d.label, weight: d.weight, avg, flagCount, color: avg === null ? "#8A9186" : avg >= 85 ? "#2E7D46" : avg >= 70 ? "#B07A1E" : "#A23B2D" };
    });
    const scoredDomains = domainRows.filter((d) => d.avg !== null);
    const sortedDomains = scoredDomains.slice().sort((a, b) => a.avg - b.avg);
    const weakestDomain = sortedDomains[0] || null;
    const strongestDomain = sortedDomains[sortedDomains.length - 1] || null;

    const classCounts = { GREEN: 0, AMBER: 0, RED: 0, CRITICAL: 0 };
    computed.forEach((c) => classCounts[c.m.classification]++);
    const avgScore = n ? round1(computed.reduce((s, c) => s + c.m.overall, 0) / n) : null;

    const tracerStats = schema.tracers
      .map((t) => {
        const curVals = computed.map((c) => c.rec[t.field + "_current"]).filter((v) => v !== undefined && v !== null && v !== "");
        const prevVals = computed.map((c) => c.rec[t.field + "_previous"]).filter((v) => v !== undefined && v !== null && v !== "");
        const avgCur = curVals.length ? round1(curVals.reduce((a, b) => a + Number(b), 0) / curVals.length) : null;
        const avgPrev = prevVals.length ? round1(prevVals.reduce((a, b) => a + Number(b), 0) / prevVals.length) : null;
        return Object.assign({}, t, { avgCur, avgPrev, trend: trendGood(t.direction, avgCur, avgPrev) });
      })
      .filter((t) => t.avgCur !== null);
    const improvedCount = tracerStats.filter((t) => t.trend === "up").length;
    const declinedCount = tracerStats.filter((t) => t.trend === "down").length;
    const pctTracers = tracerStats.filter((t) => t.unit === "%");

    const lgaMap = {};
    computed.forEach((c) => {
      const code = c.rec.lga;
      lgaMap[code] = lgaMap[code] || { visits: 0, scoreSum: 0, classCounts: { GREEN: 0, AMBER: 0, RED: 0, CRITICAL: 0 } };
      lgaMap[code].visits++;
      lgaMap[code].scoreSum += c.m.overall;
      lgaMap[code].classCounts[c.m.classification]++;
    });
    const lgaRows = Object.keys(lgaMap)
      .map((code) => ({
        label: lookups.lga[code] || code,
        visits: lgaMap[code].visits,
        avg: round1(lgaMap[code].scoreSum / lgaMap[code].visits),
        cc: lgaMap[code].classCounts,
      }))
      .sort((a, b) => a.avg - b.avg);

    const facilityRows = buildFacilityRows(computed).sort((a, b) => a.score - b.score);
    const flags = buildFlags(computed);
    const criticalFlags = flags.filter((f) => f.severity === "critical");
    const warnFlags = flags.filter((f) => f.severity === "warn");
    const flaggedFacilities = new Set(criticalFlags.map((f) => f.facility)).size;

    const actions = collectActions(computed);
    const overdue = actions.filter(isOverdue).sort((a, b) => (a.due_date < b.due_date ? -1 : 1));
    const openActions = actions.filter((a) => a.action_status !== "closed");
    const closedActions = actions.filter((a) => a.action_status === "closed");
    const immediateActions = actions.filter((a) => a.immediate_action && String(a.immediate_action).trim());

    const visitTypeCounts = {};
    computed.forEach((c) => {
      const vt = c.rec.visit_type || "unspecified";
      visitTypeCounts[vt] = (visitTypeCounts[vt] || 0) + 1;
    });
    const visitTypeLabel = (code) => {
      const found = schema.visit_type.find((v) => v.code === code);
      return found ? found.label : code;
    };

    const reportCompleteness = tracerStats.find((t) => t.field === "report_completeness");
    const reportTimeliness = tracerStats.find((t) => t.field === "report_timeliness");
    const dataQualityDomain = domainRows.find((d) => d.key === "dom6");
    const worstItems = globalWeakestItems(schema, computed, 5);

    const visitedFacilities = new Set(computed.map((c) => c.rec.facility));
    const facScope = facilitiesInScope();

    // ---- charts ----
    const domainChart = scoredDomains.length
      ? chartImage(domainRows.filter((d) => d.avg !== null).map((r) => ({ label: r.label, value: r.avg, color: r.color })), { title: "Domain scores (%)", max: 100, suffix: "%" })
      : null;
    const classChart = n
      ? chartImage(
          [
            { label: "GREEN", value: classCounts.GREEN, color: "#2E7D46" },
            { label: "AMBER", value: classCounts.AMBER, color: "#B07A1E" },
            { label: "RED", value: classCounts.RED, color: "#A23B2D" },
            { label: "CRITICAL", value: classCounts.CRITICAL, color: "#7B1F22" },
          ],
          { title: "Visits by classification", max: Math.max(1, n), suffix: "" }
        )
      : null;
    const lgaChart = lgaRows.length
      ? chartImage(lgaRows.map((r) => ({ label: r.label, value: r.avg, color: r.avg >= 85 ? "#2E7D46" : r.avg >= 70 ? "#B07A1E" : "#A23B2D" })), { title: "Average overall score by LGA (%)", max: 100, suffix: "%", rowH: 26 })
      : null;
    const tracerChart = pctTracers.length
      ? chartImage(pctTracers.map((t) => ({ label: t.label, value: t.avgCur, color: "#3C6B52" })), { title: "Tracer indicators — current period (%)", max: 100, suffix: "%", rowH: 26 })
      : null;

    // ---- recommendations ----
    const recommendations = [];
    domainRows.forEach((d) => {
      if (d.avg === null) return;
      if (d.avg < 70) recommendations.push("Prioritize targeted mentorship and refresher training in <b>" + d.label + "</b> (currently averaging " + d.avg + "%), the area furthest from target this reporting period.");
      else if (d.avg < 85) recommendations.push("Continue reinforcing <b>" + d.label + "</b> practices (currently " + d.avg + "%) to move facilities from AMBER to GREEN performance.");
    });
    if (criticalFlags.length) recommendations.push("Immediately investigate and resolve the " + criticalFlags.length + " critical safety red flag" + (criticalFlags.length > 1 ? "s" : "") + " identified, prioritizing maternal/newborn emergency readiness, infection prevention and control, and cold-chain integrity.");
    if (overdue.length) recommendations.push("Escalate the " + overdue.length + " overdue corrective action" + (overdue.length > 1 ? "s" : "") + " to the responsible LGA or State focal person and set a firm closure timeline.");
    if ((reportCompleteness && reportCompleteness.avgCur < 80) || (reportTimeliness && reportTimeliness.avgCur < 80)) recommendations.push("Strengthen routine data reporting: reinforce facility-level completeness and timeliness of monthly summaries submitted to the routine health information system.");
    if (!recommendations.length && n) recommendations.push("Sustain current performance levels through continued quarterly supportive supervision and peer-to-peer learning between higher- and lower-performing facilities.");
    if (n) recommendations.push("Maintain a consistent supportive supervision schedule with structured follow-up on every action point raised during this cycle.");

    // ---- narrative fragments ----
    const execSummary = n
      ? "During the period covered by this report, <b>" + n + "</b> supportive supervision visit" + (n === 1 ? " was" : "s were") + " conducted across <b>" + scope + "</b>, covering " + visitedFacilities.size + " of " + facScope.length + " facilities in scope. The average overall facility performance score was <b>" + avgScore + "%</b>, with " + classCounts.GREEN + " visit(s) classified GREEN, " + classCounts.AMBER + " AMBER, " + classCounts.RED + " RED and " + classCounts.CRITICAL + " CRITICAL. " + criticalFlags.length + " critical safety red flag(s) were recorded across " + flaggedFacilities + " facilit" + (flaggedFacilities === 1 ? "y" : "ies") + ", and " + openActions.length + " corrective action(s) remain open, of which " + overdue.length + " " + (overdue.length === 1 ? "is" : "are") + " overdue."
      : "No supervision visits have yet been recorded for <b>" + scope + "</b> in this reporting period. This report reflects the standard ISS reporting structure and will populate automatically with a full analysis once field teams begin submitting visits through the KoboToolbox digital checklist.";

    const trendNarrative = tracerStats.length
      ? improvedCount + " of " + tracerStats.length + " tracked tracer indicator(s) improved relative to the previous reporting period, " + declinedCount + " declined, and " + (tracerStats.length - improvedCount - declinedCount) + " held broadly steady."
      : "No comparable current/previous indicator values were recorded in this scope.";

    const surveillanceNarrative = reportCompleteness || reportTimeliness
      ? "Average routine report completeness across visited facilities was " + (reportCompleteness ? reportCompleteness.avgCur + "%" : "not recorded") + ", and average reporting timeliness was " + (reportTimeliness ? reportTimeliness.avgCur + "%" : "not recorded") + ". The Data Quality, IPC & Referral domain — which also covers register accuracy, source-verification and referral systems — averaged " + (dataQualityDomain && dataQualityDomain.avg !== null ? dataQualityDomain.avg + "%" : "no data") + " across visited facilities."
      : "No routine reporting indicator values were recorded in this scope.";

    const conclusion = n
      ? "This reporting cycle covering <b>" + scope + "</b> recorded " + n + " supervision visit(s) with an average overall score of " + avgScore + "%. " +
        (classCounts.CRITICAL > 0 ? "The presence of " + classCounts.CRITICAL + " CRITICAL classification(s) underscores the need for urgent follow-up on safety-related gaps. " : "") +
        "Sustained supportive supervision, prompt closure of corrective actions, and continued investment in " + (weakestDomain ? weakestDomain.label : "the weakest-performing thematic areas") + " will be key to improving service readiness and quality of care across supervised facilities. The Kwara State Primary Health Care Development Agency will continue to monitor these indicators through routine ISS visits and will review progress against this action plan at the next supervision cycle."
      : "No supervision data are yet available for this reporting period. This report structure will auto-populate with a full analysis once facility visits are submitted through the digital ISS checklist.";

    // ---- key findings / challenges ----
    const keyFindings = [];
    if (weakestDomain) keyFindings.push("The weakest-performing thematic domain was <b>" + weakestDomain.label + "</b>, averaging " + weakestDomain.avg + "%.");
    if (strongestDomain) keyFindings.push("The strongest-performing thematic domain was <b>" + strongestDomain.label + "</b>, averaging " + strongestDomain.avg + "%.");
    if (lgaRows.length) keyFindings.push("<b>" + lgaRows[0].label + "</b> LGA recorded the lowest average score (" + lgaRows[0].avg + "%), while <b>" + lgaRows[lgaRows.length - 1].label + "</b> LGA recorded the highest (" + lgaRows[lgaRows.length - 1].avg + "%).");
    if (n) keyFindings.push(classCounts.CRITICAL + " of " + n + " visits (" + pct(classCounts.CRITICAL, n) + ") were classified CRITICAL due to at least one critical safety red flag.");
    if (immediateActions.length) keyFindings.push(immediateActions.length + " corrective action(s) were resolved on the spot during the supervision visit itself.");

    const challenges = [];
    worstItems.forEach((it) => challenges.push("<b>" + it.label + "</b> (" + it.domain + ") — met in only " + it.pct + "% of applicable checks" + (it.critical ? ", a critical safety item" : "") + "."));
    if (overdue.length) challenges.push(overdue.length + " corrective action(s) from this and prior visits remain overdue.");
    if (warnFlags.length) challenges.push(warnFlags.length + " reporting-quality flag(s) were raised (low completeness/timeliness or unusual indicator swings).");
    if (!challenges.length) challenges.push("No significant gaps were identified in the current scope.");

    // ---- assembled sections ----
    const pageBreak = "<div class='pagebreak'></div>";

    const cover =
      "<div class='cover'>" +
      "<div class='cover-badge'>KWARA STATE PRIMARY HEALTH CARE DEVELOPMENT AGENCY</div>" +
      "<div class='cover-line'></div>" +
      "<h1 class='cover-title'>Integrated Supportive Supervision</h1>" +
      "<div class='cover-sub'>Field Monitoring Report — " + scope + "</div>" +
      "<div class='cover-meta-box'>" +
      "<div><b>Reporting scope:</b> " + scope + "</div>" +
      "<div><b>Report generated:</b> " + genDate + "</div>" +
      "<div><b>Supervision visits in scope:</b> " + n + "</div>" +
      "<div><b>Reporting basis:</b> KoboToolbox digital supportive supervision checklist</div>" +
      "</div>" +
      "</div>" + pageBreak;

    const secExecSummary =
      "<h2>1. Executive Summary</h2><p>" + execSummary + "</p>" +
      tableHtml(
        ["Metric", "Value"],
        [
          ["Supervision visits", String(n)],
          ["Facilities covered", visitedFacilities.size + " of " + facScope.length],
          ["Average overall score", avgScore === null ? "—" : avgScore + "%"],
          ["GREEN / AMBER / RED / CRITICAL", classCounts.GREEN + " / " + classCounts.AMBER + " / " + classCounts.RED + " / " + classCounts.CRITICAL],
          ["Open corrective actions", openActions.length + " (" + overdue.length + " overdue)"],
        ]
      );

    const secBackground =
      pageBreak + "<h2>2. Background</h2><p>The Kwara State Primary Health Care Development Agency (PHCDA) conducts Integrated Supportive Supervision (ISS) visits to primary health care facilities across the State's 16 Local Government Areas. The ISS tool consolidates supervision of six thematic areas — Facility Readiness &amp; Governance, Routine Immunization, Nutrition, Maternal &amp; Newborn Health, Child Health &amp; Service Integration, and Data Quality, IPC &amp; Referral — into a single digital checklist administered through KoboToolbox. This integrated approach reduces duplication of supervisory visits, strengthens accountability at facility level, and supports real-time, evidence-based decision-making by State and LGA programme managers.</p>";

    const secObjectives =
      "<h2>3. Objectives</h2>" +
      ulHtml([
        "Assess facility compliance with national standards across the six thematic supervision domains.",
        "Identify and document programmatic, clinical and data-quality gaps at the point of care.",
        "Provide on-the-spot coaching and corrective guidance to facility staff.",
        "Track the status of previously agreed corrective actions through to closure.",
        "Generate reliable, timely evidence to guide State and LGA-level programme decisions.",
      ]);

    const secMethodology =
      "<h2>4. Methodology</h2><p>Data for this report were collected using a standardized digital checklist administered via KoboToolbox by trained State and LGA supervisors during facility visits. Each of the 130 checklist items is scored 2 (fully compliant), 1 (partially compliant), 0 (non-compliant) or Not Applicable. Domain scores are calculated as the percentage of applicable points achieved, and an overall facility score is derived as a weighted average across the six domains (Facility Readiness &amp; Governance 10%, Routine Immunization 25%, Nutrition 20%, Maternal &amp; Newborn Health 25%, Child Health &amp; Service Integration 10%, Data Quality/IPC/Referral 10%). Forty-three items flagged as critical safety or programmatic indicators automatically classify a visit as CRITICAL if scored non-compliant, overriding the numeric score. In the absence of a critical flag, facilities are classified GREEN (\u226585%), AMBER (70\u201384%) or RED (&lt;70%). This report reflects data for <b>" + scope + "</b>, covering " + n + " visit(s) as of " + genDate + ".</p>";

    const secKpi =
      pageBreak + "<h2>5. Key Performance Indicators</h2><p>The table below compares each tracked programme indicator against the prior reporting period.</p>" +
      (tracerChart ? "<img src='" + tracerChart + "' width='560'>" : "") +
      tableHtml(
        ["Indicator", "Current period", "Previous period", "Direction"],
        tracerStats.map((t) => [t.label, t.avgCur + (t.unit === "%" ? "%" : ""), t.avgPrev === null ? "—" : t.avgPrev + (t.unit === "%" ? "%" : ""), t.trend === "up" ? "▲ improving" : t.trend === "down" ? "▼ declining" : "▬ steady"]),
        "No tracer indicator values recorded in this scope."
      );

    const secTrend =
      "<h2>6. Trend Analysis</h2><p>" + trendNarrative + "</p>";

    const secGeo =
      pageBreak + "<h2>7. Geographic / LGA Performance</h2><p>Average overall score by Local Government Area, ranked weakest to strongest.</p>" +
      (lgaChart ? "<img src='" + lgaChart + "' width='560'>" : "") +
      tableHtml(
        ["LGA", "Visits", "Average score", "GREEN", "AMBER", "RED", "CRITICAL"],
        lgaRows.map((r) => [r.label, String(r.visits), r.avg + "%", r.cc.GREEN, r.cc.AMBER, r.cc.RED, r.cc.CRITICAL]),
        "No LGA-level data recorded in this scope."
      );

    const secDataQuality =
      pageBreak + "<h2>8. Data Quality</h2><p>" + criticalFlags.length + " critical red flag(s) and " + warnFlags.length + " reporting-quality flag(s) were identified across visits in scope.</p>" +
      tableHtml(
        ["Severity", "Finding", "Facility", "LGA", "Date"],
        flags.slice(0, 15).map((f) => [f.severity === "critical" ? "Critical" : "Warning", f.text, f.facility, f.lga, fmtDate(f.date)]),
        "No data-quality flags in this scope."
      );

    const secSurveillance =
      "<h2>9. Surveillance &amp; Routine Reporting Performance</h2><p>" + surveillanceNarrative + "</p>" +
      tableHtml(
        ["Indicator", "Current period", "Previous period"],
        [
          ["Routine report completeness", reportCompleteness ? reportCompleteness.avgCur + "%" : "—", reportCompleteness && reportCompleteness.avgPrev !== null ? reportCompleteness.avgPrev + "%" : "—"],
          ["Routine report timeliness", reportTimeliness ? reportTimeliness.avgCur + "%" : "—", reportTimeliness && reportTimeliness.avgPrev !== null ? reportTimeliness.avgPrev + "%" : "—"],
          ["Data Quality, IPC & Referral domain", dataQualityDomain && dataQualityDomain.avg !== null ? dataQualityDomain.avg + "%" : "—", "—"],
        ]
      );

    const secActivities =
      pageBreak + "<h2>10. Activities Implemented</h2><p>Supervision activity in this scope, by visit type:</p>" +
      tableHtml(
        ["Visit type", "Count"],
        Object.keys(visitTypeCounts).map((k) => [visitTypeLabel(k), String(visitTypeCounts[k])]),
        "No visits recorded in this scope."
      ) +
      "<p class='subhead'>Corrective actions completed on the spot during the visit</p>" +
      ulHtml(immediateActions.slice(0, 10).map((a) => a.immediate_action + " <span class='na'>(" + ((lookups.facility[a.facility] || {}).label || a.facility) + ")</span>"), "No on-the-spot corrections recorded in this scope.");

    const secFindings =
      pageBreak + "<h2>11. Key Findings</h2>" + ulHtml(keyFindings, "No findings available — no visits recorded in this scope.");

    const secChallenges =
      "<h2>12. Challenges</h2><p class='subhead'>Weakest checklist items across all visited facilities</p>" + ulHtml(challenges);

    const secRecommendations =
      pageBreak + "<h2>13. Recommendations</h2>" + olHtml(recommendations, "No recommendations — no visits recorded in this scope.");

    const secActionPlan =
      "<h2>14. Action Plan</h2><p>Open corrective actions from visits in this scope, oldest due date first.</p>" +
      tableHtml(
        ["Gap", "Facility", "Responsible", "Due date", "Status"],
        openActions
          .slice()
          .sort((a, b) => (a.due_date || "") < (b.due_date || "") ? -1 : 1)
          .slice(0, 25)
          .map((a) => [a.action_gap || "—", (lookups.facility[a.facility] || {}).label || a.facility, (a.responsible_person || "—") + (a.responsible_level ? " (" + a.responsible_level + ")" : ""), fmtDate(a.due_date), a.action_status]),
        "No open corrective actions in this scope."
      );

    const secConclusion =
      pageBreak + "<h2>15. Conclusion</h2><p>" + conclusion + "</p>";

    const toc = [
      "1. Executive Summary", "2. Background", "3. Objectives", "4. Methodology", "5. Key Performance Indicators",
      "6. Trend Analysis", "7. Geographic / LGA Performance", "8. Data Quality", "9. Surveillance & Routine Reporting Performance",
      "10. Activities Implemented", "11. Key Findings", "12. Challenges", "13. Recommendations", "14. Action Plan", "15. Conclusion",
    ];
    const secToc = pageBreak + "<h2 style='border-bottom:none;'>Contents</h2>" + "<table class='toc-table'>" + toc.map((t) => "<tr><td>" + t + "</td></tr>").join("") + "</table>";

    const figuresIntro = (domainChart || classChart)
      ? "<p class='subhead'>Overview</p>" +
        (domainChart ? "<img src='" + domainChart + "' width='560'><div class='chart-cap'>Figure 1. Domain scores across visits in scope (%)</div>" : "") +
        (classChart ? "<img src='" + classChart + "' width='560'><div class='chart-cap'>Figure 2. Distribution of visits by classification</div>" : "")
      : "";

    const html =
      "<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>" +
      "<head><meta charset='utf-8'><title>Kwara ISS Field Monitoring Report</title>" +
      "<style>" +
      "@page{size:21.0cm 29.7cm;margin:2.4cm 2.3cm 2.3cm 2.3cm;}" +
      "body{font-family:Calibri,'Segoe UI',Arial,sans-serif;color:#1C241F;font-size:11pt;line-height:1.5;}" +
      "p{margin:0 0 10pt;text-align:justify;}" +
      "h2{font-family:Calibri,Arial,sans-serif;font-size:13pt;font-weight:bold;text-transform:uppercase;letter-spacing:.3pt;color:#1F3D2E;border-bottom:1.5pt solid #1F3D2E;padding-bottom:5pt;margin:4pt 0 12pt;}" +
      "ul,ol{margin:0 0 12pt;padding-left:24px;} li{margin-bottom:6pt;text-align:justify;}" +
      "table{border-collapse:collapse;width:100%;margin:6pt 0 16pt;}" +
      "td,th{border:0.75pt solid #B9C2B6;padding:6pt 9pt;font-size:10pt;text-align:left;vertical-align:top;}" +
      "th{background:#1F3D2E;color:#FFFFFF;font-weight:bold;text-transform:uppercase;font-size:9pt;letter-spacing:.2pt;}" +
      "tbody tr:nth-child(even) td, table:not(.toc-table) tr:nth-child(even) td{background:#F2F5F1;}" +
      "table.toc-table td{border:none;padding:4pt 0;font-size:11pt;color:#1F3D2E;font-weight:600;}" +
      "img{max-width:100%;margin:8pt 0 2pt;border:0.75pt solid #D8DED6;padding:6pt;background:#FEFEFC;}" +
      ".chart-cap{font-size:9pt;color:#5A6459;font-style:italic;margin:0 0 14pt;text-align:center;}" +
      ".na{color:#8A9186;font-style:italic;} .subhead{font-weight:bold;margin:14pt 0 6pt;font-size:11pt;color:#1F3D2E;}" +
      ".pagebreak{page-break-before:always;}" +
      ".cover{text-align:center;padding-top:150px;}" +
      ".cover-line{width:120px;border-top:2pt solid #1F3D2E;margin:0 auto 26pt;}" +
      ".cover-badge{font-size:10.5pt;letter-spacing:2.2pt;color:#5A6459;margin-bottom:42pt;text-transform:uppercase;font-weight:600;}" +
      ".cover-title{font-family:Cambria,Georgia,serif;font-size:26pt;color:#1C241F;margin:0 0 8pt;font-weight:bold;}" +
      ".cover-sub{font-size:15pt;color:#294B39;margin-bottom:40pt;letter-spacing:.4pt;}" +
      ".cover-meta-box{display:inline-block;border:0.75pt solid #B9C2B6;padding:16pt 26pt;text-align:left;margin-top:10pt;}" +
      ".cover-meta-box div{font-size:10.5pt;color:#3A443E;line-height:2;}" +
      ".cover-meta-box b{color:#1C241F;}" +
      "</style></head><body>" +
      cover + secToc + secExecSummary + figuresIntro + secBackground + secObjectives + secMethodology + secKpi + secTrend + secGeo + secDataQuality + secSurveillance + secActivities + secFindings + secChallenges + secRecommendations + secActionPlan + secConclusion +
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
