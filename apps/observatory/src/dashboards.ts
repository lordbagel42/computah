/** Public recreations of the five Axiom dashboards inspected on 2026-11-09.
 * Queries are source-controlled, never accepted from the browser. Private evidence
 * slots remain visible with an explanation rather than being silently replaced.
 */
export const SERVICES = [
  "computah-backend",
  "computah-slack",
  "computah-bus",
  "computah-dashboard",
  "computah-native",
  "computah-rune-pi",
  "computah-observatory",
  "computah-setup",
];
export const MODELS = [
  "gpt-6.1-terra",
  "gpt-6.1-sol",
  "openai-codex/gpt-6.1-terra",
  "openai-codex/gpt-6.1-sol",
];
export const PROVIDERS = ["openai", "openai-codex", "anthropic", "google"];
export const AGENTS = ["runtime", "interaction", "worker", "pi"];
export const TOOLS = [
  "Task",
  "Worker",
  "web_search",
  "web_extract",
  "browser",
  "read",
  "write",
  "edit",
  "bash",
  "browser_read",
  "self_docs_discover",
  "self_docs_read",
  "operations_discover",
  "message_timing",
  "procedure_draft",
];
export const OUTCOMES = [
  "success",
  "ok",
  "ready",
  "error",
  "failed",
  "failure",
  "faulted",
  "denied",
  "cancelled",
  "cancel",
  "timeout",
  "retry",
  "uncertain",
  "active",
  "stopped",
  "not_configured",
  "unspecified",
];
export type Panel = {
  id: string;
  title: string;
  kind: "stat" | "series" | "table" | "private";
  source: "traces" | "logs";
  base:
    | "app"
    | "logs"
    | "usage"
    | "otel"
    | "genai"
    | "cost"
    | "context"
    | "turns";
  query: string;
  columns: string[];
  note?: string;
};
export type Dashboard = {
  id: string;
  uid: string;
  title: string;
  description: string;
  window: string;
  panels: Panel[];
  filters: string[];
};
function panel(
  id: string,
  title: string,
  kind: Panel["kind"],
  base: Panel["base"],
  query: string,
  columns: string,
  note?: string,
): Panel {
  return {
    id,
    title,
    kind,
    base,
    source: base === "logs" || base === "usage" ? "logs" : "traces",
    query,
    columns: columns.split(","),
    ...(note ? { note } : {}),
  };
}
function privatePanel(id: string, title: string, note: string): Panel {
  return panel(id, title, "private", "app", "", "", note);
}
const errors =
  "error == true or Status in ('Error','ERROR') or Outcome in ('error','failed','failure','faulted','timeout')";
