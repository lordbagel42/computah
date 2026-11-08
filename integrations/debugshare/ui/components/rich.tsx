import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { cn, statusDot, statusTone, tokenize } from "../lib.js";
import { Tooltip } from "./ui.js";

export function StatusBadge({
  status,
  className,
}: {
  status: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-1.5 py-px font-mono text-[11px] leading-5 ring-1 ring-inset",
        statusTone[status] ?? "text-muted-foreground ring-border",
        className,
      )}
    >
      <span
        className={cn("size-1.5 rounded-full", statusDot[status] ?? "bg-faint")}
      />
      {status}
    </span>
  );
}

export function CopyButton({
  value,
  label = "Copy",
  className,
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const [done, setDone] = useState(false);
  return (
    <Tooltip content={done ? "Copied" : label}>
      <button
        type="button"
        aria-label={label}
        className={cn(
          "inline-flex size-6 shrink-0 items-center justify-center rounded text-faint transition-colors hover:bg-accent hover:text-foreground focus-visible:text-foreground focus-visible:outline-2",
          className,
        )}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          void navigator.clipboard?.writeText(value).then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1200);
          });
        }}
      >
        {done ? (
          <Check className="size-3.5 text-emerald-400" />
        ) : (
          <Copy className="size-3.5" />
        )}
      </button>
    </Tooltip>
  );
}

export function Ext({
  href,
  children,
  className,
}: {
  href: string | null;
  children: ReactNode;
  className?: string;
}) {
  if (!href) return <span className={className}>{children}</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={cn(
        "inline-flex items-center gap-1 text-link underline-offset-2 hover:underline",
        className,
      )}
    >
      {children}
      <ExternalLink className="size-3 shrink-0 opacity-70" />
    </a>
  );
}

const typeTitles: Record<string, string> = {
  issue: "Issue in this tracker",
  amp: "Amp thread",
  commit: "Computah commit on GitHub",
  trace: "Trace: issues and Axiom links",
  span: "Axiom span query",
  user: "Slack user: messages and issues",
  channel: "Slack conversation: messages and issues",
  axiom: "Axiom",
  url: "External link",
};
export function RichText({
  text,
  around,
  className,
}: {
  text: string;
  around?: string | null;
  className?: string;
}) {
  const render = (value: string, keyBase: string): ReactNode[] =>
    tokenize(value, around).map((t, i) => {
      const key = `${keyBase}${i}`;
      if (t.kind === "text") return <span key={key}>{t.text}</span>;
      if (t.kind === "code")
        return (
          <code
            key={key}
            className="rounded bg-secondary px-1 py-px font-mono text-[0.9em] text-secondary-foreground"
          >
            {render(t.text, `${key}.`)}
          </code>
        );
      return (
        <span key={key}>
          {t.prefix}
          <a
            href={t.href}
            title={typeTitles[t.type]}
            {...(t.external ? { target: "_blank", rel: "noreferrer" } : {})}
            className={cn(
              "break-all text-link underline decoration-link/30 underline-offset-2 hover:decoration-link",
              t.type !== "url" &&
                t.type !== "axiom" &&
                "font-mono text-[0.92em]",
            )}
          >
            {t.text}
          </a>
          {t.prefix ? " " : ""}
        </span>
      );
    });
  return (
    <span
      className={cn("whitespace-pre-wrap [overflow-wrap:anywhere]", className)}
    >
      {render(text, "")}
    </span>
  );
}

/** Axiom-style panel: mono title row, hairline rows, collapsible. */
export function Panel({
  title,
  count,
  actions,
  children,
  className,
  id,
  collapsible = true,
  defaultOpen = true,
}: {
  title: string;
  count?: number | string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
  collapsible?: boolean;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const heading = (
    <span className="flex items-center gap-2 font-mono text-[13px] text-foreground">
      {collapsible &&
        (open ? (
          <ChevronDown className="size-3.5 text-faint" />
        ) : (
          <ChevronRight className="size-3.5 text-faint" />
        ))}
      {title}
      {count !== undefined && (
        <span className="rounded bg-secondary px-1.5 font-mono text-[11px] text-muted-foreground">
          {count}
        </span>
      )}
    </span>
  );
  return (
    <section
      id={id}
      aria-label={title}
      className={cn(
        "scroll-mt-4 overflow-hidden rounded-md border border-border bg-panel",
        className,
      )}
    >
      <div className="flex min-h-11 items-center justify-between gap-2 border-b border-border bg-panel-head px-3">
        {collapsible ? (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className="-ml-1 rounded px-1 py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            {heading}
          </button>
        ) : (
          heading
        )}
        {actions && <div className="flex items-center gap-1">{actions}</div>}
      </div>
      {open && children}
    </section>
  );
}

/** Two-column key/value grid with the Axiom vertical rule. */
export function KV({ rows }: { rows: [ReactNode, ReactNode, string?][] }) {
  return (
    <dl className="divide-y divide-border text-[13px]">
      {rows.map(([k, v, copy], i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed, ordered key/value rows
          key={`${String(k)}${i}`}
          className="grid grid-cols-[minmax(7.5rem,34%)_1fr] items-stretch"
        >
          <dt className="border-r border-border px-3 py-2.5 text-muted-foreground">
            {k}
          </dt>
          <dd className="group flex min-w-0 items-center justify-between gap-2 px-3 py-2 font-mono text-[12.5px] text-foreground">
            <span className="min-w-0 [overflow-wrap:anywhere]">{v}</span>
            {copy && (
              <CopyButton
                value={copy}
                className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
              />
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function TypeBadge({ type }: { type: string }) {
  const letter: Record<string, string> = {
    string: "S",
    number: "N",
    boolean: "B",
    object: "M",
    array: "[]",
    null: "∅",
    time: "T",
  };
  return (
    <span
      title={type}
      className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-[4px] border border-border bg-secondary px-0.5 font-mono text-[10px] text-muted-foreground"
    >
      <span aria-hidden="true">{letter[type] ?? "?"}</span>
      <span className="sr-only">{type}</span>
    </span>
  );
}

export function Empty({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="px-4 py-8 text-center">
      <p className="font-mono text-[13px] text-muted-foreground">{title}</p>
      {children && (
        <div className="mx-auto mt-1.5 max-w-md text-[13px] text-faint">
          {children}
        </div>
      )}
    </div>
  );
}
