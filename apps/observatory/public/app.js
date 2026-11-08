(() => {
  const $ = (id) => document.getElementById(id);
  const key = (span) => JSON.stringify([span.traceId, span.id]);
  const STALE_MS = 15_000;
  const MAX_SPANS = 1000;
  let spans = new Map();
  let snapshot = null;
  let state = "connecting";
  let stream = null;
  let sourceKind = "axiom-history";
  let lastLiveAt = null;
  let connected = false;
  let paused = false;
  let demo = false;
  let hidden = false;
  let includeExporter = false;
  let selectedTrace = null;
  let selectedSpan = null;
  let pinned = false;
  let shownAt = 0;
  let completedAt = null;
  let tick = null;
  let swapTimer = null;
  let closeTimer = null;
  let closingTo = null;
  let traces = [];
  let renderedTrace = null;
  let detailSignature = "";
  const rows = new Map();
  const cards = new Map();

  function node(tag, className, text) {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (text !== undefined) item.textContent = text;
    return item;
  }
  function put(id, text) {
    if ($(id).textContent !== text) $(id).textContent = text;
  }
  const short = (id) =>
    id.length > 18 ? `${id.slice(0, 10)}…${id.slice(-4)}` : id;
  const ms = (value) =>
    value >= 1000
      ? `${(value / 1000).toFixed(2)} s`
      : `${Math.round(value)} ms`;
  const stamp = (value) =>
    new Date(value).toLocaleTimeString([], { hour12: false });
  const running = () => !demo && !paused && !hidden && !document.hidden;
  const fresh = () =>
    state === "live" &&
    Number.isFinite(snapshot?.fetchedAt) &&
    Date.now() - snapshot.fetchedAt <= STALE_MS;
  const runtimeFresh = () =>
    connected &&
    sourceKind === "runtime-push" &&
    Number.isFinite(lastLiveAt) &&
    Date.now() - lastLiveAt <= STALE_MS;
  const observed = (span) => span.observedAt;
  const isActive = (span) =>
    span.lifecycle === "active" &&
    runtimeFresh() &&
    running() &&
    Number.isFinite(observed(span)) &&
    Date.now() - observed(span) <= STALE_MS;
  function duration(span) {
    if (span.lifecycle !== "active") return span.durationMs;
    // An open span is an observation, not a promise it is still running.
    const seen = observed(span);
    // Only a confirmed fresh runtime observation permits a provisional clock.
    // Stale, disconnected, paused and hidden views return to the last receipt,
    // never an invented extra fifteen seconds of execution or an inferred end.
    return Number.isFinite(seen)
      ? Math.max(0, (isActive(span) ? Date.now() : seen) - span.start)
      : span.durationMs;
  }
  const matches = (span) =>
    (!$("service").value || span.service === $("service").value) &&
    (!$("status").value || span.status === $("status").value);

  function validSpan(span) {
    return (
      span &&
      ["id", "traceId", "name", "service"].every(
        (field) => typeof span[field] === "string" && span[field].length <= 512,
      ) &&
      (span.parentId === null || typeof span.parentId === "string") &&
      ["root", "present", "missing"].includes(span.parentState) &&
      Number.isFinite(span.start) &&
      Math.abs(span.start) <= 8.64e15 &&
      Number.isFinite(span.durationMs) &&
      span.durationMs >= 0 &&
      Number.isFinite(span.start + span.durationMs) &&
      ["ok", "error", "unset"].includes(span.status) &&
      (span.lifecycle === undefined ||
        ["active", "ended"].includes(span.lifecycle)) &&
      (span.observedAt === undefined ||
        (Number.isFinite(span.observedAt) &&
          Math.abs(span.observedAt) <= 8.64e15)) &&
      Array.isArray(span.links) &&
      span.links.length <= MAX_SPANS &&
      span.links.every(
        (link) =>
          link &&
          typeof link.id === "string" &&
          typeof link.traceId === "string" &&
          typeof link.present === "boolean",
      )
    );
  }
  const validState = (data) =>
    data &&
    ["live", "unconfigured", "disconnected", "unavailable", "expired"].includes(
      data.state,
    ) &&
    (data.fetchedAt === null ||
      (Number.isFinite(data.fetchedAt) && Math.abs(data.fetchedAt) <= 8.64e15));
  const validMeta = (data) =>
    validState(data) &&
    Number.isFinite(data.windowMs) &&
    data.windowMs > 0 &&
    Number.isFinite(data.limit) &&
    data.limit > 0 &&
    typeof data.truncated === "boolean";

  function bounded() {
    if (spans.size <= MAX_SPANS) return;
    const oldest = [...spans].sort(
      (a, b) => a[1].start - b[1].start || a[0].localeCompare(b[0]),
    );
    for (let i = 0; i < oldest.length - MAX_SPANS; i++)
      spans.delete(oldest[i][0]);
    snapshot.truncated = true;
  }
  function receive(kind, event) {
    if (!running()) return;
    try {
      const data = JSON.parse(event.data);
      if (kind === "status") {
        if (
          !validState(data) ||
          !["runtime-push", "axiom-history"].includes(data.source) ||
          !(data.lastLiveAt === null || Number.isFinite(data.lastLiveAt))
        )
          throw new Error("Invalid status");
        state = data.state;
        sourceKind = data.source;
        lastLiveAt = data.lastLiveAt;
        // A successful history poll may change freshness without changing any
        // span, in which case the server sends status but no delta.
        if (snapshot) snapshot.fetchedAt = data.fetchedAt;
      } else {
        if (!validMeta(data)) throw new Error("Invalid metadata");
        const incoming = kind === "snapshot" ? data.spans : data.upserts;
        if (
          !Array.isArray(incoming) ||
          incoming.length > MAX_SPANS ||
          !incoming.every(validSpan)
        )
          throw new Error("Invalid spans");
        if (
          kind === "delta" &&
          (!snapshot ||
            !Array.isArray(data.removed) ||
            data.removed.length > MAX_SPANS ||
            !data.removed.every((id) => typeof id === "string"))
        )
          throw new Error("Invalid delta");
        if (kind === "snapshot") spans = new Map();
        else for (const id of data.removed) spans.delete(id);
        for (const span of incoming) spans.set(key(span), span);
        snapshot = {
          state: data.state,
          fetchedAt: data.fetchedAt,
          windowMs: data.windowMs,
          limit: data.limit,
          truncated: data.truncated,
        };
        state = data.state;
        bounded();
      }
      connected = true;
    } catch {
      state = "disconnected";
      connected = false;
    }
    render();
  }
  function disconnect() {
    stream?.close();
    stream = null;
    connected = false;
    clearInterval(tick);
    tick = null;
    clearTimeout(swapTimer);
    clearTimeout(closeTimer);
    closingTo = null;
    document
      .querySelector(".stage")
      .classList.remove("is-closing", "is-swapping");
  }
  function connect() {
    disconnect();
    if (!running()) {
      render();
      return;
    }
    state = "connecting";
    if (typeof EventSource !== "function") {
      state = "unavailable";
      render();
      return;
    }
    const source = new EventSource(
      includeExporter ? "/api/stream?includeExporter=1" : "/api/stream",
    );
    stream = source;
    for (const kind of ["snapshot", "delta", "status"])
      source.addEventListener(kind, (event) => {
        if (stream === source) receive(kind, event);
      });
    source.onerror = () => {
      if (stream !== source) return;
      state = "disconnected";
      connected = false;
      render();
      // Keep this EventSource: its native retry carries Last-Event-ID.
    };
    tick = setInterval(render, 1000);
    render();
  }

  function renderStatus() {
    const age = Number.isFinite(snapshot?.fetchedAt)
      ? Math.max(0, Date.now() - snapshot.fetchedAt)
      : null;
    const activeCount = [...spans.values()].filter(isActive).length;
    const label = demo
      ? "Synthetic demo"
      : paused
        ? "Feed paused"
        : hidden || document.hidden
          ? "Hidden · feed paused"
          : runtimeFresh()
            ? "Runtime observations connected"
            : state === "connecting"
              ? "Connecting"
              : state === "unconfigured"
                ? "History not configured"
                : state === "expired"
                  ? "Source expired"
                  : state === "unavailable"
                    ? "Source unavailable"
                    : state === "disconnected"
                      ? connected
                        ? "Axiom history disconnected"
                        : "Disconnected · reconnecting"
                      : !fresh()
                        ? "Snapshot stale / unknown"
                        : "Stream connected";
    put("feed-state", label);
    put(
      "freshness",
      demo
        ? "Not production"
        : age === null
          ? "No fetched timestamp"
          : `Fetched ${Math.floor(age / 1000)}s ago`,
    );
    $("state-dot").dataset.state =
      (fresh() || runtimeFresh()) && running() ? "live" : "warning";
    put(
      "source-label",
      demo
        ? "Synthetic example · static, not production"
        : runtimeFresh()
          ? "Runtime push · Axiom history ingestion delayed"
          : "Axiom history · ingestion delayed",
    );
    put("pause", paused ? "Resume feed" : "Pause feed");
    $("pause").setAttribute("aria-pressed", String(paused));
    $("pause").disabled = demo;
    put("demo", demo ? "Return to feed" : "Explore demo");
    $("demo").setAttribute("aria-pressed", String(demo));
    $("exporter").setAttribute("aria-pressed", String(includeExporter));
    $("exporter").disabled = demo;
    put("follow", pinned ? "Pinned · follow newest" : "Following newest");
    $("follow").setAttribute("aria-pressed", String(!pinned));
    let notice =
      "Axiom history is ingestion delayed. New records arrive over a stream; that does not make their source instantaneous.";
    if (activeCount)
      notice =
        "Open spans were recently observed. Their elapsed clocks are provisional estimates, not proof the source is continuously current.";
    if (!fresh() && !runtimeFresh())
      notice = `${label}. ${spans.size ? "Retained observations are not current activity." : "No current activity is available."} The connection retries automatically when available.`;
    if (runtimeFresh() && !fresh())
      notice +=
        " Axiom history is unavailable or stale; runtime observations are independent.";
    if (paused || hidden || document.hidden)
      notice =
        "Feed suspended. Retained spans and elapsed clocks are frozen; resume to request a new source snapshot.";
    if (demo)
      notice =
        "SYNTHETIC DEMO — a static illustration of trace timing and relationships. No production activity is shown.";
    if (snapshot?.truncated)
      notice += " Window truncated; counts and relationships are incomplete.";
    if (includeExporter && !demo)
      notice += " Log exporter diagnostics included.";
    put("notice", notice);
    $("notice").dataset.tone = demo
      ? "demo"
      : (!fresh() && !runtimeFresh()) || paused
        ? "warning"
        : "normal";
    put(
      "sample-label",
      `${spans.size.toLocaleString()} / ${Math.min(snapshot?.limit ?? MAX_SPANS, MAX_SPANS).toLocaleString()} spans${snapshot?.truncated ? " · truncated" : ""}`,
    );
    put(
      "window-label",
      demo
        ? "Synthetic example"
        : `Last ${Number(((snapshot?.windowMs ?? 900000) / 60000).toFixed(1))} minutes`,
    );
  }

  function groupTraces() {
    const groups = new Map();
    for (const span of spans.values()) {
      if (!groups.has(span.traceId)) groups.set(span.traceId, []);
      groups.get(span.traceId).push(span);
    }
    return [...groups]
      .map(([id, list]) => {
        list.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
        return {
          id,
          spans: list,
          start: Math.min(...list.map((span) => span.start)),
          end: Math.max(...list.map((span) => span.start + duration(span))),
          active: list.some(isActive),
          ended: list.every((span) => span.lifecycle === "ended"),
          title: (list.find((span) => span.parentState === "root") ?? list[0])
            .name,
        };
      })
      .filter((trace) => trace.spans.some(matches))
      .sort((a, b) => b.start - a.start || a.id.localeCompare(b.id));
  }
  function select(id, pin = true, spanKey = null) {
    clearTimeout(closeTimer);
    closingTo = null;
    document.querySelector(".stage").classList.remove("is-closing");
    pinned = pin;
    if (id !== selectedTrace) {
      selectedTrace = id;
      shownAt = Date.now();
      completedAt = null;
    }
    selectedSpan = spanKey;
    render();
  }
  // Insert only when order changed. Moving every node each tick restarts focus
  // and can replay CSS entrances, even when the object itself is reused.
  function reconcile(parent, ordered) {
    const keep = new Set(ordered);
    for (const child of [...parent.children])
      if (!keep.has(child)) child.remove();
    ordered.forEach((child, index) => {
      if (parent.children[index] !== child)
        parent.insertBefore(child, parent.children[index] ?? null);
    });
  }
  function render() {
    const services = [
      ...new Set([...spans.values()].map((span) => span.service)),
    ].sort();
    const service = $("service").value;
    const signature = JSON.stringify(services);
    if ($("service").dataset.services !== signature) {
      const options = [
        new Option("All services", ""),
        ...services.map((name) => new Option(name, name)),
      ];
      if (service && !services.includes(service))
        options.push(new Option(`${service} (outside window)`, service));
      $("service").replaceChildren(...options);
      $("service").value = service;
      $("service").dataset.services = signature;
    }
    $("reset").hidden = !service && !$("status").value;
    traces = groupTraces();
    const current = traces.find((trace) => trace.id === selectedTrace);
    const candidate = traces.find((trace) => trace.active) ?? traces[0];
    if (
      !pinned &&
      ((running() && connected) || demo) &&
      candidate &&
      candidate.id !== selectedTrace
    ) {
      if (current?.ended && completedAt === null) completedAt = Date.now();
      if (
        !current ||
        (Date.now() - shownAt >= 3000 &&
          (!current.ended || Date.now() - completedAt >= 2400))
      ) {
        if (
          current &&
          !demo &&
          !matchMedia("(prefers-reduced-motion: reduce)").matches
        ) {
          if (closingTo !== candidate.id) {
            clearTimeout(closeTimer);
            closingTo = candidate.id;
            document.querySelector(".stage").classList.add("is-closing");
            closeTimer = setTimeout(() => {
              const target = closingTo;
              closingTo = null;
              document.querySelector(".stage").classList.remove("is-closing");
              if (
                !pinned &&
                running() &&
                traces.some((item) => item.id === target)
              ) {
                selectedTrace = target;
                selectedSpan = null;
                shownAt = Date.now();
                completedAt = null;
                render();
              }
            }, 320);
          }
        } else {
          selectedTrace = candidate.id;
          selectedSpan = null;
          shownAt = Date.now();
          completedAt = null;
        }
      }
    }
    if (!pinned && !candidate) selectedTrace = null;
    const trace = traces.find((item) => item.id === selectedTrace);
    renderStatus();
    put("trace-count", String(traces.length));
    const nextCards = traces.map((item) => {
      let card = cards.get(item.id);
      if (!card) {
        card = node("button", "trace-button");
        card.type = "button";
        card.append(node("span", "trace-name"), node("span", "trace-meta"));
        card.addEventListener("click", () => select(item.id));
        cards.set(item.id, card);
      }
      card.firstChild.textContent = item.title;
      const errors = item.spans.filter(
        (span) => span.status === "error",
      ).length;
      const text = `${item.spans.length} spans · ${ms(item.end - item.start)} · ${errors ? `${errors} error` : item.active ? "observed active" : stamp(item.start)}`;
      if (card.lastChild.textContent !== text)
        card.lastChild.textContent = text;
      card.lastChild.className = `trace-meta${errors ? " trace-error" : ""}`;
      card.setAttribute("aria-pressed", String(item.id === selectedTrace));
      card.title = `Pin trace ${item.id}`;
      return card;
    });
    for (const id of cards.keys())
      if (!traces.some((item) => item.id === id)) cards.delete(id);
    reconcile(
      $("trace-list"),
      nextCards.length
        ? nextCards
        : [
            node(
              "p",
              "index-empty",
              spans.size
                ? "No traces match the filters."
                : "Waiting for observed traces.",
            ),
          ],
    );
    renderField(trace);
  }

  function renderField(trace) {
    $("field").hidden = !trace;
    $("empty-state").hidden = Boolean(trace);
    if (!trace) {
      rows.clear();
      $("span-rows").replaceChildren();
      renderedTrace = null;
      put(
        "trace-title",
        pinned ? "Trace left the window" : "Listening for work",
      );
      put(
        "trace-phase",
        pinned ? "Pinned trace unavailable" : "Awaiting a trace",
      );
      put("trace-summary", "No timing is being drawn.");
      $("scroll-hint").hidden = true;
      put("extent", "Elapsed time");
      put(
        "empty-title",
        spans.size
          ? "Nothing matches this view."
          : state === "unconfigured"
            ? "The source is not configured."
            : "Nothing in the field. Yet.",
      );
      put(
        "empty-copy",
        pinned
          ? "The pinned trace is no longer in this bounded view. Choose Follow newest to continue."
          : "A quiet or unavailable window is not proof the runtime is idle. Demo appears only when you choose it.",
      );
      $("empty-demo").hidden = demo || Boolean(spans.size);
      selectedSpan = null;
      renderDetail(null);
      return;
    }
    if (renderedTrace !== trace.id) {
      const hadTrace = renderedTrace !== null;
      rows.clear();
      $("span-rows").replaceChildren();
      renderedTrace = trace.id;
      const stage = document.querySelector(".stage");
      stage.classList.remove("is-swapping");
      if (hadTrace && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
        // One stage handover per trace, never per span update.
        void stage.offsetWidth;
        stage.classList.add("is-swapping");
        clearTimeout(swapTimer);
        swapTimer = setTimeout(
          () => stage.classList.remove("is-swapping"),
          650,
        );
      }
    }
    const open = trace.spans.some((span) => span.lifecycle === "active");
    put(
      "trace-phase",
      `${pinned ? "Pinned / " : ""}${demo ? "Synthetic trace" : trace.active ? "Observed active · provisional elapsed" : open ? "Open observation · no current confirmation" : trace.ended ? `Observed spans ended${pinned ? "" : " · next trace follows"}` : "Recorded trace · Axiom history"}`,
    );
    put("trace-title", trace.title);
    put(
      "trace-summary",
      `${trace.spans.length} operations · ${stamp(trace.start)} · ${short(trace.id)}`,
    );
    const extent = Math.max(1, trace.end - trace.start);
    // Headroom avoids every active bar being pinned to the far edge.
    const domain = extent * (open ? 1.12 : 1.02);
    const scale = (start) =>
      Math.max(0, Math.min(100, ((start - trace.start) / domain) * 100));
    put(
      "extent",
      `${ms(extent)} ${open ? "estimated extent" : "observed extent"}`,
    );
    if (!$("ruler").children.length)
      for (let i = 0; i < 5; i++) {
        const tick = node("span");
        tick.style.left = `${i * 25}%`;
        $("ruler").append(tick);
      }
    [...$("ruler").children].forEach((item, index) => {
      item.textContent = `+${ms((domain * index) / 4)}`;
    });
    const ordered = trace.spans.map((span) => {
      const id = key(span);
      let row = rows.get(id);
      if (!row) {
        row = node("button", "span-row");
        row.type = "button";
        row.dataset.key = id;
        const label = node("span", "span-label");
        label.append(node("strong"), node("small"));
        const track = node("span", "span-track");
        track.append(node("span", "span-bar"), node("span", "span-measure"));
        row.append(label, track);
        row.addEventListener("click", () => {
          pinned = true;
          selectedSpan = id;
          $("inspector").open = true;
          render();
        });
        row.addEventListener("keydown", (event) => {
          const index = [...$("span-rows").children].indexOf(row);
          const to =
            event.key === "ArrowDown"
              ? index + 1
              : event.key === "ArrowUp"
                ? index - 1
                : event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? $("span-rows").children.length - 1
                    : null;
          if (to !== null) {
            event.preventDefault();
            $("span-rows").children[to]?.focus();
          }
        });
        rows.set(id, row);
      }
      row.className = `span-row${matches(span) ? "" : " is-context"}`;
      row.dataset.status = span.status;
      row.dataset.active = String(isActive(span));
      row.setAttribute("aria-pressed", String(id === selectedSpan));
      row.firstChild.firstChild.textContent = span.name;
      row.firstChild.lastChild.textContent = `${span.service} · ${span.status}${span.parentState === "missing" ? " · parent missing" : ""}`;
      row.lastChild.firstChild.style.setProperty(
        "--x",
        `${scale(span.start)}%`,
      );
      row.lastChild.firstChild.style.setProperty(
        "--w",
        `${Math.min(100 - scale(span.start), (duration(span) / domain) * 100)}%`,
      );
      const measure = `${ms(duration(span))}${span.lifecycle === "active" ? (isActive(span) ? " · provisional" : " · unconfirmed") : ""}`;
      if (row.lastChild.lastChild.textContent !== measure)
        row.lastChild.lastChild.textContent = measure;
      row.title = `${span.name} · ${span.service} · ${span.status} · ${measure}`;
      return row;
    });
    for (const id of rows.keys())
      if (!trace.spans.some((span) => key(span) === id)) rows.delete(id);
    reconcile($("span-rows"), ordered);
    $("scroll-hint").hidden =
      $("field").scrollHeight <= $("field").clientHeight;
    const svg = $("connections");
    const positions = new Map(
      trace.spans.map((span, index) => [
        key(span),
        { x: scale(span.start) * 10, y: index * 72 + 32 },
      ]),
    );
    const paths = [];
    function edge(from, to, type) {
      const a = positions.get(from),
        b = positions.get(to);
      if (!a || !b || from === to) return;
      const path = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "path",
      );
      path.setAttribute("d", `M${a.x},${a.y} V${b.y} H${b.x}`);
      path.setAttribute("class", type);
      paths.push(path);
    }
    for (const span of trace.spans) {
      if (span.parentState === "present" && span.parentId !== null)
        edge(
          JSON.stringify([span.traceId, span.parentId]),
          key(span),
          "parent-edge",
        );
      for (const link of span.links)
        if (link.present)
          edge(JSON.stringify([link.traceId, link.id]), key(span), "link-edge");
    }
    svg.setAttribute("viewBox", `0 0 1000 ${trace.spans.length * 72 - 8}`);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.replaceChildren(...paths);
    put(
      "field-note",
      `Solid: declared parent · dashed: declared link · ${trace.spans.filter((span) => span.parentState === "missing").length} missing parents. Bars have a 3px minimum marker.`,
    );
    if (selectedSpan && !spans.has(selectedSpan)) selectedSpan = null;
    renderDetail(spans.get(selectedSpan));
  }

  function renderDetail(span) {
    const signature = JSON.stringify(span ?? null);
    if (signature === detailSignature) return;
    detailSignature = signature;
    put("span-position", span ? span.name : "Select an operation");
    if (!span) {
      $("span-detail").replaceChildren(
        node(
          "p",
          "",
          "Select an operation to inspect its timing and declared relationships.",
        ),
      );
      return;
    }
    const identity = node("div");
    identity.append(
      node("strong", "", span.name),
      node("p", "", span.service),
      node("p", "detail-ids", `Trace ${span.traceId} / Span ${span.id}`),
    );
    const facts = node("dl", "detail-facts");
    for (const [label, value] of [
      ["Start", stamp(span.start)],
      ["Recorded duration", ms(span.durationMs)],
      ["Status", span.status],
      ["Lifecycle", span.lifecycle ?? "Recorded history"],
      [
        "Observed",
        Number.isFinite(span.observedAt)
          ? stamp(span.observedAt)
          : "Not supplied",
      ],
    ]) {
      const pair = node("div");
      pair.append(node("dt", "", label), node("dd", "", value));
      facts.append(pair);
    }
    const relations = node("div", "relations");
    function relation(id, traceId, label, present) {
      const target = spans.get(JSON.stringify([traceId, id]));
      if (present && target) {
        const button = node("button", "", `${label}: ${target.name}`);
        button.type = "button";
        button.addEventListener("click", () => {
          $("service").value = "";
          $("status").value = "";
          select(traceId, true, key(target));
          rows.get(key(target))?.focus();
        });
        relations.append(button);
      } else
        relations.append(
          node(
            "p",
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
        node("p", "relation-missing", "Parent missing from projection."),
      );
    for (const link of span.links)
      relation(link.id, link.traceId, "Link", link.present);
    if (!span.links.length)
      relations.append(node("p", "", "No span links declared."));
    $("span-detail").replaceChildren(identity, facts, relations);
  }

  function clearView() {
    spans = new Map();
    snapshot = null;
    selectedTrace = null;
    selectedSpan = null;
    pinned = false;
    completedAt = null;
    sourceKind = "axiom-history";
    lastLiveAt = null;
    $("service").value = "";
    $("status").value = "";
  }
  function toggleDemo() {
    demo = !demo;
    disconnect();
    clearView();
    if (!demo) {
      paused = false;
      connect();
      return;
    }
    const start = Date.UTC(2026, 0, 1, 12);
    const definitions = [
      ["1", null, "request.accept", "gateway", 0, 4800, "ok"],
      ["2", "1", "workflow.run", "orchestrator", 240, 4210, "ok"],
      ["3", "2", "worker.execute", "worker", 620, 3250, "ok"],
      ["4", "3", "storage.read", "storage", 840, 610, "ok"],
      ["5", "3", "operation.attempt", "worker", 1720, 430, "error"],
      ["6", "3", "operation.retry", "worker", 2460, 980, "ok"],
      ["7", "2", "result.commit", "storage", 4120, 240, "ok"],
    ];
    for (const [
      id,
      parentId,
      name,
      service,
      offset,
      durationMs,
      status,
    ] of definitions) {
      const span = {
        id,
        traceId: "synthetic-trace-a",
        parentId,
        parentState: parentId ? "present" : "root",
        name,
        service,
        start: start + offset,
        durationMs,
        status,
        lifecycle: "ended",
        links:
          id === "6"
            ? [{ id: "5", traceId: "synthetic-trace-a", present: true }]
            : [],
      };
      spans.set(key(span), span);
    }
    const other = {
      id: "b",
      traceId: "synthetic-trace-b",
      parentId: "outside",
      parentState: "missing",
      name: "delivery.resume",
      service: "dispatcher",
      start: start - 10000,
      durationMs: 1400,
      status: "unset",
      lifecycle: "ended",
      links: [
        { id: "7", traceId: "synthetic-trace-a", present: true },
        { id: "missing", traceId: "outside", present: false },
      ],
    };
    spans.set(key(other), other);
    snapshot = {
      fetchedAt: null,
      windowMs: 900000,
      limit: 1000,
      truncated: false,
    };
    state = "live";
    render();
  }
  $("pause").addEventListener("click", () => {
    paused = !paused;
    if (paused) {
      disconnect();
      render();
    } else connect();
  });
  $("follow").addEventListener("click", () => {
    pinned = false;
    shownAt = 0;
    completedAt = 0;
    render();
  });
  $("demo").addEventListener("click", toggleDemo);
  $("empty-demo").addEventListener("click", toggleDemo);
  $("exporter").addEventListener("click", () => {
    includeExporter = !includeExporter;
    disconnect();
    clearView();
    paused = false;
    connect();
  });
  for (const id of ["service", "status"])
    $(id).addEventListener("change", () => {
      pinned = false;
      shownAt = 0;
      render();
    });
  $("reset").addEventListener("click", () => {
    $("service").value = "";
    $("status").value = "";
    pinned = false;
    render();
    $("service").focus();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      disconnect();
      render();
    } else connect();
  });
  window.addEventListener("pagehide", () => {
    hidden = true;
    disconnect();
  });
  window.addEventListener("pageshow", (event) => {
    hidden = false;
    if (event.persisted) connect();
  });
  connect();
})();