export const DASHBOARDS: Dashboard[] = [
  {
    id: "turns",
    uid: "query-diUP7Q0H3ks-to6i5y",
    title: "Message turns",
    window: "24h",
    filters: [],
    description:
      "Recreated from the linked Axiom query. Each row is an observed trace containing root Slack receive + job spans, with no DEBUGSHARE capture. Reply labels are historical delivery-span proxies, not the actual-answer deadline detector or proof of complete causal linkage. Rolling selected window replaces the original fixed Nov 7–8 investigation. Click an opaque trace key to inspect its retained public stream rows; missing/out-of-window spans stay missing.",
    panels: [
      panel(
        "turns",
        "Computah message turns",
        "table",
        "turns",
        "| summarize _time=min(_time),last_span=max(_time),spans=count(),ingress=countif(name == 'computah.slack.receive' and isempty(parent_span_id)),jobs=countif(name == 'computah.slack.job'),control_only=countif(name == 'computah.debugshare.capture'),replies=countif(name == 'computah.slack.delivery' and tostring(['attributes.custom']['outcome']) == 'success'),delivery_failures=countif(name == 'computah.slack.delivery' and tostring(['attributes.custom']['outcome']) != 'success'),errors=countif(error == true or ['status.code'] =~ 'error') by trace_id | where ingress > 0 and jobs > 0 and control_only == 0 | extend reply_state=case(replies > 0,'reply delivered',delivery_failures > 0,'delivery failed','no successful reply observed') | order by _time desc",
        "_time,trace_id,reply_state,spans,errors,replies,delivery_failures,last_span",
      ),
    ],
  },
  {
    id: "dash",
    uid: "saved-LnGfaFXUkbHU8aH30t",
    title: "dash",
    window: "30m",
    filters: [],
    description:
      "The actual saved live stream: name != computah.logs.export (case-insensitive). Original columns are name, duration and trace_id. This public recreation uses the existing sanitized SSE timing/topology stream: newest 1,000 retained spans / 15 minutes, with opaque trace keys, approved names and explicit truncation. It is not a lossless archive. Parent relationships are declared, never inferred.",
    panels: [],
  },
  {
    id: "health",
    uid: "computah-health",
    title: "Health & errors",
    window: "24h",
    filters: ["service", "revision"],
    description:
      "Observed production telemetry, not an availability SLO. Spans are deduplicated by trace/span ID; logs by log ID. Nested spans are not user requests. HTTP durations include long polls. Empty windows are not proof of health.",
    panels: [
      panel(
        "spans",
        "Observed app spans",
        "stat",
        "app",
        "| summarize Spans=count()",
        "Spans",
      ),
      panel(
        "errors",
        "Recorded error spans",
        "stat",
        "app",
        `| where ${errors} | summarize Error_spans=count()`,
        "Error_spans",
      ),
      panel(
        "http-count",
        "Observed HTTP spans",
        "stat",
        "app",
        "| where Operation == 'computah.http' | summarize HTTP_spans=count()",
        "HTTP_spans",
      ),
      panel(
        "http-p95",
        "HTTP p95 duration · ms",
        "stat",
        "app",
        "| where Operation == 'computah.http' | summarize P95_ms=percentile(duration / 1ms,95)",
        "P95_ms",
      ),
      panel(
        "http",
        "HTTP duration by service · ms (long polls included)",
        "table",
        "app",
        "| where Operation == 'computah.http' | summarize Samples=count(), P50_ms=percentile(duration / 1ms,50), P95_ms=percentile(duration / 1ms,95), P99_ms=percentile(duration / 1ms,99) by Service | sort by P95_ms desc",
        "Service,Samples,P50_ms,P95_ms,P99_ms",
      ),
      panel(
        "failure-categories",
        "Recorded non-success log outcomes",
        "table",
        "logs",
        "| where Event in ('operation.completed','http.completed','model.completed') and Outcome in ('error','failed','faulted','denied','cancelled','timeout') | summarize Log_events=count() by Outcome | sort by Log_events desc",
        "Outcome,Log_events",
      ),
      panel(
        "traffic",
        "Observed app spans by service · count/bin",
        "series",
        "app",
        "| summarize Spans=count() by bin_auto(_time), Service",
        "_time,Service,Spans",
      ),
      panel(
        "outcomes",
        "Recorded structured operation outcomes · events",
        "table",
        "logs",
        "| where Event in ('operation.completed','http.completed','model.completed') | summarize Events=count() by Service, Operation, Outcome | sort by Events desc | limit 50",
        "Service,Operation,Outcome,Events",
      ),
      panel(
        "freshness",
        "Latest app span per service/revision · UTC",
        "table",
        "app",
        "| summarize Last_span_UTC=max(_time), Observed_spans=count() by Service, Revision | sort by Last_span_UTC desc | limit 25",
        "Service,Revision,Last_span_UTC,Observed_spans",
      ),
      privatePanel(
        "error-evidence",
        "Latest error/denial/cancel spans",
        "Exact native trace drilldowns remain authenticated. Public timing and declared relationships are available on the trace horizon; raw trace/span IDs are not published.",
      ),
      privatePanel(
        "log-evidence",
        "Latest failure/retry logs",
        "Exact log records and their correlation links remain authenticated. The outcome aggregates above are public; raw log content and identities are not.",
      ),
    ],
  },
  {
    id: "delivery",
    uid: "computah-delivery-execution",
    title: "Slack & agent execution",
    window: "24h",
    filters: ["service", "revision"],
    description:
      "Separate observed populations, not a delivery funnel. These are attempts and markers, not unique conversations or logical Tasks. Queue-span duration is not backlog. Independent roots and partial propagation prevent a complete Slack → Task → Worker join.",
    panels: [
      panel(
        "slack-jobs",
        "Slack job spans",
        "stat",
        "app",
        "| where Service == 'computah-slack' and Operation == 'computah.slack.job' | summarize Job_spans=count()",
        "Job_spans",
      ),
      panel(
        "delivery-attempts",
        "Delivery attempt spans",
        "stat",
        "app",
        "| where Service == 'computah-slack' and Operation == 'computah.slack.delivery' | summarize Attempt_spans=count()",
        "Attempt_spans",
      ),
      panel(
        "task-calls",
        "Native Task call phases",
        "stat",
        "app",
        "| where Operation == 'pi.durable.phase' and Phase == 'call' and Tool == 'Task' | summarize Call_phases=count()",
        "Call_phases",
      ),
      panel(
        "worker-markers",
        "Worker root markers",
        "stat",
        "app",
        "| where Operation == 'worker/harness.root' | summarize Root_markers=count()",
        "Root_markers",
      ),
      panel(
        "slack-phases",
        "Slack named phases · observed attempts and duration ms",
        "table",
        "app",
        "| where Service == 'computah-slack' and Operation startswith_cs 'computah.slack.' and Operation != 'computah.slack.step' | summarize Attempts=count(), Error_flags=countif(error == true), P50_ms=percentile(duration / 1ms,50), P95_ms=percentile(duration / 1ms,95) by Operation, Outcome | sort by Operation asc | limit 50",
        "Operation,Outcome,Attempts,Error_flags,P50_ms,P95_ms",
      ),
      panel(
        "slack-queue",
        "Observed Slack queue span duration · ms, not backlog",
        "table",
        "app",
        "| where Service == 'computah-slack' and Operation == 'computah.slack.queue' | summarize Samples=count(), P50_ms=percentile(duration / 1ms,50), P95_ms=percentile(duration / 1ms,95), Max_ms=max(duration / 1ms) by Outcome",
        "Outcome,Samples,P50_ms,P95_ms,Max_ms",
      ),
      panel(
        "slack-volume",
        "Slack receive/job/delivery spans · attempts/bin, not funnel",
        "series",
        "app",
        "| where Service == 'computah-slack' and Operation in ('computah.slack.receive','computah.slack.job','computah.slack.delivery','computah.slack.retry') | summarize Attempts=count() by bin_auto(_time), Operation",
        "_time,Operation,Attempts",
      ),
      panel(
        "native-tools",
        "Native tool call phases incl. Task · observed span attempts",
        "table",
        "app",
        "| where Operation == 'pi.durable.phase' and Phase == 'call' and isnotempty(Tool) | summarize Call_phases=count(), Error_flags=countif(error == true), P95_ms=percentile(duration / 1ms,95) by Tool, Outcome | sort by Call_phases desc | limit 30",
        "Tool,Outcome,Call_phases,Error_flags,P95_ms",
      ),
      panel(
        "worker-roots",
        "Interaction/Worker harness & admission · observed spans",
        "table",
        "app",
        "| where Operation in ('interaction/harness.root','worker/harness.root','interaction/admit','worker/admit','worker/submission.wait') | summarize Observed_spans=count(), P95_ms=percentile(duration / 1ms,95), Error_flags=countif(error == true) by Operation | sort by Operation asc",
        "Operation,Observed_spans,P95_ms,Error_flags",
      ),
      panel(
        "named-tools",
        "Named tool operations · observed spans and ms",
        "table",
        "app",
        "| where Operation startswith_cs 'computah.self_docs.' or Operation startswith_cs 'computah.web.' or Operation startswith_cs 'computah.axiom.' or Operation startswith_cs 'computah.operations.' or Operation startswith_cs 'computah.sentinel.' | summarize Spans=count(), P95_ms=percentile(duration / 1ms,95) by Operation, Outcome | sort by Spans desc | limit 30",
        "Operation,Outcome,Spans,P95_ms",
      ),
      privatePanel(
        "slack-log",
        "Slack retry/failure/delivery records",
        "Per-delivery log evidence, attempt receipts and exact native drilldowns remain authenticated; public phase/attempt aggregates are above.",
      ),
      privatePanel(
        "execution-evidence",
        "Latest Slack/Task/Worker evidence",
        "Raw correlation keys and exact native traces remain authenticated. Use the public trace horizon for sanitized timing/topology, not conversation identity.",
      ),
    ],
  },
  {
    id: "models",
    uid: "computah-model-usage",
    title: "Model usage & cost estimates",
    window: "24h",
    filters: ["service", "revision", "model"],
    description:
      "Terminal analytics.sample observations, deduplicated by log ID: logical runtime calls, not provider HTTP attempts. SDK-reported tokens; reasoning is a subset of output. Missing usage/cost stays unknown. USD base-catalog estimates exclude tier/account adjustments, discounts and subscription allocation—not invoice spend. Rates: pi-ai@1.5.0/runtime-model.",
    panels: [
      panel(
        "model-requests",
        "Terminal logical calls",
        "stat",
        "usage",
        "| summarize Calls=sum(Requests)",
        "Calls",
      ),
      panel(
        "model-tokens",
        "Measured tokens",
        "stat",
        "usage",
        "| where isnotnull(Tokens) | summarize Measured=count(), Total=sum(Tokens) | project Tokens=iff(Measured > 0, Total, real(null))",
        "Tokens",
      ),
      panel(
        "model-estimate",
        "Base estimate · USD",
        "stat",
        "usage",
        "| where isnotnull(Estimate_USD) and Currency == 'USD' | summarize Estimated=count(), Total=sum(Estimate_USD) | project Estimate_USD=iff(Estimated > 0, Total, real(null))",
        "Estimate_USD",
      ),
      panel(
        "usage-coverage",
        "Terminal usage coverage · %",
        "stat",
        "usage",
        "| summarize Terminal=count(), Known=countif(isnotnull(Tokens)) | project Coverage_pct=iff(Terminal > 0, 100.0 * Known / Terminal, real(null))",
        "Coverage_pct",
      ),
      panel(
        "model-volume",
        "Logical model calls by model · calls/bin",
        "series",
        "usage",
        "| summarize Calls=sum(Requests) by bin_auto(_time), Model",
        "_time,Model,Calls",
      ),
      panel(
        "model-cost-series",
        "Base-catalog estimates by model · USD/bin, NOT billing",
        "series",
        "usage",
        "| where isnotnull(Estimate_USD) and Currency == 'USD' | summarize Estimate_USD=sum(Estimate_USD) by bin_auto(_time), Model",
        "_time,Model,Estimate_USD",
      ),
      panel(
        "model-coverage",
        "Usage & estimate coverage · observed terminal records",
        "table",
        "usage",
        "| summarize Terminal_records=count(), Logical_calls=sum(Requests), Usage_known=countif(isnotnull(Tokens)), Usage_unknown=countif(isnull(Tokens)), Estimate_known=countif(isnotnull(Estimate_USD)), Estimate_unknown=countif(isnull(Estimate_USD)) by Model, Outcome | sort by Terminal_records desc",
        "Model,Outcome,Terminal_records,Logical_calls,Usage_known,Usage_unknown,Estimate_known,Estimate_unknown",
      ),
      panel(
        "model-breakdown",
        "Measured tokens & runtime duration · tokens and ms",
        "table",
        "usage",
        "| summarize Records=count(), Usage_known=countif(isnotnull(Tokens)), Total_tokens=sum(Tokens), Uncached_input=sum(Input), Output_tokens=sum(Output), Cache_read=sum(CacheRead), Cache_write=sum(CacheWrite), Reasoning_subset=sum(Reasoning), Reasoning_known=countif(isnotnull(Reasoning)), P50_ms=percentile(Duration_ms,50), P95_ms=percentile(Duration_ms,95) by Model, Provider, Outcome | sort by Total_tokens desc",
        "Model,Provider,Outcome,Records,Usage_known,Total_tokens,Uncached_input,Output_tokens,Cache_read,Cache_write,Reasoning_subset,Reasoning_known,P50_ms,P95_ms",
      ),
      panel(
        "model-provenance",
        "Estimate provenance & coverage · selected USD/Mtoken rates",
        "table",
        "usage",
        "| summarize Records=count(), Estimate_known=countif(isnotnull(Estimate_USD)), Observed_estimate_USD=sum(Estimate_USD) by Model, Currency, Basis, RateVersion, InputRate, OutputRate, CacheReadRate, CacheWriteRate, CacheWrite1hRate, Revision | sort by Observed_estimate_USD desc | limit 30",
        "Model,Currency,Basis,RateVersion,Revision,Records,Estimate_known,Observed_estimate_USD,InputRate,OutputRate,CacheReadRate,CacheWriteRate,CacheWrite1hRate",
      ),
      privatePanel(
        "model-evidence",
        "Terminal model receipts",
        "Individual analytics receipts and native log/trace links remain authenticated. All aggregate usage, coverage and numeric rate provenance panels are recreated above.",
      ),
    ],
  },
  {
    id: "traces",
    uid: "otel.traces.computah-prod-traces",
    title: "OpenTelemetry Traces",
    window: "30m",
    filters: ["service", "operation", "status"],
    description:
      "The native integration's observed trace/span populations, including nested and exporter spans. Statistics retain native time-bin semantics: distinct trace counts per bin must not be summed into a unique-window total. Non-error does not mean confirmed success. Public service → operation filtering replaces native authenticated drilldowns.",
    panels: [
      panel(
        "total-traces",
        "Total traces · distinct/bin",
        "series",
        "otel",
        "| summarize Traces=dcount(trace_id) by bin_auto(_time)",
        "_time,Traces",
      ),
      panel(
        "incoming-spans",
        "Incoming spans · /min",
        "series",
        "otel",
        "| summarize Spans_per_minute=rate(60) by bin_auto(_time)",
        "_time,Spans_per_minute",
      ),
      panel(
        "avg-span-duration",
        "Avg span duration · ms/bin",
        "series",
        "otel",
        "| summarize Average_ms=avg(duration / 1ms) by bin_auto(_time)",
        "_time,Average_ms",
      ),
      panel(
        "errors",
        "Errors · count/bin",
        "series",
        "otel",
        "| where spanError | summarize Errors=count() by bin_auto(_time)",
        "_time,Errors",
      ),
      panel(
        "slowest-operations",
        "Slowest Operations · ms",
        "table",
        "otel",
        "| summarize Average_ms=avg(duration / 1ms), P95_ms=percentile(duration / 1ms,95), P99_ms=percentile(duration / 1ms,99), P999_ms=percentile(duration / 1ms,99.9) by Service, Operation | sort by Average_ms desc | limit 20",
        "Service,Operation,Average_ms,P95_ms,P99_ms,P999_ms",
      ),
      privatePanel(
        "top-errors",
        "Top 10 Span Errors",
        "The native panel groups full status.message text, which may contain private content. It cannot be faithfully published. Error counts and operation timings remain public; exact messages stay in Axiom.",
      ),
      panel(
        "results",
        "Results · services and operations",
        "table",
        "otel",
        "| summarize Spans=count(), Average_ms=avg(duration / 1ms), Errors=countif(spanError) by Service, Operation | sort by Service asc, Operation asc",
        "Service,Operation,Spans,Average_ms,Errors",
        "Select a service, then an operation above. Exact native trace-ID search remains authenticated; the public horizon carries opaque timing/topology only.",
      ),
      privatePanel(
        "spans",
        "Spans",
        "The original span table includes raw trace/span IDs and private native URLs. Those remain authenticated. Open the public trace horizon for the independently sanitized, bounded operation tree.",
      ),
    ],
  },
  {
    id: "generative-ai",
    uid: "genai.computah-prod-traces",
    title: "Generative AI Overview",
    window: "30m",
    filters: ["provider", "model", "agent", "tool"],
    description:
      "Native GenAI trace integration, separate from terminal logical-call analytics. Charts retain their source populations (including different nonempty/non-null predicates), not a merged usage total. Costs use Axiom modeldb catalog lookup and long-context/cache rules, not the runtime rate card or an invoice. Agent/tool labels are allowlisted; other labels are grouped as other. Error-text and argument/result searches remain authenticated.",
    panels: [
      panel(
        "requests",
        "Total requests · count/bin",
        "series",
        "genai",
        "| where isnotempty(GenOperation) | summarize Requests=count() by bin_auto(_time)",
        "_time,Requests",
      ),
      panel(
        "successful",
        "Successful requests · native non-ERROR/bin",
        "series",
        "genai",
        "| where isnotempty(GenOperation) | summarize Non_error=countif(Status != 'ERROR') by bin_auto(_time)",
        "_time,Non_error",
        "Native definition: status != ERROR, including unset; not proof of a delivered answer.",
      ),
      panel(
        "errored",
        "Errored requests · count/bin",
        "series",
        "genai",
        "| where isnotempty(GenOperation) | summarize Errors=countif(Status == 'ERROR') by bin_auto(_time)",
        "_time,Errors",
      ),
      panel(
        "duration",
        "Average duration · ms/bin",
        "series",
        "genai",
        "| where isnotempty(GenOperation) | summarize Average_ms=avg(duration / 1ms) by bin_auto(_time)",
        "_time,Average_ms",
      ),
      panel(
        "input-tokens",
        "Total input tokens · tokens/bin",
        "series",
        "genai",
        "| summarize Input_tokens=sum(input_tokens) by bin_auto(_time)",
        "_time,Input_tokens",
      ),
      panel(
        "output-tokens",
        "Total output tokens · GenAI operation rows/bin",
        "series",
        "genai",
        "| where isnotnull(GenOperation) | summarize Output_tokens=sum(output_tokens) by bin_auto(_time)",
        "_time,Output_tokens",
      ),
      panel(
        "vitals",
        "Vitals · operation and agent",
        "table",
        "cost",
        "| where isnotnull(GenOperation) | summarize Requests=count(), Average_ms=avg(duration / 1ms), Longest_ms=max(duration / 1ms), Input_tokens=sum(input_tokens), Output_tokens=sum(output_tokens), Cost_USD=sum(total_cost), Rated=countif(isnotnull(total_cost)) by GenOperation, Agent | limit 50",
        "GenOperation,Agent,Requests,Average_ms,Longest_ms,Input_tokens,Output_tokens,Cost_USD,Rated",
      ),
      panel(
        "error-timeline",
        "Error timeline · count/bin",
        "series",
        "genai",
        "| where isnotnull(GenOperation) and Status == 'ERROR' | summarize Errors=count() by bin_auto(_time), Agent",
        "_time,Agent,Errors",
      ),
      privatePanel(
        "latest-errors",
        "Latest errored spans",
        "The native panel returns full records, including messages/attributes. It remains authenticated; aggregate error timelines are public. Full-text error search is not a public query interface.",
      ),
      panel(
        "total-cost",
        "Total cost · catalog USD/bin",
        "series",
        "cost",
        "| where isnotnull(GenOperation) | summarize Cost_USD=sum(total_cost), Rated=countif(isnotnull(total_cost)) by bin_auto(_time) | extend Cost_USD=iff(Rated > 0,Cost_USD,real(null))",
        "_time,Cost_USD,Rated",
      ),
      panel(
        "total-tokens",
        "Total tokens · tokens/bin",
        "series",
        "genai",
        "| summarize Tokens=sum(input_tokens + output_tokens) by bin_auto(_time)",
        "_time,Tokens",
      ),
      panel(
        "expensive-generations",
        "Top 10 most expensive generations",
        "table",
        "cost",
        "| where isnotempty(Model) | summarize Cost_USD=max(total_cost) by bin_auto(_time), Agent, Model | limit 10",
        "_time,Agent,Model,Cost_USD",
        "Native query selects per-bin/agent/model maxima then limits 10; not a globally ranked top ten. Raw trace IDs removed.",
      ),
      panel(
        "input-tokens-all",
        "Total Input tokens · tokens/bin",
        "series",
        "genai",
        "| summarize Input_tokens=sum(input_tokens) by bin_auto(_time)",
        "_time,Input_tokens",
      ),
      panel(
        "input-cost",
        "Total input cost · catalog USD/bin",
        "series",
        "cost",
        "| summarize Input_cost_USD=sum(input_cost), Rated=countif(isnotnull(input_cost)) by bin_auto(_time) | extend Input_cost_USD=iff(Rated > 0,Input_cost_USD,real(null))",
        "_time,Input_cost_USD,Rated",
      ),
      panel(
        "expensive-inputs",
        "Top 10 most expensive inputs",
        "table",
        "cost",
        "| where isnotempty(Model) | summarize Input_cost_USD=max(input_cost) by bin_auto(_time), Agent, Model | limit 10",
        "_time,Agent,Model,Input_cost_USD",
        "Per-bin maxima as in the native query; raw trace IDs removed.",
      ),
      panel(
        "output-tokens-all",
        "Total output tokens · tokens/bin",
        "series",
        "genai",
        "| summarize Output_tokens=sum(output_tokens) by bin_auto(_time)",
        "_time,Output_tokens",
      ),
      panel(
        "output-cost",
        "Total output cost · catalog USD/bin",
        "series",
        "cost",
        "| summarize Output_cost_USD=sum(output_cost), Rated=countif(isnotnull(output_cost)) by bin_auto(_time) | extend Output_cost_USD=iff(Rated > 0,Output_cost_USD,real(null))",
        "_time,Output_cost_USD,Rated",
      ),
      panel(
        "expensive-outputs",
        "Top 10 most expensive outputs",
        "table",
        "cost",
        "| where isnotempty(Model) | summarize Output_cost_USD=max(output_cost) by bin_auto(_time), Agent, Model | limit 10",
        "_time,Agent,Model,Output_cost_USD",
        "Per-bin maxima as in the native query; raw trace IDs removed.",
      ),
      panel(
        "reliability",
        "Model reliability",
        "series",
        "genai",
        "| where isnotnull(RequestModel) | summarize Requests=count(), Errors=countif(Status == 'ERROR') by bin_auto(_time), Model, Agent | extend Error_pct=100.0 * Errors / Requests | limit 50",
        "_time,Model,Agent,Requests,Errors,Error_pct",
      ),
      panel(
        "performance",
        "Model performance · ms and tokens/s",
        "series",
        "genai",
        "| where isnotnull(RequestModel) | summarize P50_ms=percentile(duration / 1ms,50), P90_ms=percentile(duration / 1ms,90), P95_ms=percentile(duration / 1ms,95), Tokens_per_second=round(avg(output_tokens / max_of(toint(duration/1s),1)),2) by bin_auto(_time), Model, Agent | limit 50",
        "_time,Model,Agent,P50_ms,P90_ms,P95_ms,Tokens_per_second",
      ),
      panel(
        "input-context",
        "Model input context · tokens and %",
        "table",
        "context",
        "| summarize P50_tokens=percentile(input_tokens,50), P90_tokens=percentile(input_tokens,90), P95_tokens=percentile(input_tokens,95), Context_pct=histogram(round(input_tokens / max_input_tokens * 100,2),20) by bin_auto(_time), Model, Agent | limit 50",
        "_time,Model,Agent,P50_tokens,P90_tokens,P95_tokens,Context_pct",
      ),
      panel(
        "output-context",
        "Model output context · tokens and %",
        "table",
        "context",
        "| summarize P50_tokens=percentile(output_tokens,50), P90_tokens=percentile(output_tokens,90), P95_tokens=percentile(output_tokens,95), Context_pct=histogram(round(output_tokens / max_output_tokens * 100,2),20) by bin_auto(_time), Model, Agent | limit 50",
        "_time,Model,Agent,P50_tokens,P90_tokens,P95_tokens,Context_pct",
      ),
      privatePanel(
        "tool-spans",
        "Tool spans",
        "The native table explicitly includes Tool arguments and Tool message/results. These private payloads and their content search stay authenticated. The tool-performance aggregate is public.",
      ),
      panel(
        "tool-performance",
        "Tool performance · attempts and ms",
        "series",
        "genai",
        "| where isnotempty(Tool) | summarize Calls=count(), Errors=countif(Status == 'ERROR'), P50_ms=percentile(duration / 1ms,50), P95_ms=percentile(duration / 1ms,95), P99_ms=percentile(duration / 1ms,99) by bin_auto(_time), Tool, Model",
        "_time,Tool,Model,Calls,Errors,P50_ms,P95_ms,P99_ms",
      ),
    ],
  },
];

