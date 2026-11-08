(() => {
  const $ = (id) => document.getElementById(id);
  const key = (span) => JSON.stringify([span.traceId, span.id]);
  const STALE_MS = 15_000;
  const MAX_SPANS = 1000;
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
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
  let hoverSpan = null;
  let pinned = false;
  let shownAt = 0;
  let completedAt = null;
  let tick = null;
  let swapTimer = null;
  let closeTimer = null;
  let revealTimer = null;
  let closingTo = null;
  let traces = [];
  let renderedTrace = null;
  let detailSignature = "";
  let ordered = [];
  const rows = new Map();
  const cards = new Map();

  // Each service owns one emission hue; red is reserved for errors.
  const PALETTE = [
    [182, 156, 255],
    [90, 216, 255],
    [108, 245, 176],
    [255, 143, 216],
    [255, 211, 110],
    [156, 180, 255],
  ];
  const HUES = {
    "computah-backend": PALETTE[0],
    "computah-bus": PALETTE[1],
    "computah-slack": PALETTE[2],
    "computah-native": PALETTE[3],
    "computah-dashboard": PALETTE[4],
    "computah-rune-pi": PALETTE[5],
    "computah-observatory": [200, 200, 208],
  };
  const LANE_ORDER = [
    "computah-slack",
    "computah-bus",
    "computah-backend",
    "computah-native",
    "computah-dashboard",
    "computah-rune-pi",
    "computah-observatory",
  ];
  const ERROR = [255, 77, 94];
  function unit(text) {
    // FNV-1a: deterministic layout from already-opaque public identifiers.
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0) / 4294967296;
  }
  const hueOf = (service) =>
    HUES[service] ?? PALETTE[Math.floor(unit(service) * PALETTE.length)];
  const rgb = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

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
    id.length > 18 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
  const ms = (value) =>
    value >= 60_000
      ? `${Math.floor(value / 60_000)}m ${String(Math.floor((value % 60_000) / 1000)).padStart(2, "0")}s`
      : value >= 1000
        ? `${(value / 1000).toFixed(2)} s`
        : value >= 10
          ? `${Math.round(value)} ms`
          : `${value.toFixed(value < 1 ? 2 : 1)} ms`;
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
        if (kind === "snapshot") {
          spans = new Map();
          horizon.reveal();
        } else for (const id of data.removed) spans.delete(id);
        for (const span of incoming) {
          const id = key(span);
          // Flare only first receipt of a span after the initial snapshot.
          if (kind === "delta" && !spans.has(id)) horizon.arrived(id);
          spans.set(id, span);
        }
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
    $("stage").classList.remove("is-closing", "is-swapping");
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
    $("state-dot").dataset.state = demo
      ? "demo"
      : (fresh() || runtimeFresh()) && running()
        ? runtimeFresh()
          ? "runtime"
          : "live"
        : "warning";
    put(
      "source-label",
      demo
        ? "Synthetic example · static, not production"
        : runtimeFresh()
          ? "Runtime push · Axiom history ingestion delayed"
          : `Axiom history · ${
              {
                unconfigured: "not configured",
                unavailable: "unavailable",
                expired: "expired",
                disconnected: "disconnected",
                connecting: "connecting",
              }[state] ?? "ingestion delayed"
            }`,
    );
    put(
      "snapshot-note",
      demo
        ? "The synthetic demo is static and local. It shows no production data and holds no stream connection."
        : "A stream connection is not proof of continuously current runtime activity.",
    );
    put("pause", paused ? "Resume feed" : "Pause feed");
    $("pause").setAttribute("aria-pressed", String(paused));
    $("pause").disabled = demo;
    put("demo", demo ? "Return to feed" : "Explore demo");
    $("demo").setAttribute("aria-pressed", String(demo));
    $("exporter").setAttribute("aria-pressed", String(includeExporter));
    $("exporter").disabled = demo;
    put(
      "follow",
      pinned
        ? "Pinned · follow latest"
        : running() || demo
          ? "Following latest work"
          : "Following latest work · paused",
    );
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
        : `Query window: last ${Number(((snapshot?.windowMs ?? 900000) / 60000).toFixed(1))} minutes`,
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
          services: [...new Set(list.map((span) => span.service))],
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
    $("stage").classList.remove("is-closing");
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
  function reconcile(parent, list) {
    const keep = new Set(list);
    for (const child of [...parent.children])
      if (!keep.has(child)) child.remove();
    list.forEach((child, index) => {
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
    // Follow keeps an observed-active trace while it stays active; otherwise
    // it prefers the largest active trace, then the newest trace with
    // declared structure, then simply the newest trace.
    const candidate =
      (current?.active ? current : null) ??
      traces
        .filter((trace) => trace.active)
        .sort((a, b) => b.spans.length - a.spans.length)[0] ??
      traces.find((trace) => trace.spans.length > 1) ??
      traces[0];
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
        if (current && !demo && !reduceMotion.matches) {
          if (closingTo !== candidate.id) {
            clearTimeout(closeTimer);
            closingTo = candidate.id;
            $("stage").classList.add("is-closing");
            closeTimer = setTimeout(() => {
              const target = closingTo;
              closingTo = null;
              $("stage").classList.remove("is-closing");
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
    put("trace-count", traces.length.toLocaleString());
    const nextCards = traces.map((item) => {
      let card = cards.get(item.id);
      if (!card) {
        card = node("button", "trace-card");
        card.type = "button";
        card.append(
          node("span", "trace-hues"),
          node("span", "trace-name"),
          node("span", "trace-meta"),
        );
        card.addEventListener("click", () => select(item.id));
        card.addEventListener("pointerenter", () =>
          horizon.focusTrace(item.id),
        );
        card.addEventListener("pointerleave", () => horizon.focusTrace(null));
        cards.set(item.id, card);
      }
      const [hues, name, meta] = card.children;
      if (hues.dataset.services !== item.services.join()) {
        hues.dataset.services = item.services.join();
        hues.replaceChildren(
          ...item.services.slice(0, 6).map((service) => {
            const dot = node("i");
            dot.style.setProperty("--hue", rgb(hueOf(service)));
            return dot;
          }),
        );
      }
      if (name.textContent !== item.title) name.textContent = item.title;
      const errors = item.spans.filter(
        (span) => span.status === "error",
      ).length;
      const text = `${item.spans.length} ${item.spans.length === 1 ? "span" : "spans"} · ${ms(item.end - item.start)} · ${errors ? `${errors} error` : item.active ? "observed active" : stamp(item.start)}`;
      if (meta.textContent !== text) meta.textContent = text;
      meta.className = `trace-meta${errors ? " trace-error" : ""}`;
      card.dataset.active = String(item.active);
      card.setAttribute("aria-pressed", String(item.id === selectedTrace));
      card.title = `${item.title} · pin trace ${item.id}`;
      return card;
    });
    const present = new Set(traces.map((item) => item.id));
    for (const id of cards.keys())
      if (!present.has(id)) {
        cards.delete(id);
        horizon.forget(id);
      }
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
    horizon.update();
  }

  // Declared parents only: a depth-first walk of supplied topology. Spans with
  // missing or out-of-window parents stay roots at their chronological place.
  function treeOrder(list) {
    const byId = new Map(list.map((span) => [span.id, span]));
    const children = new Map();
    const roots = [];
    for (const span of list) {
      const parent =
        span.parentState === "present" &&
        span.parentId !== null &&
        span.parentId !== span.id &&
        byId.has(span.parentId)
          ? span.parentId
          : null;
      if (parent === null) roots.push(span);
      else {
        if (!children.has(parent)) children.set(parent, []);
        children.get(parent).push(span);
      }
    }
    const out = [];
    const visited = new Set();
    const walk = (span, depth, parent) => {
      if (visited.has(span.id)) return;
      visited.add(span.id);
      out.push({ span, depth, parent });
      for (const child of children.get(span.id) ?? [])
        walk(child, depth + 1, span);
    };
    for (const span of roots) walk(span, 0, null);
    for (const span of list) walk(span, 0, null);
    return out;
  }

  // Dim the namespace so the operation itself carries the headline.
  function renderTitle(name) {
    const title = $("trace-title");
    if (title.dataset.name === name) return;
    title.dataset.name = name;
    const cut = name.includes("/")
      ? name.lastIndexOf("/")
      : name.lastIndexOf(".");
    if (cut <= 0 || cut === name.length - 1) {
      title.textContent = name;
      return;
    }
    title.replaceChildren(
      node("span", "ns", name.slice(0, cut + 1)),
      document.createTextNode(name.slice(cut + 1)),
    );
  }
  function renderSummary(trace) {
    const errors = trace.spans.filter((span) => span.status === "error").length;
    const parts = [
      `${trace.spans.length} ${trace.spans.length === 1 ? "operation" : "operations"}`,
      ms(trace.end - trace.start),
      stamp(trace.start),
      ...(errors ? [`${errors} error${errors === 1 ? "" : "s"}`] : []),
      `trace ${short(trace.id)}`,
    ];
    const signature = `${parts.join("|")}|${trace.services.join()}`;
    if ($("trace-summary").dataset.signature === signature) return;
    $("trace-summary").dataset.signature = signature;
    const hues = node("span", "summary-hues");
    for (const service of trace.services) {
      const chip = node(
        "span",
        "service-chip",
        service.replace(/^computah-/, ""),
      );
      chip.style.setProperty("--hue", rgb(hueOf(service)));
      hues.append(chip);
    }
    $("trace-summary").replaceChildren(
      ...parts.map((text, index) =>
        node(
          "span",
          index === parts.length - 1
            ? "mono"
            : errors && index === 3
              ? "is-error"
              : "",
          text,
        ),
      ),
      hues,
    );
  }

  function renderField(trace) {
    $("field").hidden = !trace;
    $("empty-state").hidden = Boolean(trace);
    $("stage-body").hidden = !trace;
    if (!trace) {
      rows.clear();
      ordered = [];
      $("span-rows").replaceChildren();
      $("connections").replaceChildren();
      renderedTrace = null;
      put(
        "trace-title",
        pinned ? "Trace left the window" : "Listening for work",
      );
      put(
        "trace-phase",
        pinned ? "Pinned trace unavailable" : "Awaiting a trace",
      );
      $("trace-summary").dataset.signature = "";
      $("trace-title").dataset.name = "";
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
    const field = $("field");
    if (renderedTrace !== trace.id) {
      const hadTrace = renderedTrace !== null;
      rows.clear();
      $("span-rows").replaceChildren();
      renderedTrace = trace.id;
      hoverSpan = null;
      horizon.focusSpan(null);
      field.scrollTop = 0;
      const stage = $("stage");
      stage.classList.remove("is-swapping");
      field.classList.remove("is-revealing");
      if (!reduceMotion.matches) {
        // One stage handover per trace, never per span update.
        void stage.offsetWidth;
        if (hadTrace) stage.classList.add("is-swapping");
        field.classList.add("is-revealing");
        clearTimeout(swapTimer);
        clearTimeout(revealTimer);
        swapTimer = setTimeout(
          () => stage.classList.remove("is-swapping"),
          650,
        );
        revealTimer = setTimeout(
          () => field.classList.remove("is-revealing"),
          1500,
        );
      }
    }
    const open = trace.spans.some((span) => span.lifecycle === "active");
    $("trace-phase").dataset.tone = demo
      ? "demo"
      : trace.active
        ? "active"
        : open
          ? "warning"
          : "settled";
    put(
      "trace-phase",
      `${pinned ? "Pinned / " : ""}${demo ? "Synthetic trace" : trace.active ? "Observed active · provisional elapsed" : open ? "Open observation · no current confirmation" : trace.ended ? `Observed spans ended${pinned || !running() ? "" : " · next trace follows"}` : "Recorded trace · Axiom history"}`,
    );
    renderTitle(trace.title);
    renderSummary(trace);
    const extent = Math.max(1, trace.end - trace.start);
    // Headroom avoids every active bar being pinned to the far edge; the
    // domain then rounds up to a whole number of 1/2/5×10ⁿ ruler steps.
    const want = extent * (open ? 1.12 : 1.02);
    const magnitude = 10 ** Math.floor(Math.log10(want / 4));
    const step =
      [1, 2, 5, 10].map((m) => m * magnitude).find((v) => want / v <= 5) ??
      10 * magnitude;
    const domain = Math.ceil(want / step - 1e-9) * step;
    const scale = (start) =>
      Math.max(0, Math.min(100, ((start - trace.start) / domain) * 100));
    put(
      "extent",
      `${ms(extent)} ${open ? "estimated extent" : "observed extent"}`,
    );
    const tickCount = Math.round(domain / step);
    const tickLabel = (value) =>
      value >= 60_000
        ? `${Math.floor(value / 60_000)}m${value % 60_000 ? ` ${Math.round((value % 60_000) / 1000)}s` : ""}`
        : value >= 1000
          ? `${Number((value / 1000).toFixed(2))} s`
          : `${Number(value.toFixed(3))} ms`;
    const ruler = $("ruler");
    while (ruler.children.length > tickCount + 1) ruler.lastChild.remove();
    while (ruler.children.length < tickCount + 1) ruler.append(node("span"));
    [...ruler.children].forEach((item, index) => {
      item.style.left = `${(index / tickCount) * 100}%`;
      const text = index ? `+${tickLabel(step * index)}` : "0";
      if (item.textContent !== text) item.textContent = text;
    });
    $("timing-field").style.setProperty("--grid", `${100 / tickCount}%`);
    ordered = treeOrder(trace.spans);
    const rowNodes = ordered.map(({ span, depth }, index) => {
      const id = key(span);
      let row = rows.get(id);
      if (!row) {
        row = node("button", "span-row");
        row.type = "button";
        row.dataset.key = id;
        const label = node("span", "span-label");
        label.append(node("strong"), node("small"));
        const track = node("span", "span-track");
        // The measure rides inside the bar so it moves with bar transitions.
        const bar = node("span", "span-bar");
        bar.append(node("span", "span-measure"));
        track.append(bar);
        row.append(label, track);
        row.addEventListener("click", () => {
          pinned = true;
          selectedSpan = selectedSpan === id ? null : id;
          render();
        });
        row.addEventListener("pointerenter", () => {
          hoverSpan = id;
          highlightPath();
          horizon.focusSpan(id);
        });
        row.addEventListener("pointerleave", () => {
          hoverSpan = null;
          highlightPath();
          horizon.focusSpan(null);
        });
        row.addEventListener("keydown", (event) => {
          const list = [...$("span-rows").children];
          const at = list.indexOf(row);
          const to =
            event.key === "ArrowDown"
              ? at + 1
              : event.key === "ArrowUp"
                ? at - 1
                : event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? list.length - 1
                    : null;
          if (to !== null) {
            event.preventDefault();
            list[to]?.focus();
          }
        });
        rows.set(id, row);
      }
      row.className = `span-row${matches(span) ? "" : " is-context"}`;
      row.dataset.status = span.status;
      row.dataset.active = String(isActive(span));
      row.dataset.open = String(span.lifecycle === "active");
      row.dataset.missing = String(span.parentState === "missing");
      row.style.setProperty("--depth", String(Math.min(depth, 6)));
      row.style.setProperty("--i", String(Math.min(index, 24)));
      row.style.setProperty("--hue", rgb(hueOf(span.service)));
      row.setAttribute("aria-pressed", String(id === selectedSpan));
      const [name, meta] = row.firstChild.children;
      if (name.textContent !== span.name) name.textContent = span.name;
      const metaText = `${span.service.replace(/^computah-/, "")} · ${span.status}${span.parentState === "missing" ? " · parent missing" : ""}${depth > 6 ? ` · depth ${depth}` : ""}`;
      if (meta.textContent !== metaText) meta.textContent = metaText;
      const bar = row.lastChild.firstChild;
      const measureNode = bar.firstChild;
      const x = scale(span.start);
      const w = Math.min(100 - x, (duration(span) / domain) * 100);
      bar.style.setProperty("--x", `${x}%`);
      bar.style.setProperty("--w", `${w}%`);
      bar.style.setProperty("--xs", (x / 100).toFixed(3));
      measureNode.dataset.side =
        x + w <= 72 ? "after" : x >= 22 ? "before" : "inside";
      const measure = `${ms(duration(span))}${span.lifecycle === "active" ? (isActive(span) ? " · provisional" : " · unconfirmed") : ""}`;
      if (measureNode.textContent !== measure)
        measureNode.textContent = measure;
      row.title = `${span.name} · ${span.service} · ${span.status} · ${measure}`;
      return row;
    });
    const live = new Set(trace.spans.map(key));
    for (const id of rows.keys()) if (!live.has(id)) rows.delete(id);
    reconcile($("span-rows"), rowNodes);
    $("scroll-hint").hidden = field.scrollHeight <= field.clientHeight;
    drawConnections(trace);
    const missing = trace.spans.filter(
      (span) => span.parentState === "missing",
    ).length;
    put(
      "field-note",
      `Tree from declared parents · dashed arcs are declared links · ${missing} missing ${missing === 1 ? "parent" : "parents"} · bars keep a 3px minimum marker.`,
    );
    if (selectedSpan && !spans.has(selectedSpan)) selectedSpan = null;
    const at = ordered.findIndex(({ span }) => key(span) === selectedSpan);
    renderDetail(
      spans.get(selectedSpan),
      at >= 0 ? `${at + 1} of ${ordered.length}` : "",
      trace,
    );
  }

  function drawConnections(trace) {
    const svg = $("connections");
    const box = $("timing-field");
    const list = $("span-rows");
    if (!box.clientWidth || !box.scrollHeight) return;
    // Layout offsets ignore entrance transforms, so elbows land on the final
    // dot positions even while rows are still animating in.
    const geo = new Map();
    for (const { span } of ordered) {
      const row = rows.get(key(span));
      if (!row) continue;
      const name = row.firstChild.firstChild;
      const track = row.lastChild;
      const bar = track.firstChild;
      const ox = list.offsetLeft + row.offsetLeft;
      const oy = list.offsetTop + row.offsetTop;
      geo.set(key(span), {
        x: ox + name.offsetLeft + 3,
        y: oy + name.offsetTop + name.offsetHeight / 2,
        bx: ox + track.offsetLeft + bar.offsetLeft,
        by: oy + track.offsetTop + bar.offsetTop + bar.offsetHeight / 2,
      });
    }
    const paths = [];
    const make = (d, className, child) => paths.push([d, className, child]);
    for (const { span, parent } of ordered) {
      const b = geo.get(key(span));
      if (!parent || !b) continue;
      const a = geo.get(key(parent));
      if (!a) continue;
      const r = Math.min(6, (b.x - a.x) / 2, (b.y - a.y) / 2);
      make(
        b.x - a.x < 8
          ? `M${a.x},${a.y + 5} V${b.y - 5}`
          : `M${a.x},${a.y + 5} V${b.y - r} Q${a.x},${b.y} ${a.x + r},${b.y} H${b.x - 6}`,
        "tree-edge",
        key(span),
      );
    }
    for (const span of trace.spans)
      for (const link of span.links) {
        if (!link.present || link.traceId !== span.traceId) continue;
        const a = geo.get(JSON.stringify([link.traceId, link.id]));
        const b = geo.get(key(span));
        if (!a || !b || a === b) continue;
        const bend = Math.max(18, Math.abs(b.by - a.by) * 0.35);
        make(
          `M${a.bx},${a.by} C${a.bx - bend},${(a.by + b.by) / 2} ${b.bx - bend},${(a.by + b.by) / 2} ${b.bx},${b.by}`,
          "link-edge",
          key(span),
        );
      }
    const signature = `${box.clientWidth}x${box.scrollHeight}|${paths.join("|")}`;
    if (svg.dataset.signature !== signature) {
      svg.dataset.signature = signature;
      svg.setAttribute("viewBox", `0 0 ${box.clientWidth} ${box.scrollHeight}`);
      svg.replaceChildren(
        ...paths.map(([d, className, child]) => {
          const path = document.createElementNS(
            "http://www.w3.org/2000/svg",
            "path",
          );
          path.setAttribute("d", d);
          path.setAttribute("class", className);
          path.dataset.child = child;
          return path;
        }),
      );
    }
    highlightPath();
  }
  function highlightPath() {
    const focus = hoverSpan ?? selectedSpan;
    const path = new Set();
    let at = ordered.find(({ span }) => key(span) === focus);
    while (at) {
      path.add(key(at.span));
      const parent = at.parent;
      at = parent && ordered.find(({ span }) => span === parent);
    }
    for (const edge of $("connections").children)
      edge.classList.toggle("is-path", path.has(edge.dataset.child));
    for (const [id, row] of rows)
      row.classList.toggle("is-lineage", path.has(id) && id !== focus);
  }

  function renderDetail(span, position = "", trace = null) {
    put(
      "span-position",
      span ? `Operation ${position}` : "Select an operation",
    );
    const signature = JSON.stringify([span ?? null, trace?.start ?? null]);
    $("inspector").hidden = !span;
    $("stage-body").classList.toggle("has-inspector", Boolean(span));
    if (signature === detailSignature) return;
    detailSignature = signature;
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
    const identity = node("div", "detail-identity");
    const service = node("span", "service-chip", span.service);
    service.style.setProperty("--hue", rgb(hueOf(span.service)));
    identity.append(node("strong", "", span.name), service);
    const facts = node("dl", "detail-facts");
    for (const [label, value] of [
      ["Start", stamp(span.start)],
      [
        "Offset in trace",
        trace ? `+${ms(Math.max(0, span.start - trace.start))}` : "—",
      ],
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
      pair.dataset.status = label === "Status" ? value : "";
      pair.append(node("dt", "", label), node("dd", "", value));
      facts.append(pair);
    }
    const ids = node("dl", "detail-ids");
    for (const [label, value] of [
      ["Trace", span.traceId],
      ["Span", span.id],
    ]) {
      const pair = node("div");
      pair.append(node("dt", "", label), node("dd", "", value));
      ids.append(pair);
    }
    const relations = node("div", "relations");
    relations.append(node("h4", "", "Relationships"));
    function relation(id, traceId, label, present) {
      const target = spans.get(JSON.stringify([traceId, id]));
      if (present && target) {
        const button = node("button", "relation");
        button.type = "button";
        button.append(node("span", "", label), node("strong", "", target.name));
        button.style.setProperty("--hue", rgb(hueOf(target.service)));
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
    $("span-detail").replaceChildren(identity, facts, relations, ids);
  }

  // The horizon: every retained span as light at its real start time, lanes
  // by service, drifting left with the wall clock only while the feed runs.
  const horizon = (() => {
    const canvas = $("horizon");
    const frame = $("horizon-frame");
    const tip = $("horizon-tip");
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      // Without canvas the rest of the observatory still works.
      frame.hidden = true;
      const skip = () => {};
      return {
        update: skip,
        reveal: skip,
        arrived: skip,
        focusTrace: skip,
        focusSpan: skip,
        forget: skip,
      };
    }
    let width = 0;
    let height = 0;
    let ratio = 1;
    let d0 = null;
    let frozenAt = Date.now();
    let introAt = null;
    let pointer = null;
    let hoverKey = null;
    let focusTraceId = null;
    let focusKey = null;
    let raf = 0;
    let hits = [];
    const arrivals = new Map();
    const AXIS = 26;
    const now = () => performance.now();

    function resize() {
      const rect = frame.getBoundingClientRect();
      ratio = Math.min(2, window.devicePixelRatio || 1);
      width = Math.max(1, Math.round(rect.width));
      height = Math.max(1, Math.round(rect.height));
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      wake();
    }
    function wallNow() {
      if (demo) return null;
      if (running() && connected) frozenAt = Date.now();
      return frozenAt;
    }
    function lanes() {
      const present = [...new Set([...spans.values()].map((s) => s.service))];
      present.sort((a, b) => {
        const ia = LANE_ORDER.indexOf(a);
        const ib = LANE_ORDER.indexOf(b);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
      });
      return present;
    }
    function domain() {
      const all = [...spans.values()];
      if (!all.length) return null;
      const wall = wallNow();
      let min = Infinity;
      let max = -Infinity;
      const floor =
        wall === null ? -Infinity : wall - (snapshot?.windowMs ?? 900000);
      for (const span of all) {
        if (span.start >= floor && span.start < min) min = span.start;
        max = Math.max(max, span.start + duration(span));
      }
      if (!Number.isFinite(min)) min = floor;
      const end =
        wall === null ? max + (max - min) * 0.04 : Math.max(wall, max);
      const start = min - (end - min) * 0.02;
      return { start, end: Math.max(end, start + 1000), wall };
    }
    function niceStep(span, pixels) {
      const steps = [
        1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2000, 5000, 10_000, 15_000,
        30_000, 60_000, 120_000, 300_000, 600_000, 1_800_000, 3_600_000,
        21_600_000, 86_400_000,
      ];
      return (
        steps.find((step) => (step / span) * pixels >= 96) ??
        Math.max(86_400_000, span / 8)
      );
    }
    const clock = (value) => {
      const s = Math.round(Math.abs(value) / 1000);
      return value >= 1000
        ? `−${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
        : `−${Math.round(Math.abs(value))}ms`;
    };

    function draw() {
      raf = 0;
      // Moving between displays changes density without resizing the frame.
      if (Math.min(2, window.devicePixelRatio || 1) !== ratio) resize();
      const t = now();
      const motion = !reduceMotion.matches;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, width, height);
      hits = [];
      const dom = domain();
      const services = lanes();
      const narrow = width < 700;
      const gutter = narrow ? 12 : 156;
      const right = narrow ? 12 : 28;
      const top = narrow ? 22 : 14;
      const plotH = height - AXIS - top;
      const laneH = services.length ? plotH / services.length : plotH;
      ctx.font = "11px 'Geist Mono', ui-monospace, monospace";
      ctx.textBaseline = "middle";
      if (!dom) {
        canvas.setAttribute("aria-label", "Span horizon: no spans retained");
        ctx.strokeStyle = "rgba(255,255,255,0.08)";
        ctx.beginPath();
        ctx.moveTo(gutter, height / 2);
        ctx.lineTo(width - right, height / 2);
        ctx.stroke();
        ctx.textAlign = "center";
        ctx.fillStyle = "rgba(142,142,152,1)";
        ctx.fillText(
          state === "connecting"
            ? "Waiting for the first snapshot"
            : "No retained spans in this window",
          width / 2,
          height / 2 - 18,
        );
        return;
      }
      if (motion) {
        if (d0 === null || Math.abs(dom.start - d0) > dom.end - dom.start)
          d0 = dom.start;
        else d0 += (dom.start - d0) * 0.06;
      } else d0 = dom.start;
      const start = d0;
      const span = Math.max(1, dom.end - start);
      const X = (time) =>
        gutter + ((time - start) / span) * (width - gutter - right);
      // Time grid.
      const step = niceStep(span, width - gutter - right);
      const anchor = dom.end;
      ctx.textAlign = "center";
      for (let v = anchor - step, n = 0; v > start && n < 40; v -= step, n++) {
        const x = X(v);
        if (x < gutter + 30) break;
        ctx.fillStyle = "rgba(255,255,255,0.055)";
        ctx.fillRect(Math.round(x), top, 1, plotH);
        ctx.fillStyle = "rgba(161,161,170,0.9)";
        ctx.fillText(
          dom.wall === null ? `+${ms(v - start)}` : clock(anchor - v),
          x,
          height - AXIS / 2,
        );
      }
      // Lanes.
      services.forEach((service, index) => {
        const y = top + index * laneH;
        ctx.fillStyle = "rgba(255,255,255,0.07)";
        ctx.fillRect(
          gutter,
          Math.round(y + laneH) - 0.5,
          width - gutter - right,
          1,
        );
        const c = hueOf(service);
        const label = service.replace(/^computah-/, "");
        ctx.textAlign = "left";
        ctx.font = "500 12px Geist, system-ui, sans-serif";
        if (!narrow) {
          ctx.fillStyle = rgb(c);
          ctx.beginPath();
          ctx.arc(28, y + laneH / 2, 3, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = "rgba(244,244,245,0.92)";
          ctx.fillText(label, 40, y + laneH / 2);
        }
        ctx.font = "11px 'Geist Mono', ui-monospace, monospace";
      });
      const laneOf = new Map(services.map((s, i) => [s, i]));
      const Y = (s) =>
        top +
        laneOf.get(s.service) * laneH +
        laneH * (0.16 + 0.68 * unit(s.traceId));
      // The gap between the newest retained start and now. Its cause is not
      // known (idle time, ingestion delay, a pause), so it is only described.
      let newest = -Infinity;
      for (const s of spans.values()) newest = Math.max(newest, s.start);
      if (dom.wall !== null && !runtimeFresh()) {
        const gx = X(newest);
        const nx = X(dom.end);
        if (nx - gx > 14) {
          const grad = ctx.createLinearGradient(gx, 0, nx, 0);
          grad.addColorStop(0, "rgba(255,255,255,0)");
          grad.addColorStop(1, "rgba(255,255,255,0.06)");
          ctx.fillStyle = grad;
          ctx.fillRect(gx, top, nx - gx, plotH);
          if (nx - gx > 120 && !narrow) {
            ctx.textAlign = "right";
            ctx.fillStyle = "rgba(161,161,170,0.95)";
            ctx.fillText("no newer spans retained", nx - 8, top + 10);
          }
        }
      }
      const intro =
        motion && introAt !== null ? Math.min(1, (t - introAt) / 1500) : 1;
      const eased = 1 - (1 - intro) ** 3;
      const scanX = gutter + eased * (width - gutter - right + 40);
      const focusTrace =
        (hoverKey && spans.get(hoverKey)?.traceId) ??
        focusTraceId ??
        selectedTrace;
      const wall = dom.wall ?? dom.end;
      // Selected trace column.
      const chosen = traces.find((trace) => trace.id === focusTrace);
      if (chosen) {
        const a = X(chosen.start);
        const b = Math.max(a + 2, X(chosen.end));
        ctx.fillStyle = "rgba(255,255,255,0.045)";
        ctx.fillRect(a - 3, top, b - a + 6, plotH);
        ctx.fillStyle = "rgba(255,255,255,0.5)";
        ctx.fillRect(a - 3, top, b - a + 6, 1);
        ctx.fillRect(a - 3, top + plotH - 1, b - a + 6, 1);
      }
      ctx.globalCompositeOperation = "lighter";
      // Constellations: every declared, retained parent edge, drawn faintly.
      ctx.lineWidth = 1;
      for (const s of spans.values()) {
        if (s.parentState !== "present" || s.parentId === null) continue;
        if (s.traceId === focusTrace) continue;
        const parent = spans.get(JSON.stringify([s.traceId, s.parentId]));
        if (!parent) continue;
        const px = X(Math.max(parent.start, start));
        const cx = X(Math.max(s.start, start));
        if (Math.max(px, cx) > scanX || Math.max(px, cx) < gutter) continue;
        const py = Y(parent);
        const cy = Y(s);
        ctx.strokeStyle = rgb(hueOf(s.service), focusTrace ? 0.07 : 0.16);
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.bezierCurveTo(px, (py + cy) / 2, cx, (py + cy) / 2, cx, cy);
        ctx.stroke();
      }
      const later = [];
      for (const [id, s] of spans) {
        const x0 = X(Math.max(s.start, start));
        const x1 = X(s.start + duration(s));
        if (x1 < gutter - 4 || x1 < x0) continue;
        if (x0 > scanX) continue;
        const y = Y(s);
        const inFocus = s.traceId === focusTrace;
        if (inFocus) {
          later.push([id, s, x0, x1, y]);
          continue;
        }
        const age = Math.max(0, Math.min(1, (s.start - start) / span));
        let alpha = (0.5 + 0.5 * age) * (matches(s) ? 1 : 0.22);
        if (focusTrace) alpha *= 0.42;
        if (scanX - x0 < 60 && intro < 1) alpha = Math.min(1, alpha + 0.6);
        const c = s.status === "error" ? ERROR : hueOf(s.service);
        mark(s, c, x0, x1, y, alpha, false, t, motion);
        hits.push([id, x0, x1, y]);
      }
      // Declared parent edges of the focused trace, then its marks on top.
      if (later.length) {
        const at = new Map(later.map(([, s, x0, , y]) => [s.id, [x0, y]]));
        ctx.lineWidth = 1;
        for (const [, s, x0, , y] of later) {
          if (s.parentState !== "present" || !at.has(s.parentId)) continue;
          const [px, py] = at.get(s.parentId);
          ctx.strokeStyle = "rgba(255,255,255,0.55)";
          ctx.beginPath();
          ctx.moveTo(px, py);
          ctx.bezierCurveTo(px, (py + y) / 2, x0, (py + y) / 2, x0, y);
          ctx.stroke();
        }
        for (const [id, s, x0, x1, y] of later) {
          const c = s.status === "error" ? ERROR : hueOf(s.service);
          mark(s, c, x0, x1, y, 1, true, t, motion);
          hits.push([id, x0, x1, y]);
        }
      }
      ctx.globalCompositeOperation = "source-over";
      // Narrow lane labels sit inside the plot, so they draw over the marks.
      if (narrow) {
        ctx.textAlign = "left";
        ctx.font = "500 12px Geist, system-ui, sans-serif";
        services.forEach((service, index) => {
          const y = top + index * laneH;
          const label = service.replace(/^computah-/, "");
          const w = ctx.measureText(label).width;
          ctx.fillStyle = "rgba(0,0,0,0.82)";
          ctx.fillRect(gutter - 4, y + 2, w + 18, 16);
          ctx.fillStyle = rgb(hueOf(service));
          ctx.beginPath();
          ctx.arc(gutter + 3, y + 10, 2.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = "rgba(244,244,245,0.92)";
          ctx.fillText(label, gutter + 10, y + 10);
        });
        ctx.font = "11px 'Geist Mono', ui-monospace, monospace";
      }
      // Focused span ring (hover in tree or canvas).
      const ring = hoverKey ?? focusKey;
      const target = ring && spans.get(ring);
      if (target && target.start >= start) {
        const x = X(target.start);
        const y = Y(target);
        ctx.strokeStyle = "rgba(255,255,255,0.95)";
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        ctx.arc(x, y, 7, 0, Math.PI * 2);
        ctx.stroke();
      }
      // Now line.
      const nowX = X(wall);
      ctx.fillStyle =
        dom.wall === null ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0.7)";
      ctx.fillRect(Math.round(nowX), top - 6, 1, plotH + 6);
      ctx.textAlign = "right";
      ctx.fillStyle = "rgba(244,244,245,0.95)";
      ctx.fillText(
        dom.wall === null ? "end" : running() && connected ? "now" : "frozen",
        Math.min(width - 4, nowX + (narrow ? 0 : 20)),
        height - AXIS / 2,
      );
      // Scan line.
      if (intro < 1) {
        const grad = ctx.createLinearGradient(scanX - 90, 0, scanX, 0);
        grad.addColorStop(0, "rgba(255,255,255,0)");
        grad.addColorStop(1, "rgba(255,255,255,0.09)");
        ctx.fillStyle = grad;
        ctx.fillRect(scanX - 90, top, 90, plotH);
        ctx.fillStyle = "rgba(255,255,255,0.9)";
        ctx.fillRect(Math.round(scanX), top - 6, 1, plotH + 6);
      } else introAt = null;
      for (const [id, at] of arrivals) if (t - at > 1600) arrivals.delete(id);
      const tracesCount = new Set([...spans.values()].map((s) => s.traceId))
        .size;
      const description = `Span horizon: ${spans.size.toLocaleString()} retained spans from ${tracesCount.toLocaleString()} traces across ${services.length} services (${services.join(", ")}), from ${stamp(start)} to ${dom.wall === null ? "the end of the example" : stamp(wall)}.`;
      if (canvas.getAttribute("aria-label") !== description)
        canvas.setAttribute("aria-label", description);
      if (pointer) updateTip();
      if (motion && !document.hidden) {
        // Full frame rate only while something moves quickly; the slow drift
        // of a running feed needs only a few frames per second.
        const busy =
          intro < 1 ||
          arrivals.size > 0 ||
          [...spans.values()].some(isActive) ||
          Math.abs(dom.start - d0) > span * 0.002;
        if (busy) schedule();
        else if (running() && connected) schedule(140);
      }
    }
    function mark(s, c, x0, x1, y, alpha, focus, t, motion) {
      const narrowMarks = width < 700;
      // A span that began before the visible window gets a left-pointing cue
      // at the edge instead of a start dot it does not have there.
      const clipped = s.start < d0;
      const long = x1 - x0 >= 2;
      const active = isActive(s);
      if (long) {
        ctx.lineCap = "round";
        ctx.strokeStyle = rgb(c, alpha * (focus ? 0.28 : 0.12));
        ctx.lineWidth = focus ? 7 : 5;
        ctx.beginPath();
        ctx.moveTo(x0, y);
        ctx.lineTo(x1, y);
        ctx.stroke();
        ctx.strokeStyle = rgb(c, alpha * 0.85);
        ctx.lineWidth = focus ? 2 : 1.4;
        ctx.beginPath();
        ctx.moveTo(x0, y);
        ctx.lineTo(x1, y);
        ctx.stroke();
      }
      if (clipped) {
        ctx.strokeStyle = rgb(c, Math.min(1, alpha + 0.2));
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        ctx.moveTo(x0 + 5, y - 4);
        ctx.lineTo(x0, y);
        ctx.lineTo(x0 + 5, y + 4);
        ctx.stroke();
      } else {
        ctx.fillStyle = rgb(c, alpha * (focus ? 0.32 : 0.16));
        ctx.beginPath();
        ctx.arc(
          x0,
          y,
          narrowMarks ? (focus ? 4.6 : 4.2) : focus ? 7 : 5.4,
          0,
          Math.PI * 2,
        );
        ctx.fill();
        ctx.fillStyle = focus ? "rgba(255,255,255,0.95)" : rgb(c, alpha);
        ctx.beginPath();
        ctx.arc(
          x0,
          y,
          narrowMarks ? (focus ? 2 : 1.7) : focus ? 2.6 : 2.1,
          0,
          Math.PI * 2,
        );
        ctx.fill();
        if (s.status === "error") {
          // Errors also differ by shape, not only by red.
          ctx.strokeStyle = rgb(ERROR, Math.min(1, alpha * 0.8));
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(x0, y, 3.6, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      if (s.lifecycle === "active") {
        // Open observation: a head at the last provisional or observed extent.
        const pulse = active && motion ? 0.5 + 0.5 * Math.sin(t / 260) : 0.6;
        ctx.fillStyle = rgb(c, active ? 0.18 + 0.18 * pulse : 0.08);
        ctx.beginPath();
        ctx.arc(x1, y, 5 + 3 * pulse, 0, Math.PI * 2);
        ctx.fill();
        if (active) {
          ctx.fillStyle = "rgba(255,255,255,0.95)";
          ctx.beginPath();
          ctx.arc(x1, y, 2.2, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.strokeStyle = rgb(c, 0.8);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(x1, y, 3, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      const arrived = arrivals.get(key(s));
      if (arrived !== undefined && motion) {
        const p = Math.min(1, (t - arrived) / 1400);
        ctx.strokeStyle = rgb(c, (1 - p) * 0.75);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(x0, y, 3 + 13 * (1 - (1 - p) ** 3), 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    function nearest() {
      if (!pointer) return null;
      let best = null;
      let distance = 14;
      for (const [id, x0, x1, y] of hits) {
        const dx =
          pointer.x < x0 ? x0 - pointer.x : pointer.x > x1 ? pointer.x - x1 : 0;
        const d = Math.hypot(dx, pointer.y - y);
        if (d < distance) {
          distance = d;
          best = id;
        }
      }
      return best;
    }
    function updateTip() {
      const next = nearest();
      if (next !== hoverKey) {
        hoverKey = next;
        wake();
      }
      const s = hoverKey && spans.get(hoverKey);
      canvas.style.cursor = s ? "pointer" : "default";
      if (!s) {
        tip.hidden = true;
        return;
      }
      const trace = traces.find((item) => item.id === s.traceId);
      const lines = [
        s.name,
        `${s.service.replace(/^computah-/, "")} · ${s.status} · ${ms(duration(s))}${s.lifecycle === "active" ? (isActive(s) ? " provisional" : " unconfirmed") : ""}`,
        `${new Date(s.start).toDateString() === new Date().toDateString() ? stamp(s.start) : new Date(s.start).toLocaleString([], { hour12: false })} · ${trace ? `${trace.spans.length} in trace` : "filtered out"}`,
      ];
      const signature = lines.join("|");
      if (tip.dataset.signature !== signature) {
        tip.dataset.signature = signature;
        tip.replaceChildren(
          node("strong", "", lines[0]),
          node("span", "", lines[1]),
          node("span", "mono", lines[2]),
        );
        tip.style.setProperty("--hue", rgb(hueOf(s.service)));
      }
      tip.hidden = false;
      const left = Math.min(
        width - tip.offsetWidth - 8,
        Math.max(8, pointer.x + 14),
      );
      const topY =
        pointer.y > height / 2
          ? pointer.y - tip.offsetHeight - 14
          : pointer.y + 14;
      tip.style.setProperty("--tx", `${left}px`);
      tip.style.setProperty("--ty", `${Math.max(4, topY)}px`);
    }
    let idle = 0;
    function schedule(delay = 0) {
      if (raf) return;
      if (!delay) {
        raf = requestAnimationFrame(draw);
        return;
      }
      raf = -1;
      idle = setTimeout(() => {
        raf = requestAnimationFrame(draw);
      }, delay);
    }
    function wake() {
      if (raf === -1) {
        clearTimeout(idle);
        raf = 0;
      }
      schedule();
    }
    canvas.addEventListener("pointermove", (event) => {
      const rect = canvas.getBoundingClientRect();
      pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      if (reduceMotion.matches) draw();
      else wake();
    });
    canvas.addEventListener("pointerleave", () => {
      pointer = null;
      hoverKey = null;
      tip.hidden = true;
      wake();
    });
    canvas.addEventListener("click", (event) => {
      const rect = canvas.getBoundingClientRect();
      pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const id = nearest();
      const s = id && spans.get(id);
      if (!s) return;
      $("service").value = matches(s) ? $("service").value : "";
      $("status").value = matches(s) ? $("status").value : "";
      select(s.traceId, true, id);
      if (event.pointerType !== "mouse") {
        pointer = null;
        hoverKey = null;
        tip.hidden = true;
      }
    });
    if (typeof ResizeObserver === "function")
      new ResizeObserver(resize).observe(frame);
    else resize();
    window.addEventListener("resize", () => resize());
    reduceMotion.addEventListener?.("change", () => wake());
    document.fonts?.ready.then(() => wake());
    return {
      update() {
        if (reduceMotion.matches) draw();
        else wake();
      },
      reveal() {
        introAt = reduceMotion.matches ? null : now();
        d0 = null;
        arrivals.clear();
      },
      arrived(id) {
        arrivals.set(id, now());
      },
      focusTrace(id) {
        focusTraceId = id;
        this.update();
      },
      focusSpan(id) {
        focusKey = id;
        this.update();
      },
      forget(traceId) {
        if (focusTraceId === traceId) focusTraceId = null;
      },
    };
  })();

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
    horizon.reveal();
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
  $("inspector-close").addEventListener("click", () => {
    const row = rows.get(selectedSpan);
    selectedSpan = null;
    render();
    row?.focus();
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
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if ($("settings").open) {
      $("settings").open = false;
      $("settings").querySelector("summary").focus();
    } else if (selectedSpan) $("inspector-close").click();
  });
  let resizeTimer = null;
  new (
    window.ResizeObserver ??
    class {
      observe() {}
    }
  )(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const trace = traces.find((item) => item.id === renderedTrace);
      if (trace) drawConnections(trace);
    }, 60);
  }).observe($("timing-field"));
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
