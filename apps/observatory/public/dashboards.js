(() => {
  const $ = (id) => document.getElementById(id);
  const id = location.pathname.split("/").filter(Boolean).at(-1);
  let definition;
  let paused = false;
  let generation = 0;
  const requests = new Set();
  let timer;
  let source;
  let streamTimer;
  let streamState = new Map();
  let streamMeta = {};
  const colors = [
    "#b69cff",
    "#5ad8ff",
    "#6cf5b0",
    "#ff8fd8",
    "#ffd36e",
    "#9cb4ff",
    "#f4f4f5",
  ];
  const node = (tag, text, className) => {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = text;
    if (className) el.className = className;
    return el;
  };
  const fmt = (value) =>
    value === null || value === undefined
      ? "Unknown"
      : typeof value === "number"
        ? value.toLocaleString(undefined, { maximumFractionDigits: 6 })
        : Array.isArray(value)
          ? value.map((v) => `${v.from}–${v.to}%: ${v.count}`).join(" · ") ||
            "No measured buckets"
          : String(value);
  const label = (key) =>
    key === "trace_id"
      ? "Opaque trace key"
      : key === "_time"
        ? "Time · UTC"
        : key.replaceAll("_", " ");
  const date = (value) =>
    `${new Date(value).toISOString().slice(0, 19).replace("T", " ")} UTC`;
  function table(rows, columns, caption) {
    const wrap = node("div", undefined, "table-scroll");
    wrap.tabIndex = 0;
    wrap.setAttribute("role", "region");
    wrap.setAttribute(
      "aria-label",
      `${caption}; horizontally and vertically scrollable data`,
    );
    const t = node("table");
    const head = node("thead");
    const tr = node("tr");
    const numeric = new Set(
      columns.filter((key) => rows.some((row) => typeof row[key] === "number")),
    );
    for (const key of columns) {
      const th = node("th", label(key));
      if (numeric.has(key)) th.className = "numeric";
      th.scope = "col";
      tr.append(th);
    }
    head.append(tr);
    t.append(head);
    const body = node("tbody");
    for (const row of rows) {
      const r = node("tr");
      for (const key of columns) {
        const td = node("td");
        if (
          key === "trace_id" &&
          typeof row[key] === "string" &&
          /^[a-f0-9]{32}$/.test(row[key])
        ) {
          const link = node("a", row[key]);
          link.href = `/dashboards/dash#${row[key]}`;
          td.append(link);
        } else if (
          id === "traces" &&
          ["Service", "Operation"].includes(key) &&
          definition.options[key.toLowerCase()].includes(row[key])
        ) {
          const button = node("button", fmt(row[key]));
          button.type = "button";
          button.addEventListener("click", () => {
            $(`filter-${key.toLowerCase()}`).value = row[key];
            if (row.Service && definition.options.service.includes(row.Service))
              $("filter-service").value = row.Service;
            void refresh();
          });
          td.append(button);
        } else td.textContent = fmt(row[key]);
        if (numeric.has(key)) td.className = "numeric";
        r.append(td);
      }
      body.append(r);
    }
    t.append(body);
    wrap.append(t);
    return wrap;
  }
  function chart(rows, metric, columns, caption) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 640 230");
    svg.setAttribute("role", "img");
    svg.setAttribute(
      "aria-label",
      `${caption}; ${label(metric)} over UTC time. Exact values in data table.`,
    );
    svg.classList.add("chart");
    const draw = (tag, attrs, text) => {
      const el = document.createElementNS(svg.namespaceURI, tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
      if (text !== undefined) el.textContent = text;
      svg.append(el);
      return el;
    };
    const times = rows.map((r) => Date.parse(r._time)).filter(Number.isFinite);
    const min = Math.min(...times),
      max = Math.max(...times);
    const numeric = rows
      .map((r) => r[metric])
      .filter((v) => typeof v === "number");
    const peak = Math.max(1, ...numeric);
    const x = (t) => 65 + ((t - min) / (max - min || 1)) * 555;
    const y = (v) => 190 - (v / peak) * 165;
    for (const fraction of [0, 0.5, 1]) {
      draw("line", {
        x1: 65,
        x2: 620,
        y1: y(peak * fraction),
        y2: y(peak * fraction),
      });
      draw(
        "text",
        { x: 57, y: y(peak * fraction) + 4, "text-anchor": "end" },
        (peak * fraction).toLocaleString(undefined, {
          maximumFractionDigits: 2,
          notation: "compact",
        }),
      );
    }
    draw("text", { x: 65, y: 218 }, new Date(min).toISOString().slice(11, 19));
    draw(
      "text",
      { x: 620, y: 218, "text-anchor": "end" },
      `${new Date(max).toISOString().slice(11, 19)} UTC`,
    );
    const dimensions = columns.filter(
      (k) => k !== "_time" && rows.some((r) => typeof r[k] === "string"),
    );
    const groups = new Map();
    for (const row of rows) {
      const key = dimensions.map((k) => row[k]).join(" · ") || label(metric);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    const legend = node("div", undefined, "legend");
    let index = 0;
    for (const [name, values] of groups) {
      const color = colors[index++ % colors.length];
      const points = values
        .filter(
          (r) =>
            typeof r[metric] === "number" &&
            Number.isFinite(Date.parse(r._time)),
        )
        .sort((a, b) => Date.parse(a._time) - Date.parse(b._time));
      if (!points.length) continue;
      draw("path", {
        d: points
          .map(
            (r, i) =>
              `${i && Date.parse(r._time) - Date.parse(points[i - 1]._time) <= ({ "30m": 30000, "1h": 60000, "24h": 1440000 }[$("filter-window").value] ?? 30000) * 1.1 ? "L" : "M"}${x(Date.parse(r._time))},${y(r[metric])}`,
          )
          .join(" "),
        stroke: color,
      });
      for (const r of points)
        draw("circle", {
          cx: x(Date.parse(r._time)),
          cy: y(r[metric]),
          r: 2.5,
          fill: color,
        });
      const item = node("span");
      const swatch = node("i", undefined, "swatch");
      swatch.style.backgroundColor = color;
      item.append(swatch, node("span", name));
      legend.append(item);
    }
    const result = node("div");
    result.append(svg, legend);
    return result;
  }
  function renderData(panel, section, data) {
    const content = section.querySelector(".content");
    content.replaceChildren();
    const good = data.state === "ready" || data.state === "partial";
    let state =
      data.state === "unconfigured"
        ? "Source unavailable: dedicated dataset access is not configured."
        : data.state === "busy"
          ? "Query capacity reached. Retry on the next refresh."
          : data.state === "unavailable"
            ? "Source query unavailable. Retry on the next refresh."
            : data.state === "partial"
              ? "Partial/truncated result; not a complete aggregate."
              : "Axiom observations · ingestion delayed";
    if (data.fetchedAt)
      state += ` · fetched ${date(data.fetchedAt)} · ${date(data.start)} → ${date(data.end)}`;
    section.querySelector(".panel-status").textContent = state;
    if (!data.rows?.length) {
      content.append(
        node(
          "p",
          good
            ? "No matching observations in this window. This is not proof of zero activity or health."
            : "No current data. No demo or zero values substituted.",
          "empty",
        ),
      );
      return;
    }
    if (!good)
      content.append(
        node(
          "p",
          "Last fetched values below are stale, not a successful current query.",
          "panel-note",
        ),
      );
    if (panel.kind === "stat") {
      content.append(
        node("p", fmt(data.rows[0]?.[panel.columns[0]]), "number"),
      );
      if (data.rows[0]?.[panel.columns[0]] === 0)
        content.append(
          node(
            "p",
            "Zero observed matches; not proof of complete coverage.",
            "panel-note",
          ),
        );
    } else if (panel.kind === "series") {
      const numeric = panel.columns.filter(
        (k) => k !== "_time" && data.rows.some((r) => typeof r[k] === "number"),
      );
      if (numeric.length && data.rows.some((r) => r._time)) {
        const holder = node("div");
        const picker = node("select");
        picker.setAttribute("aria-label", `Measurement for ${panel.title}`);
        picker.className = "metric";
        for (const k of numeric) picker.append(new Option(label(k), k));
        const show = () =>
          holder.replaceChildren(
            chart(data.rows, picker.value, panel.columns, panel.title),
          );
        picker.addEventListener("change", show);
        content.append(picker, holder);
        show();
      } else
        content.append(
          node(
            "p",
            "No measured values to plot. Missing is unknown, not zero.",
            "empty",
          ),
        );
      const details = node("details");
      details.append(
        node("summary", "Inspect exact data"),
        table(data.rows, panel.columns, panel.title),
      );
      content.append(details);
    } else content.append(table(data.rows, panel.columns, panel.title));
  }
  function selectedQuery() {
    const params = new URLSearchParams();
    for (const control of $("filters").elements)
      if (control.name && control.value)
        params.set(control.name, control.value);
    return params.toString();
  }
  async function refresh() {
    if (!definition || paused || document.hidden || id === "dash") return;
    clearTimeout(timer);
    for (const controller of requests) controller.abort();
    const gen = ++generation;
    const query = selectedQuery();
    // Keep page URLs stable; filters are encoded in the fragment, never APL.
    history.replaceState(null, "", `${location.pathname}#${query}`);
    $("connection").textContent = "Refreshing aggregates";
    const queue = definition.panels.filter((p) => p.kind !== "private");
    let failures = 0;
    const run = async () => {
      for (;;) {
        const p = queue.shift();
        if (!p || gen !== generation || paused) return;
        const controller = new AbortController();
        requests.add(controller);
        try {
          const r = await fetch(`/api/dashboards/${id}/${p.id}?${query}`, {
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(12000),
            ]),
          });
          if (!r.ok) throw new Error();
          const data = await r.json();
          if (gen !== generation) return;
          renderData(p, $(`panel-${p.id}`), data);
          if (!["ready", "partial"].includes(data.state)) failures++;
        } catch {
          if (gen === generation) {
            renderData(p, $(`panel-${p.id}`), {
              state: "unavailable",
              rows: [],
            });
            failures++;
          }
        } finally {
          requests.delete(controller);
        }
      }
    };
    await Promise.all([run(), run(), run()]);
    if (gen !== generation) return;
    $("connection").textContent = failures
      ? "Some sources unavailable"
      : "Axiom aggregates · ingestion delayed";
    timer = setTimeout(() => void refresh(), definition.refreshMs);
  }
  function streamRender() {
    clearTimeout(streamTimer);
    streamTimer = undefined;
    if (paused || document.hidden) return;
    const trace = $("trace-key")?.value.trim() || "";
    const spans = [...streamState.values()]
      .filter((s) => !trace || s.traceId === trace)
      .sort((a, b) => b.start - a.start);
    const container = $("stream-data");
    if (!container) return;
    container.replaceChildren();
    if (!spans.length)
      container.append(
        node(
          "p",
          trace
            ? "No retained spans for this opaque trace key. Its rows may be outside the bounded window."
            : "No retained matching spans. This does not establish idle or healthy service.",
          "empty",
        ),
      );
    else
      container.append(
        table(
          spans.map((s) => ({
            name: s.name,
            duration_ms: s.durationMs,
            trace_id: s.traceId,
            start: new Date(s.start).toISOString(),
            status: s.status,
            lifecycle: s.lifecycle ?? "ended",
            parent: s.parentState === "present" ? s.parentId : s.parentState,
          })),
          [
            "name",
            "duration_ms",
            "trace_id",
            "start",
            "status",
            "lifecycle",
            "parent",
          ],
          "Saved dash stream",
        ),
      );
    $("coverage").textContent =
      `${spans.length} retained matching rows · ${streamMeta.truncated ? "Truncated rolling window" : "Bounded rolling window"} · 1,000 spans / 15 minutes · ${streamMeta.fetchedAt ? `history fetched ${date(streamMeta.fetchedAt)}` : "history freshness unknown"} · raw correlation IDs removed`;
  }
  function scheduleStream() {
    if (!streamTimer) streamTimer = setTimeout(streamRender, 1000);
  }
  function openStream() {
    source?.close();
    if (paused || document.hidden) return;
    source = new EventSource("/api/stream");
    source.addEventListener("snapshot", (e) => {
      const data = JSON.parse(e.data);
      streamMeta = data;
      streamState = new Map(
        (data.spans || []).map((s) => [JSON.stringify([s.traceId, s.id]), s]),
      );
      scheduleStream();
    });
    source.addEventListener("delta", (e) => {
      const data = JSON.parse(e.data);
      streamMeta = data;
      for (const key of data.removed || []) streamState.delete(key);
      for (const span of data.upserts || [])
        streamState.set(JSON.stringify([span.traceId, span.id]), span);
      while (streamState.size > 1000)
        streamState.delete(streamState.keys().next().value);
      scheduleStream();
    });
    source.addEventListener("status", (e) => {
      const data = JSON.parse(e.data);
      $("connection").textContent =
        data.source === "runtime-push"
          ? "Runtime push · bounded stream"
          : data.state === "live"
            ? "Axiom history · ingestion delayed"
            : "History unavailable";
    });
    source.onerror = () => {
      $("connection").textContent = "Stream disconnected · reconnecting";
    };
  }
  async function init() {
    const r = await fetch(`/api/dashboards/${id}`);
    if (!r.ok) throw new Error();
    definition = await r.json();
    document.title = `${definition.title} — Computah Observatory`;
    $("title").textContent = definition.title;
    $("description").textContent = definition.description;
    for (const page of definition.pages) {
      const a = node("a", page.title);
      a.href = `/dashboards/${page.id}`;
      if (page.id === id) a.setAttribute("aria-current", "page");
      $("pages").append(a);
    }
    if (id === "dash") {
      $("filters").hidden = true;
      const controls = node("div", undefined, "stream-controls");
      const l = node("label", "Opaque trace key (optional)");
      const input = node("input");
      input.id = "trace-key";
      input.placeholder = "All retained traces";
      input.maxLength = 32;
      input.pattern = "[a-f0-9]{32}";
      input.value = /^[a-f0-9]{32}$/.test(location.hash.slice(1))
        ? location.hash.slice(1)
        : "";
      l.append(input);
      const reset = node("button", "Show all traces");
      reset.type = "button";
      reset.addEventListener("click", () => {
        input.value = "";
        history.replaceState(null, "", location.pathname);
        streamRender();
      });
      input.addEventListener("input", streamRender);
      controls.append(l, reset);
      const data = node("div");
      data.id = "stream-data";
      $("panels").className = "";
      $("panels").append(controls, data);
      window.addEventListener("hashchange", () => {
        input.value = /^[a-f0-9]{32}$/.test(location.hash.slice(1))
          ? location.hash.slice(1)
          : "";
        streamRender();
      });
      openStream();
      return;
    }
    const initial = new URLSearchParams(location.hash.slice(1));
    for (const name of ["window", ...definition.filters]) {
      const l = node(
        "label",
        name === "window"
          ? "Time window"
          : name[0].toUpperCase() + name.slice(1),
      );
      let control;
      if (name === "revision") {
        control = node("input");
        control.pattern = "[a-f0-9]{1,40}";
        control.placeholder = "Commit prefix";
        control.maxLength = 40;
      } else {
        control = node("select");
        if (name !== "window") control.append(new Option("All", ""));
        for (const value of name === "window"
          ? ["30m", "1h", "24h"]
          : definition.options[name])
          control.append(new Option(value, value));
      }
      control.id = `filter-${name}`;
      control.name = name;
      control.value = initial.get(name) || definition.selected[name] || "";
      l.append(control);
      $("filters").append(l);
    }
    const apply = node("button", "Apply filters");
    apply.type = "submit";
    $("filters").append(apply);
    $("filters").addEventListener("submit", (e) => {
      e.preventDefault();
      void refresh();
    });
    for (const p of definition.panels) {
      const section = node("section", undefined, `panel ${p.kind}`);
      section.id = `panel-${p.id}`;
      const h = node("h2", p.title);
      section.append(h);
      if (p.note) section.append(node("p", p.note, "panel-note"));
      if (p.kind === "private") {
        section.append(
          node(
            "p",
            "Private evidence · requires Axiom sign-in",
            "panel-status",
          ),
        );
        const a = node("a", "Open authenticated original");
        a.href = `https://app.axiom.co/bagel-w3ue/dashboards/${definition.uid}`;
        a.rel = "noopener noreferrer";
        section.append(a);
      } else
        section.append(
          node("div", undefined, "content"),
          node("p", "Awaiting query", "panel-status"),
        );
      $("panels").append(section);
    }
    $("coverage").textContent =
      "Full selected-window aggregate queries · at most 1,000 rows/panel · bins: 30m → 30s, 1h → 1m, 24h → 24m · five-minute shared refresh · no interpolation across missing data. Raw trace-ID search stays authenticated." +
      (id === "generative-ai"
        ? " Tool filter affects Tool performance only."
        : "");
    await refresh();
  }
  $("pause").addEventListener("click", () => {
    paused = !paused;
    $("pause").setAttribute("aria-pressed", String(paused));
    $("pause").textContent = paused ? "Resume refresh" : "Pause refresh";
    if (paused) {
      generation++;
      for (const controller of requests) controller.abort();
      clearTimeout(timer);
      source?.close();
      $("connection").textContent = "Paused · last fetched data";
    } else if (id === "dash") openStream();
    else void refresh();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      generation++;
      for (const controller of requests) controller.abort();
      clearTimeout(timer);
      source?.close();
    } else if (!paused) {
      if (id === "dash") openStream();
      else void refresh();
    }
  });
  window.addEventListener("pagehide", () => {
    generation++;
    for (const controller of requests) controller.abort();
    clearTimeout(timer);
    clearTimeout(streamTimer);
    source?.close();
  });
  void init().catch(() => {
    $("connection").textContent = "Dashboard unavailable";
    $("description").textContent =
      "The dashboard definition could not be loaded. Reload to retry; no sample data has been substituted.";
  });
})();