export type Filters = Record<
  | "window"
  | "service"
  | "revision"
  | "model"
  | "provider"
  | "agent"
  | "tool"
  | "operation"
  | "status",
  string
>;
export function parseDashboard(
  url: URL,
): { dashboard: Dashboard; filters: Filters } | null {
  const dashboard = DASHBOARDS.find(
    (d) => url.pathname === `/api/dashboards/${d.id}`,
  );
  if (!dashboard) return null;
  const filters: Filters = {
    window: dashboard.window,
    service: "",
    revision: "",
    model: "",
    provider: "",
    agent: "",
    tool: "",
    operation: "",
    status: "",
  };
  for (const [key, value] of url.searchParams) {
    if (
      !Object.hasOwn(filters, key) ||
      url.searchParams.getAll(key).length !== 1 ||
      (key !== "window" && !dashboard.filters.includes(key))
    )
      return null;
    filters[key as keyof Filters] = value;
  }
  if (
    !["30m", "1h", "24h"].includes(filters.window) ||
    !/^([a-f0-9]{1,40})?$/.test(filters.revision)
  )
    return null;
  for (const [key, choices] of Object.entries({
    service: SERVICES,
    model: MODELS,
    provider: PROVIDERS,
    agent: AGENTS,
    tool: TOOLS,
    status: ["error", "success"],
  })) {
    if (
      filters[key as keyof Filters] &&
      !choices.includes(filters[key as keyof Filters])
    )
      return null;
  }
  if (filters.operation && !PUBLIC_OPERATIONS.includes(filters.operation))
    return null;
  return { dashboard, filters };
}

