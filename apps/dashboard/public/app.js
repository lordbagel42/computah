/** @typedef {import("../../../packages/contracts/src/index.ts").OperatorSnapshot} OperatorSnapshot */
/** @typedef {import("../../../packages/contracts/src/index.ts").OperatorHistoryPage} OperatorHistoryPage */
/** @param {string} id */
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
const refreshButton = /** @type {HTMLButtonElement} */ ($("refresh"));
const moreButton = /** @type {HTMLButtonElement} */ ($("more"));
const loginForm = /** @type {HTMLFormElement} */ ($("login-form"));
const passwordField = /** @type {HTMLInputElement} */ ($("password"));
/** @type {OperatorSnapshot | undefined} */
let snapshot;
/** @type {string | undefined} */
let selectedTask;
/** @type {number | undefined} */
let loadingGeneration;
let generation = 0;
/** @type {Map<string, readonly string[]>} */
const workerLimitations = new Map();

/** @template {keyof HTMLElementTagNameMap} T
 * @param {T} tag @param {string} [text] @param {string} [className] */
function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
function notice(text = "", error = false) {
  $("notice").textContent = text;
  $("notice").classList.toggle("error", error);
}
function signedOut() {
  generation++;
  loadingGeneration = undefined;
  snapshot = undefined;
  selectedTask = undefined;
  workerLimitations.clear();
  $("dashboard").hidden = true;
  $("login").hidden = false;
  $("refresh").hidden = true;
  $("logout").hidden = true;
  for (const id of ["messages", "tasks", "worker-detail", "limitations"])
    $(id).replaceChildren();
  for (const id of [
    "scope",
    "interaction-id",
    "observed",
    "task-count",
    "worker-count",
    "mode",
  ])
    $(id).textContent = "";
  notice("Sign in to view this server-bound scope.");
}
/** @param {string} path @param {RequestInit} [options] */
async function api(path, options) {
  const currentGeneration = generation;
  const response = await fetch(path, {
    ...options,
    cache: "no-store",
    credentials: "same-origin",
  });
  if (response.status === 401) {
    if (generation === currentGeneration) signedOut();
    throw new Error("Sign in to view this server-bound scope.");
  }
  if (!response.ok) {
    /** @type {Record<number, string>} */
    const messages = {
      403: "Operator access is not granted for this core scope. Ask the operator to check the configured grant.",
      429: "Too many sign-in attempts. Wait 15 minutes before trying again.",
      502: "Core evidence is unavailable. Check the configured core connection, then refresh. Nothing was resubmitted.",
    };
    throw new Error(
      messages[response.status] ??
        "The request could not be completed. Try again.",
    );
  }
  return response.json();
}
/** @param {unknown} error */
function errorText(error) {
  return error instanceof Error
    ? error.message
    : "Evidence could not be read. Try refreshing.";
}
/** @param {string} value */
function date(value) {
  const time = new Date(value);
  return Number.isNaN(time.getTime())
    ? "Time unavailable"
    : time.toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      });
}
/** @param {HTMLElement} target @param {OperatorSnapshot["interaction"]["messages"]} messages @param {string} prefix @param {readonly string[]} [truncated] */
function renderMessages(target, messages, prefix, truncated = []) {
  target.replaceChildren();
  if (!messages.length) {
    target.append(
      node(
        "p",
        "No projected text in this history page. This does not establish that no other history exists.",
        "empty",
      ),
    );
    return;
  }
  for (const message of messages) {
    const article = node(
      "article",
      undefined,
      `message ${message.role === "user" ? "user" : "assistant"}`,
    );
    // Opaque public Message IDs make scope-local anchors, never permissions or actor selectors.
    article.id = `${prefix}-${message.id}`;
    article.tabIndex = -1;
    const meta = node("div", undefined, "message-meta");
    meta.append(node("span", message.role === "user" ? "User" : "Computah"));
    const link = node("a", date(message.createdAt));
    link.href = `#${encodeURIComponent(article.id)}`;
    link.setAttribute(
      "aria-label",
      `Link to ${message.role} message, ${date(message.createdAt)}`,
    );
    meta.append(link);
    article.append(meta);
    const text = message.blocks
      .filter((block) => block.kind === "text")
      .map((block) => block.text)
      .join("\n");
    article.append(node("p", text || "No displayable text.", "text"));
    if (truncated.includes(message.id))
      article.append(
        node(
          "p",
          "Text truncated by the safe projection. A later entry page will not recover the omitted suffix.",
          "note",
        ),
      );
    target.append(article);
  }
}
function renderWorker() {
  if (!snapshot) return;
  const target = $("worker-detail");
  target.replaceChildren();
  const task = snapshot.tasks.find((item) => item.id === selectedTask);
  const worker =
    task && snapshot.workers.find((item) => item.id === task.workerId);
  if (!task) {
    target.append(
      node(
        "p",
        "Select a recorded delegation to inspect its persistent Worker.",
        "empty",
      ),
    );
    return;
  }
  target.append(node("h3", task.workerLabel), node("code", task.workerId));
  target.append(
    node(
      "p",
      "Actor lifecycle and current execution status are not observed here.",
      "note",
    ),
  );
  target.append(node("h3", "Selected Task"), node("code", task.id));
  target.append(
    node("p", "Recorded in Interaction entry", "note"),
    node("code", task.entryId),
  );
  target.append(
    node(
      "p",
      task.status === "result-recorded"
        ? "A tool result is recorded. This is transcript evidence, not a live health check or proof of an external effect."
        : "A Task call is recorded. Completion has not been established by this page.",
      "note",
    ),
  );
  if (!worker || worker.availability === "missing") {
    target.append(
      node(
        "p",
        "Worker history unavailable. A recorded call is not proof that the Worker currently exists.",
        "empty",
      ),
    );
    return;
  }
  target.append(node("h3", "Persisted Worker text"));
  for (const text of workerLimitations.get(worker.id) ?? [])
    target.append(node("p", text, "note"));
  const messages = node("div", undefined, "messages");
  renderMessages(
    messages,
    worker.messages,
    "worker",
    worker.truncatedMessageIds,
  );
  target.append(messages);
  if (worker.nextCursor) {
    const more = node("button", "Read next Worker page");
    more.type = "button";
    more.addEventListener("click", async () => {
      const currentGeneration = generation;
      const requestSnapshot = snapshot;
      more.disabled = true;
      try {
        const page = /** @type {OperatorHistoryPage} */ (
          await api(
            `/api/history?cursor=${encodeURIComponent(worker.nextCursor ?? "")}`,
          )
        );
        if (
          currentGeneration !== generation ||
          !snapshot ||
          requestSnapshot !== snapshot
        )
          return;
        if (page.actorId !== worker.id)
          throw new Error("Actor evidence did not match. Refresh the view.");
        // Replace pages rather than imply a complete or atomic accumulated transcript.
        snapshot = {
          ...snapshot,
          workers: snapshot.workers.map((row) =>
            row.id === worker.id
              ? {
                  ...row,
                  messages: page.messages,
                  nextCursor: page.nextCursor,
                  availability: page.availability,
                  truncatedMessageIds: page.truncatedMessageIds,
                }
              : row,
          ),
        };
        workerLimitations.set(worker.id, page.limitations);
        renderWorker();
        notice(
          "Showing the next Worker history page; earlier pages are not displayed.",
        );
      } catch (error) {
        if (generation === currentGeneration) notice(errorText(error), true);
      } finally {
        more.disabled = false;
      }
    });
    target.append(more);
  }
}
function render() {
  if (!snapshot) return;
  $("login").hidden = true;
  $("dashboard").hidden = false;
  $("refresh").hidden = false;
  $("logout").hidden = false;
  $("scope").textContent =
    `${snapshot.viewer.displayName} · ${snapshot.viewer.tenantId} / ${snapshot.viewer.userId} / ${snapshot.viewer.agentId} · primary conversation`;
  $("observed").textContent =
    `Observed ${date(snapshot.observedAt)} · manual refresh`;
  $("mode").textContent =
    snapshot.mode === "real" ? "Real core" : "Faux model · not a live provider";
  $("interaction-id").textContent = snapshot.interaction.id;
  $("task-count").textContent =
    `${snapshot.tasks.length} recorded in this page`;
  $("worker-count").textContent =
    `${snapshot.workers.length} referenced in this page`;
  renderMessages(
    $("messages"),
    snapshot.interaction.messages,
    "message",
    snapshot.interaction.truncatedMessageIds,
  );
  if (snapshot.interaction.availability === "missing")
    $("messages").replaceChildren(
      node(
        "p",
        "No persistent Interaction exists for this scope yet. Opening this dashboard does not create one.",
        "empty",
      ),
    );
  $("more").hidden = !snapshot.interaction.nextCursor;
  const tasks = $("tasks");
  tasks.replaceChildren();
  if (!snapshot.tasks.length)
    tasks.append(
      node(
        "p",
        "No Task calls in this page. Other history pages may contain delegations.",
        "empty",
      ),
    );
  for (const task of snapshot.tasks) {
    const button = node("button", undefined, "task-row");
    button.type = "button";
    button.setAttribute("aria-pressed", String(task.id === selectedTask));
    button.append(
      node("strong", task.workerLabel),
      node(
        "span",
        task.status === "result-recorded" ? "Result recorded" : "Call recorded",
        "state",
      ),
      node("span", date(task.createdAt), "note"),
      node("code", task.id),
    );
    button.addEventListener("click", () => {
      selectedTask = task.id;
      for (const row of tasks.children)
        row.setAttribute("aria-pressed", String(row === button));
      renderWorker();
    });
    tasks.append(button);
  }
  $("limitations").replaceChildren(
    ...snapshot.limitations.map((text) => node("li", text)),
  );
  renderWorker();
  // Native/web callers may link a public Message ID only; no scope/token in the URL.
  if (location.hash.startsWith("#message-")) {
    try {
      const anchor = document.getElementById(
        decodeURIComponent(location.hash.slice(1)),
      );
      anchor?.scrollIntoView({ block: "center" });
    } catch {
      notice(
        "The message anchor is invalid. Browse this scope’s history instead.",
        true,
      );
    }
  }
}
/** @param {string | null} [cursor] */
async function load(cursor) {
  if (loadingGeneration === generation) return;
  const currentGeneration = generation;
  loadingGeneration = currentGeneration;
  refreshButton.disabled = true;
  moreButton.disabled = true;
  notice("Reading persisted actor evidence…");
  try {
    const result = /** @type {OperatorSnapshot} */ (
      await api(
        `/api/snapshot${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
      )
    );
    if (generation !== currentGeneration) return;
    snapshot = result;
    workerLimitations.clear();
    selectedTask = snapshot.tasks.some((task) => task.id === selectedTask)
      ? selectedTask
      : snapshot.tasks[0]?.id;
    render();
    notice(
      cursor
        ? "Showing the next Interaction history page. Delegations and Workers reflect this page only."
        : "",
    );
  } catch (error) {
    if (generation !== currentGeneration) return;
    $("refresh").hidden = false;
    $("logout").hidden = false;
    if (snapshot)
      notice(
        `Refresh failed. Evidence below is stale. ${errorText(error)}`,
        true,
      );
    else notice(errorText(error), true);
  } finally {
    if (loadingGeneration === currentGeneration) loadingGeneration = undefined;
    if (generation === currentGeneration) {
      refreshButton.disabled = false;
      moreButton.disabled = false;
    }
  }
}
loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = /** @type {HTMLButtonElement} */ (event.submitter);
  button.disabled = true;
  try {
    await api("/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: passwordField.value }),
    });
    generation++;
    passwordField.value = "";
    await load();
  } catch (error) {
    notice(errorText(error), true);
  } finally {
    button.disabled = false;
  }
});
$("refresh").addEventListener("click", () => load());
$("more").addEventListener("click", () =>
  load(snapshot?.interaction.nextCursor),
);
$("logout").addEventListener("click", async () => {
  signedOut();
  const currentGeneration = generation;
  const loginButton = /** @type {HTMLButtonElement} */ (
    loginForm.querySelector("button")
  );
  loginButton.disabled = true;
  notice("Private evidence cleared. Signing out…");
  try {
    await api("/logout", { method: "POST" });
    if (currentGeneration !== generation) return;
    notice("Signed out. Private evidence has been cleared from this page.");
  } catch {
    if (currentGeneration !== generation) return;
    notice(
      "Private evidence cleared locally. Session sign-out could not be confirmed; close this browser and retry.",
      true,
    );
  } finally {
    loginButton.disabled = false;
  }
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) {
    signedOut();
    load();
  }
});
load();
