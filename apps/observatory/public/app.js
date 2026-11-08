(() => {
  const $ = (id) => document.getElementById(id);
  const POLL_MS = 5_000;
  const TIMEOUT_MS = 8_000;
  const STALE_MS = 15_000;
  const SVG_NS = "http://www.w3.org/2000/svg";
  let snapshot = null;
  let liveSnapshot = null;
  let state = "connecting";
  let demo = false;
  let paused = false;
  let pageHidden = false;
  let inFlight = false;
  let controller = null;
  let timer = null;
  let generation = 0;
  let failures = 0;
  let selectedTrace = null;
  let selectedSpan = null;
  let traces = [];
  let byKey = new Map();

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function put(id, text) {
    const target = $(id);
    if (target.textContent !== text) target.textContent = text;
  }

  const key = (span) => JSON.stringify([span.traceId, span.id]);
  const short = (id) =>
    id.length > 16 ? `${id.slice(0, 10)}…${id.slice(-4)}` : id;
  const ms = (value) =>
    value >= 1000
      ? `${(value / 1000).toFixed(2)} s`
      : `${Number(value.toFixed(2))} ms`;
  const stamp = (value) =>
    new Date(value).toLocaleTimeString([], {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  const matches = (span) =>
    (!$("service").value || span.service === $("service").value) &&
    (!$("status").value || span.status === $("status").value);

  function validProjection(data) {
    if (
      !data ||
      !["live", "unconfigured", "disconnected"].includes(data.state) ||
      !Array.isArray(data.spans) ||
      data.spans.length > 1000 ||
      !(data.fetchedAt === null || Number.isFinite(data.fetchedAt)) ||
      !Number.isFinite(data.windowMs) ||
      data.windowMs <= 0 ||
      !Number.isFinite(data.limit) ||
      data.limit <= 0 ||
      typeof data.truncated !== "boolean"
    )
      return false;
    const seen = new Set();
    return data.spans.every((span) => {
      if (
        !span ||
        !["id", "traceId", "name", "service"].every(
          (field) => typeof span[field] === "string",
        ) ||
        !(span.parentId === null || typeof span.parentId === "string") ||
        !["root", "present", "missing"].includes(span.parentState) ||
        !Number.isFinite(span.start) ||
        Math.abs(span.start) > 8.64e15 ||
        !Number.isFinite(span.durationMs) ||
        span.durationMs < 0 ||
        !Number.isFinite(span.start + span.durationMs) ||
        !["ok", "error", "unset"].includes(span.status) ||
        !Array.isArray(span.links) ||
        !span.links.every(
          (link) =>
            link &&
            typeof link.id === "string" &&
            typeof link.traceId === "string" &&
            typeof link.present === "boolean",
        )
      )
        return false;
      const spanKey = key(span);
      if (seen.has(spanKey)) return false;
      seen.add(spanKey);
      return true;
    });
  }

  function active() {
    return !demo && !paused && !document.hidden && !pageHidden;
  }

  function schedule(delay) {
    clearTimeout(timer);
    if (active()) timer = setTimeout(poll, delay);
  }

  async function poll() {
    if (!active() || inFlight) return;
    inFlight = true;
    const version = generation;
    const request = new AbortController();
    controller = request;
    const deadline = setTimeout(() => request.abort(), TIMEOUT_MS);
    try {
      const response = await fetch("/api/traces", {
        signal: request.signal,
        cache: "no-store",
        credentials: "omit",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error("Unavailable projection");
      const data = await response.json();
      if (!validProjection(data)) throw new Error("Invalid projection");
      if (version !== generation || !active()) return;
      state = data.state;
      failures = data.state === "disconnected" ? failures + 1 : 0;
      if (data.state === "live") {
        liveSnapshot = data;
        snapshot = data;
      } else if (!snapshot || data.state === "unconfigured") {
        snapshot = data;
      }
      render();
    } catch {
      if (version !== generation || !active()) return;
      state = "disconnected";
      failures += 1;
      render();
    } finally {
      clearTimeout(deadline);
      inFlight = false;
      if (controller === request) controller = null;
      if (active())
        schedule(
          version !== generation
            ? 0
            : Math.min(30_000, POLL_MS * 2 ** Math.min(failures, 3)),
        );
    }
  }

  function restart() {
    generation += 1;
    clearTimeout(timer);
    controller?.abort();
    if (active() && !inFlight) schedule(0);
    renderStatus();
  }

  function renderStatus() {
    const age =
      snapshot?.fetchedAt === null || !snapshot
        ? null
        : Math.max(0, Date.now() - snapshot.fetchedAt);
    const stale = age !== null && age > STALE_MS;
    const label = demo
      ? "Synthetic demo"
      : paused
        ? "Updates paused"
        : document.hidden
          ? "Tab hidden · updates paused"
          : state === "disconnected"
            ? "Disconnected"
            : state === "unconfigured"
              ? "Not configured"
              : state === "connecting"
                ? "Connecting"
                : stale
                  ? "Stale snapshot"
                  : age === null
                    ? "Freshness unknown"
                    : "Live projection";
    put("feed-state", label);
    $("state-dot").dataset.state = demo
      ? "demo"
      : state === "disconnected"
        ? "disconnected"
        : stale
          ? "stale"
          : paused || document.hidden || age === null
            ? "paused"
            : state;
    put(
      "freshness",
      demo
        ? "Static example · not production"
        : age === null
          ? "No fetched timestamp"
          : `Fetched ${Math.floor(age / 1000)}s ago${stale ? " · stale" : ""}`,
    );
    $("pause").textContent = paused ? "Resume updates" : "Pause updates";
    $("pause").setAttribute("aria-pressed", String(paused));
    $("pause").disabled = demo;
    $("demo").textContent = demo ? "Return to live" : "Explore demo";
    $("demo").setAttribute("aria-pressed", String(demo));
    let notice =
      "Live sanitized projection. Updates every 5 seconds. Filters find traces; all their spans remain visible for causal context.";
    let tone = "normal";
    if (demo) {
      notice =
        "SYNTHETIC DEMO — static, generic example spans. No production activity is shown. Return to live to reconnect.";
      tone = "demo";
    } else if (state === "disconnected") {
      notice = `The live source is disconnected. ${snapshot?.spans.length ? "Keeping the previous snapshot; it is not current activity." : "No live spans are available."} ${paused ? "Resume updates to reconnect." : `Retrying with backoff, up to 30 seconds.${document.hidden ? " Polling is suspended while this tab is hidden." : ""}`}`;
      tone = "warning";
    } else if (state === "unconfigured") {
      notice =
        "The live source is not configured. No production data is shown. Explore the explicitly labeled demo, or wait for the source to be enabled.";
      tone = "warning";
    } else if (state === "connecting") {
      notice =
        "Connecting to the public trace projection. No private content is queried.";
    } else if (paused || document.hidden) {
      notice = `Updates are paused${document.hidden ? " while this tab is hidden" : " by you"}. The field shows a frozen snapshot${stale ? " that is now stale" : ""}.`;
      tone = "warning";
    } else if (stale || age === null) {
      notice =
        "The source responded, but snapshot freshness is not current or cannot be established. Do not read this as live activity.";
      tone = "warning";
    }
    if (snapshot?.truncated)
      notice += ` Window truncated at ${snapshot.limit.toLocaleString()} spans; relationships and counts are incomplete.`;
    put("notice", notice);
    $("notice").dataset.tone = tone;
  }

  function render() {
    const focused = document.activeElement;
    const focusKey = focused?.dataset.focusKey;
    const indexScroll = $("trace-list").scrollTop;
    const fieldScroll = $("timeline-scroll").scrollTop;
    const service = $("service").value;
    const services = [
      ...new Set((snapshot?.spans ?? []).map((span) => span.service)),
    ].sort();
    const options = [
      new Option("All services", ""),
      ...services.map((name) => new Option(name, name)),
    ];
    if (service && !services.includes(service))
      options.push(new Option(`${service} (not in window)`, service));
    $("service").replaceChildren(...options);
    $("service").value = service;
    $("reset").hidden = !service && !$("status").value;
    put(
      "window-label",
      demo
        ? "Synthetic example"
        : `Last ${Number(((snapshot?.windowMs ?? 900_000) / 60_000).toFixed(1))} minutes`,
    );
    put(
      "sample-label",
      snapshot
        ? `${snapshot.spans.length.toLocaleString()} spans${snapshot.truncated ? " · truncated" : " in window"}`
        : "Up to 1,000 spans",
    );
    byKey = new Map((snapshot?.spans ?? []).map((span) => [key(span), span]));
    const groups = new Map();
    for (const span of snapshot?.spans ?? []) {
      if (!groups.has(span.traceId)) groups.set(span.traceId, []);
      groups.get(span.traceId).push(span);
    }
    traces = [...groups]
      .map(([id, spans]) => {
        spans.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
        const start = Math.min(...spans.map((span) => span.start));
        const end = Math.max(
          ...spans.map((span) => span.start + span.durationMs),
        );
        return {
          id,
          spans,
          start,
          end,
          title: (spans.find((span) => span.parentState === "root") ?? spans[0])
            .name,
        };
      })
      .filter((trace) => trace.spans.some(matches))
      .sort((a, b) => b.start - a.start);
    if (!traces.some((trace) => trace.id === selectedTrace))
      selectedTrace = traces[0]?.id ?? null;
    put("trace-count", String(traces.length));
    const buttons = traces.map((trace) => {
      const button = node("button", "trace-button");
      button.type = "button";
      button.dataset.focusKey = `trace:${trace.id}`;
      button.setAttribute("aria-pressed", String(trace.id === selectedTrace));
      button.title = `Trace ${trace.id}`;
      button.append(node("span", "trace-name", trace.title));
      const meta = node("span", "trace-meta");
      const errors = trace.spans.filter(
        (span) => span.status === "error",
      ).length;
      meta.append(
        node(
          "span",
          "",
          `${trace.spans.length} spans · ${ms(trace.end - trace.start)}`,
        ),
        node(
          "span",
          errors ? "trace-error" : "",
          errors
            ? `${errors} error${errors === 1 ? "" : "s"}`
            : stamp(trace.start),
        ),
      );
      button.append(meta, node("span", "trace-id", short(trace.id)));
      button.addEventListener("click", () => {
        selectedTrace = trace.id;
        selectedSpan = null;
        render();
      });
      return button;
    });
    $("trace-list").replaceChildren(
      ...(buttons.length
        ? buttons
        : [
            node(
              "p",
              "index-empty",
              snapshot?.spans.length
                ? "No traces match these filters. Try all services and statuses."
                : "No traces in this snapshot.",
            ),
          ]),
    );
    const trace = traces.find((item) => item.id === selectedTrace);
    renderField(trace);
    renderStatus();
    $("trace-list").scrollTop = indexScroll;
    $("timeline-scroll").scrollTop = fieldScroll;
    if (focusKey) {
      const replacement = [
        ...document.querySelectorAll("[data-focus-key]"),
      ].find((element) => element.dataset.focusKey === focusKey);
      if (replacement) replacement.focus({ preventScroll: true });
      else if (focused && !focused.isConnected)
        $("timeline-scroll").hidden
          ? $("service").focus({ preventScroll: true })
          : $("timeline-scroll").focus({ preventScroll: true });
    }
  }

  function renderField(trace) {
    $("timeline-scroll").hidden = !trace;
    $("empty-state").hidden = Boolean(trace);
    if (!trace) {
      put(
        "trace-title",
        snapshot?.spans.length ? "No matching traces" : "Waiting for a signal",
      );
      put("trace-summary", "No span timing is being drawn.");
      put(
        "empty-title",
        snapshot?.spans.length
          ? "A narrower field."
          : state === "unconfigured"
            ? "The source is not connected."
            : state === "disconnected"
              ? "The signal is unavailable."
              : "The field is quiet.",
      );
      put(
        "empty-copy",
        snapshot?.spans.length
          ? "No trace contains a span matching both filters. Reset the filters to restore the full window."
          : state === "live"
            ? "The current window contains no spans. A quiet window is not proof that the runtime is idle."
            : "No live activity is available. Demo data appears only when you explicitly choose it.",
      );
      $("empty-demo").hidden = demo || Boolean(snapshot?.spans.length);
      $("span-detail").replaceChildren(
        node(
          "p",
          "detail-placeholder",
          "Select a trace and a span to inspect the available relationships.",
        ),
      );
      put("span-position", "No span selected");
      put("field-note", "Only declared relationships are shown.");
      return;
    }
    if (!trace.spans.some((span) => key(span) === selectedSpan))
      selectedSpan = key(trace.spans.find(matches) ?? trace.spans[0]);
    const extent = Math.max(1, trace.end - trace.start);
    const scale = (start) => ((start - trace.start) / extent) * 100;
    put("trace-title", trace.title);
    put(
      "trace-summary",
      `${trace.spans.length} spans · ${ms(trace.end - trace.start)} observed extent · ${stamp(trace.start)} · ${short(trace.id)}`,
    );
    const missing = trace.spans.filter(
      (span) => span.parentState === "missing",
    ).length;
    put(
      "field-note",
      `${missing ? `${missing} missing parent${missing === 1 ? "" : "s"} · ` : ""}Non-matching spans stay dimmed for context. Bars under 2px use a minimum marker.`,
    );
    $("ruler").replaceChildren(
      ...Array.from({ length: 6 }, (_, index) => {
        const tick = node("span", "", `+${ms((extent * index) / 5)}`);
        tick.style.left = `${index * 20}%`;
        return tick;
      }),
    );
    const positions = new Map(
      trace.spans.map((span, index) => [
        key(span),
        { x: scale(span.start) * 10, y: index * 56 + 24 },
      ]),
    );
    const paths = [];
    function edge(fromKey, toKey, type) {
      const from = positions.get(fromKey);
      const to = positions.get(toKey);
      if (!from || !to || fromKey === toKey) return;
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", `M${from.x},${from.y} V${to.y} H${to.x}`);
      path.setAttribute("class", type);
      paths.push(path);
    }
    const rows = trace.spans.map((span, index) => {
      if (span.parentState === "present" && span.parentId !== null)
        edge(
          JSON.stringify([span.traceId, span.parentId]),
          key(span),
          "parent-edge",
        );
      for (const link of span.links)
        if (link.present && link.traceId === trace.id)
          edge(JSON.stringify([link.traceId, link.id]), key(span), "link-edge");
      const row = node(
        "button",
        `span-row${matches(span) ? "" : " is-context"}`,
      );
      row.type = "button";
      row.dataset.focusKey = `span:${key(span)}`;
      row.setAttribute("aria-pressed", String(key(span) === selectedSpan));
      const label = node("span", "span-label");
      const marker = node("span", "status-marker");
      marker.dataset.status = span.status;
      const text = node("span", "span-label-text");
      text.append(
        node("strong", "", span.name),
        node(
          "small",
          "",
          `${span.service} · ${span.status}${span.parentState === "missing" ? " · parent missing" : span.parentState === "root" ? " · root" : ""}`,
        ),
      );
      label.append(marker, text);
      const track = node("span", "span-track");
      const bar = node("span", "span-bar");
      bar.dataset.status = span.status;
      bar.style.left = `${scale(span.start)}%`;
      bar.style.width = `${(span.durationMs / extent) * 100}%`;
      track.append(bar, node("span", "span-measure", ms(span.durationMs)));
      row.append(label, track);
      row.addEventListener("click", () => selectSpan(span));
      row.addEventListener("keydown", (event) => {
        let next;
        if (event.key === "ArrowDown")
          next = Math.min(index + 1, trace.spans.length - 1);
        else if (event.key === "ArrowUp") next = Math.max(0, index - 1);
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = trace.spans.length - 1;
        if (next === undefined) return;
        event.preventDefault();
        selectSpan(trace.spans[next], true);
      });
      return row;
    });
    $("connections").setAttribute(
      "viewBox",
      `0 0 1000 ${trace.spans.length * 56}`,
    );
    $("connections").setAttribute("preserveAspectRatio", "none");
    $("connections").replaceChildren(...paths);
    $("span-rows").replaceChildren(...rows);
    renderDetail(trace);
  }

  function selectSpan(span, focus = false) {
    selectedSpan = key(span);
    for (const row of $("span-rows").children) {
      const selected = row.dataset.focusKey === `span:${selectedSpan}`;
      row.setAttribute("aria-pressed", String(selected));
      if (selected && focus) row.focus();
    }
    renderDetail(traces.find((trace) => trace.id === selectedTrace));
  }

  function renderDetail(trace) {
    const span = byKey.get(selectedSpan);
    if (!span || !trace) return;
    put(
      "span-position",
      `Span ${trace.spans.indexOf(span) + 1} of ${trace.spans.length} · ${span.status.toUpperCase()}`,
    );
    const identity = node("div");
    identity.append(
      node("h3", "detail-name", span.name),
      node("p", "detail-service", span.service),
    );
    const ids = node("div", "detail-ids");
    ids.append(
      node("div", "", `span ${span.id}`),
      node("div", "", `trace ${span.traceId}`),
    );
    identity.append(ids);
    const facts = node("dl", "detail-facts");
    for (const [label, value] of [
      ["Duration", ms(span.durationMs)],
      ["Status", span.status.toUpperCase()],
      ["From trace start", `+${ms(span.start - trace.start)}`],
      ["Started", `${stamp(span.start)} local`],
    ]) {
      const fact = node("div");
      fact.append(node("dt", "", label), node("dd", "", value));
      facts.append(fact);
    }
    const relations = node("div", "relations");
    relations.append(node("h3", "", "Causal relationships"));
    function relation(id, traceId, label, present) {
      const target = byKey.get(JSON.stringify([traceId, id]));
      if (present && target) {
        const button = node("button", "", `${label}: ${target.name}`);
        button.type = "button";
        button.title = `${traceId} / ${id}`;
        button.dataset.focusKey = `relation:${selectedSpan}:${label}:${traceId}:${id}`;
        button.addEventListener("click", () => {
          $("service").value = "";
          $("status").value = "";
          selectedTrace = target.traceId;
          selectedSpan = key(target);
          render();
          const row = [...$("span-rows").children].find(
            (item) => item.dataset.focusKey === `span:${selectedSpan}`,
          );
          row?.focus({ preventScroll: true });
          row?.scrollIntoView({
            block: "nearest",
            inline: "nearest",
            behavior: "instant",
          });
        });
        relations.append(button);
      } else
        relations.append(
          node(
            "span",
            "relation-missing",
            `${label} missing from projection · ${short(traceId)} / ${short(id)}`,
          ),
        );
    }
    if (span.parentState === "root")
      relations.append(node("p", "", "Root span · no parent declared."));
    else if (span.parentId !== null)
      relation(
        span.parentId,
        span.traceId,
        "Parent",
        span.parentState === "present",
      );
    else
      relations.append(
        node("span", "relation-missing", "Parent missing from projection."),
      );
    for (const link of span.links)
      relation(link.id, link.traceId, "Link", link.present);
    if (!span.links.length)
      relations.append(node("p", "", "No span links declared."));
    $("span-detail").replaceChildren(identity, facts, relations);
  }

  function demoProjection() {
    const start = Date.UTC(2026, 0, 1, 12);
    const definitions = [
      [
        "a1",
        "demo-trace-a",
        null,
        "root",
        "request.accept",
        "gateway",
        0,
        1840,
        "ok",
        [],
      ],
      [
        "a2",
        "demo-trace-a",
        "a1",
        "present",
        "dispatch.enqueue",
        "gateway",
        76,
        126,
        "ok",
        [],
      ],
      [
        "a3",
        "demo-trace-a",
        "a1",
        "present",
        "workflow.run",
        "orchestrator",
        220,
        1510,
        "ok",
        [],
      ],
      [
        "a4",
        "demo-trace-a",
        "a3",
        "present",
        "worker.execute",
        "worker",
        410,
        1090,
        "ok",
        [],
      ],
      [
        "a5",
        "demo-trace-a",
        "a4",
        "present",
        "storage.read",
        "storage",
        478,
        216,
        "ok",
        [],
      ],
      [
        "a6",
        "demo-trace-a",
        "a4",
        "present",
        "operation.attempt",
        "worker",
        770,
        180,
        "error",
        [],
      ],
      [
        "a7",
        "demo-trace-a",
        "a4",
        "present",
        "operation.retry",
        "worker",
        1050,
        320,
        "ok",
        [{ id: "a6", traceId: "demo-trace-a", present: true }],
      ],
      [
        "a8",
        "demo-trace-a",
        "a3",
        "present",
        "result.commit",
        "storage",
        1540,
        116,
        "ok",
        [],
      ],
      [
        "b1",
        "demo-trace-b",
        "outside-window",
        "missing",
        "delivery.resume",
        "dispatcher",
        -8000,
        940,
        "unset",
        [{ id: "a8", traceId: "demo-trace-a", present: true }],
      ],
      [
        "b2",
        "demo-trace-b",
        "b1",
        "present",
        "delivery.flush",
        "dispatcher",
        -7800,
        620,
        "ok",
        [{ id: "outside-link", traceId: "outside-trace", present: false }],
      ],
      [
        "c1",
        "demo-trace-c",
        null,
        "root",
        "schedule.tick",
        "scheduler",
        -15000,
        410,
        "ok",
        [],
      ],
      [
        "c2",
        "demo-trace-c",
        "c1",
        "present",
        "queue.inspect",
        "scheduler",
        -14940,
        185,
        "ok",
        [],
      ],
    ];
    return {
      state: "live",
      fetchedAt: null,
      windowMs: 900000,
      limit: 1000,
      truncated: false,
      spans: definitions.map(
        ([
          id,
          traceId,
          parentId,
          parentState,
          name,
          service,
          offset,
          durationMs,
          status,
          links,
        ]) => ({
          id,
          traceId,
          parentId,
          parentState,
          name,
          service,
          start: start + offset,
          durationMs,
          status,
          links,
        }),
      ),
    };
  }

  function toggleDemo() {
    demo = !demo;
    selectedTrace = null;
    selectedSpan = null;
    $("service").value = "";
    $("status").value = "";
    if (demo) snapshot = demoProjection();
    else {
      snapshot = liveSnapshot;
      state = "connecting";
      paused = false;
      failures = 0;
    }
    restart();
    render();
  }

  $("pause").addEventListener("click", () => {
    paused = !paused;
    restart();
  });
  $("demo").addEventListener("click", toggleDemo);
  $("empty-demo").addEventListener("click", toggleDemo);
  for (const id of ["service", "status"])
    $(id).addEventListener("change", render);
  $("reset").addEventListener("click", () => {
    $("service").value = "";
    $("status").value = "";
    render();
    $("service").focus();
  });
  document.addEventListener("visibilitychange", restart);
  window.addEventListener("pagehide", () => {
    pageHidden = true;
    restart();
  });
  window.addEventListener("pageshow", (event) => {
    pageHidden = false;
    if (event.persisted) restart();
  });
  setInterval(() => {
    if (!document.hidden) renderStatus();
  }, 1000);
  render();
  schedule(0);
})();