export const PUBLIC_OPERATIONS = [
  "computah.http",
  "computah.submit",
  "computah.result",
  "computah.wait",
  "computah.cancel",
  "computah.model",
  "computah.logs.export",
  "computah.synthetic",
  "computah.ready",
  "computah.stopped",
  "computah.web.search",
  "computah.web.extract",
  "computah.axiom.query",
  "computah.self_docs.read",
  "computah.self_docs.search",
  "computah.operations.read",
  "computah.sentinel.check",
  ...["discover", "query", "timing"].map((v) => `computah.operations.${v}`),
  "computah.self_docs.discover",
  ...["review", "enforce", "cancel"].map((v) => `computah.sentinel.${v}`),
  ...["read", "write", "edit"].map((v) => `computah.files.${v}`),
  ...["agentos", "read", "cleanup"].map((v) => `computah.browser.${v}`),
  ...[
    "pump",
    "stream.create",
    "stream.append",
    "replay",
    "admit",
    "receipt",
    "dispatch",
  ].map((v) => `computah.bus.${v}`),
  ...[
    "receive",
    "step",
    "api",
    "core",
    "job",
    "admit",
    "ack",
    "queue",
    "prepare",
    "submit",
    "wait",
    "delivery",
    "retry",
    "status",
    "recover",
    "finish",
    "finalize",
    "timing",
    "upload",
  ].map((v) => `computah.slack.${v}`),
  ...[
    "submit",
    "phase",
    "entry",
    "submission",
    "report",
    "checkpoint",
    "replay",
  ].map((v) => `pi.durable.${v}`),
  ...["interaction", "worker"].flatMap((v) =>
    [
      "admit",
      "awaitCancellation",
      "sleep",
      "harness.root",
      "harness.submission",
      "submission.wait",
      "submission.status",
      "conversation.entries",
      "conversation.configure",
      "pi.wake",
    ].map((name) => `${v}/${name}`),
  ),
  "chat gpt-6.1-terra",
  "chat gpt-6.1-sol",
  "invoke_agent pi",
];
const list = (values: string[]) => values.map((v) => `'${v}'`).join(",");
const safeDimension = (name: string, expression: string, values: string[]) =>
  `${name}=iff(tostring(${expression}) in (${list(values)}),tostring(${expression}),'other')`;
const safeService = safeDimension("Service", "['service.name']", SERVICES);
const safeOperation = safeDimension("Operation", "name", PUBLIC_OPERATIONS);
const safeOutcome = safeDimension("Outcome", "Outcome", OUTCOMES);
const safeTool = `Tool=iff(isempty(Tool),'',iff(Tool in (${list(TOOLS)}),Tool,'other'))`;
const safeModel = safeDimension("Model", "Model", MODELS);
const safeProvider = safeDimension("Provider", "Provider", PROVIDERS);

/** Original population/dedup rules precede public grouping. Only approved fixed
 * dimensions survive; unknown labels collapse before aggregating, not afterwards.
 */
export function dashboardQuery(panel: Panel, filters: Filters): string {
  const common = `| where isempty('${filters.service}') or ['service.name'] == '${filters.service}'
| where isempty('${filters.revision}') or ['service.version'] startswith_cs '${filters.revision}'`;
  let base: string;
  if (panel.base === "turns") {
    base = "['computah-prod-traces']";
  } else if (panel.base === "app") {
    base = `['computah-prod-traces'] ${common}
| where name !in ('computah.logs.export','computah.synthetic') and ['service.name'] != 'computah-setup'
| where isnotempty(trace_id) and isnotempty(span_id)
| project _time,trace_id,span_id,Service=['service.name'],Revision=['service.version'],Operation=name,duration,error,Status=['status.code'],Outcome=tostring(['attributes.custom']['outcome']),Phase=tostring(['attributes.custom']['phase']),Tool=tostring(['attributes.custom']['tool.name'])
| summarize arg_max(_time,Service,Revision,Operation,duration,error,Status,Outcome,Phase,Tool) by trace_id,span_id`;
  } else if (panel.base === "logs") {
    base = `['computah-prod-logs'] ${common}
| where isnotempty(['attributes.log.id'])
| project _time,Id=['attributes.log.id'],Service=['service.name'],Revision=['service.version'],Event=body,Operation=['attributes.operation'],Outcome=['attributes.outcome'],Severity=severity
| summarize arg_max(_time,Service,Revision,Event,Operation,Outcome,Severity) by Id`;
  } else if (panel.base === "usage") {
    base = `['computah-prod-logs']
| where body == 'analytics.sample' and isnotnull(['attributes.analytics.model.requests']) ${common}
| where isempty('${filters.model}') or ['attributes.analytics.model'] contains_cs '${filters.model}'
| where isnotempty(['attributes.log.id'])
| project _time,Id=['attributes.log.id'],Revision=['service.version'],Model=['attributes.analytics.model'],Provider=['attributes.analytics.provider'],Outcome=['attributes.analytics.outcome'],Requests=['attributes.analytics.model.requests'],Duration_ms=['attributes.analytics.model.duration'],Tokens=['attributes.analytics.model.tokens.total'],Input=['attributes.analytics.model.tokens.input'],Output=['attributes.analytics.model.tokens.output'],CacheRead=['attributes.analytics.model.tokens.cache_read'],CacheWrite=['attributes.analytics.model.tokens.cache_write'],Reasoning=['attributes.analytics.model.tokens.reasoning'],Estimate_USD=['attributes.analytics.model.cost.estimated'],Basis=['attributes.analytics.cost.estimated.basis'],Currency=['attributes.analytics.currency'],RateVersion=['attributes.analytics.rate.version'],InputRate=['attributes.analytics.rate.input'],OutputRate=['attributes.analytics.rate.output'],CacheReadRate=['attributes.analytics.rate.cacheRead'],CacheWriteRate=['attributes.analytics.rate.cacheWrite'],CacheWrite1hRate=['attributes.analytics.rate.cacheWrite1h']
| summarize arg_max(_time,Revision,Model,Provider,Outcome,Requests,Duration_ms,Tokens,Input,Output,CacheRead,CacheWrite,Reasoning,Estimate_USD,Basis,Currency,RateVersion,InputRate,OutputRate,CacheReadRate,CacheWriteRate,CacheWrite1hRate) by Id`;
  } else if (panel.base === "otel") {
    base = `['computah-prod-traces'] ${common}
| extend spanError=coalesce(ensure_field('error',typeof(bool)),false)
| where isempty('${filters.operation}') or name == '${filters.operation}'
| where isempty('${filters.status}') or ('${filters.status}' == 'error' and spanError) or ('${filters.status}' == 'success' and spanError == false)
| extend ${safeService}, ${safeOperation}`;
  } else {
    base = `['computah-prod-traces']
| extend Provider=column_ifexists('attributes.gen_ai.provider.name',''), RequestModel=column_ifexists('attributes.gen_ai.request.model',string(null)), Model=coalesce(column_ifexists('attributes.gen_ai.response.model',''),column_ifexists('attributes.gen_ai.request.model','')), Agent=iff(isempty(column_ifexists('attributes.gen_ai.agent.name','')),column_ifexists('attributes.gen_ai.capability.name',''),column_ifexists('attributes.gen_ai.agent.name','')), GenOperation=column_ifexists('attributes.gen_ai.operation.name',string(null)), Tool=column_ifexists('attributes.gen_ai.tool.name',''), Status=['status.code']
| where isempty('${filters.provider}') or Provider == '${filters.provider}'
| where isempty('${filters.model}') or RequestModel == '${filters.model}'
| where isempty('${filters.agent}') or Agent == '${filters.agent}'
${panel.id === "tool-performance" ? `| where isempty('${filters.tool}') or Tool == '${filters.tool}'` : ""}
| extend HasModel=isnotempty(Model)
| extend input_tokens=tolong(column_ifexists('attributes.gen_ai.usage.input_tokens',long(null))),output_tokens=tolong(column_ifexists('attributes.gen_ai.usage.output_tokens',long(null)))`;
    if (panel.base === "cost") {
      const fields =
        "model_id:string,input_cost_per_token:real,output_cost_per_token:real,cache_read_cost_per_token:string,cache_write_cost_per_token:string,input_cost_per_token_above_200k_tokens:string,output_cost_per_token_above_200k_tokens:string,cache_read_input_token_cost_above_200k_tokens:string,cache_creation_input_token_cost_above_200k_tokens:string";
      const url =
        "https://modeldb.axiom.co/api/v1/models?format=csv&project=" +
        fields
          .split(",")
          .map((f) => f.split(":")[0])
          .join(",");
      base = `let modeldb=externaldata(${fields}) ["${url}"] with(format="csv");\n${base}
| extend cache_read_tokens=coalesce(tolong(column_ifexists('attributes.gen_ai.usage.cache_read.input_tokens',long(null))),tolong(column_ifexists('attributes.gen_ai.usage.cache_read_input_tokens',long(null))),0),cache_write_tokens=coalesce(tolong(column_ifexists('attributes.gen_ai.usage.cache_creation.input_tokens',long(null))),tolong(column_ifexists('attributes.gen_ai.usage.cache_creation_input_tokens',long(null))),0)
| extend cached_tokens_separate=isnotnull(input_tokens) and cache_read_tokens + cache_write_tokens > input_tokens
| extend uncached_tokens=iff(cached_tokens_separate,input_tokens,input_tokens-cache_read_tokens-cache_write_tokens),long_context=coalesce(iff(cached_tokens_separate,input_tokens+cache_read_tokens+cache_write_tokens,input_tokens),0)>200000
${panel.id === "expensive-outputs" ? "| summarize output_tokens=max(output_tokens) by bin_auto(_time),Agent,Model,long_context | extend uncached_tokens=real(null),cache_read_tokens=long(0),cache_write_tokens=long(0)" : ""}
${panel.id === "vitals" ? "| extend Model=RequestModel" : ""}
| join kind=leftouter (modeldb | extend cache_read_cost_per_token=todouble(cache_read_cost_per_token),cache_write_cost_per_token=todouble(cache_write_cost_per_token),input_cost_per_token_above_200k_tokens=todouble(input_cost_per_token_above_200k_tokens),output_cost_per_token_above_200k_tokens=todouble(output_cost_per_token_above_200k_tokens),cache_read_input_token_cost_above_200k_tokens=todouble(cache_read_input_token_cost_above_200k_tokens),cache_creation_input_token_cost_above_200k_tokens=todouble(cache_creation_input_token_cost_above_200k_tokens)) on $left.Model == $right.model_id
| extend input_price=iff(long_context and coalesce(input_cost_per_token_above_200k_tokens,0)>0,input_cost_per_token_above_200k_tokens,input_cost_per_token),output_price=iff(long_context and coalesce(output_cost_per_token_above_200k_tokens,0)>0,output_cost_per_token_above_200k_tokens,output_cost_per_token)
| extend cache_read_price=case(long_context and coalesce(cache_read_input_token_cost_above_200k_tokens,0)>0,cache_read_input_token_cost_above_200k_tokens,coalesce(cache_read_cost_per_token,0)>0,cache_read_cost_per_token,input_price),cache_write_price=case(long_context and coalesce(cache_creation_input_token_cost_above_200k_tokens,0)>0,cache_creation_input_token_cost_above_200k_tokens,coalesce(cache_write_cost_per_token,0)>0,cache_write_cost_per_token,input_price)
| extend input_cost=uncached_tokens*input_price+cache_read_tokens*cache_read_price+cache_write_tokens*cache_write_price,output_cost=output_tokens*output_price
| extend total_cost=input_cost+output_cost`;
    } else if (panel.base === "context") {
      base += `\n| where HasModel${panel.id === "output-context" ? " and isnotnull(RequestModel)" : ""}
| summarize by _time,trace_id,span_id=column_ifexists('span_id',''),Agent,Model,${panel.id === "input-context" ? "input_tokens" : "output_tokens"}`;
      base = `let modeldb=externaldata(model_id:string,max_input_tokens:real,max_output_tokens:real) ["https://modeldb.axiom.co/api/v1/models?format=csv&project=model_id,max_input_tokens,max_output_tokens"] with(format="csv");\n${base}
| join kind=leftouter modeldb on $left.Model == $right.model_id`;
    }
    // Preserve empty GenAI labels for native population predicates, then map only
    // dimensions used for grouping. No model/agent/tool payload is returned.
    if (["performance", "tool-performance"].includes(panel.id))
      base += "\n| extend Model=RequestModel";
    // Context/output-max dedup intentionally drops unrelated columns.
    base += `\n| extend ${safeModel}, ${safeDimension("Agent", "Agent", AGENTS)}`;
    if (panel.base !== "context" && panel.id !== "expensive-outputs")
      base += `\n| extend ${safeProvider}, Tool=iff(isempty(Tool),'',iff(Tool in (${list(TOOLS)}),Tool,'other')), GenOperation=iff(isnull(GenOperation),string(null),iff(isempty(GenOperation),'',iff(GenOperation in ('chat','invoke_agent','execute_tool','generate_content','text_completion','embeddings'),GenOperation,'other')))`;
  }
  let query = panel.query;
  if (["app", "logs", "usage"].includes(panel.base)) {
    // Native population predicates run before allowlisting. Otherwise an unknown
    // named operation could disappear instead of joining its public other bucket.
    const summary = query.indexOf("| summarize");
    if (summary >= 0) {
      base += `\n${query.slice(0, summary)}`;
      query = query.slice(summary);
    }
    base +=
      panel.base === "usage"
        ? `\n| extend ${safeModel}, ${safeProvider}, ${safeOutcome}`
        : `\n| extend ${safeDimension("Service", "Service", SERVICES)}, ${safeDimension("Operation", "Operation", PUBLIC_OPERATIONS)}, ${safeOutcome}${panel.base === "app" ? `, ${safeTool}` : ""}`;
  }
  const bin =
    filters.window === "24h" ? "24m" : filters.window === "1h" ? "1m" : "30s";
  return `${base}\n${query.replaceAll("| where isnotempty(Model)", panel.id === "expensive-outputs" ? "" : "| where HasModel")}\n| project ${panel.columns.join(",")}\n| take 1001`.replaceAll(
    "bin_auto(_time)",
    `bin(_time,${bin})`,
  );
}
