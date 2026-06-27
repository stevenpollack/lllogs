import React, { useEffect, useRef } from "react";
import type { EventFilter } from "@clogdy/shared";
import { getStats } from "../api";
import { barList, sparkBars, gauge, table } from "../charts";

interface ToolCount {
  tool: string;
  count: number;
}
interface ErrorRate {
  total: number;
  errors: number;
  rate: number;
}
interface Latency {
  tool: string;
  p50: number;
  p95: number;
  n: number;
}
interface ProjectRollup {
  project: string;
  events: number;
  tool_calls: number;
  errors: number;
}
interface TimeBucket {
  bucket: number;
  count: number;
}

/**
 * AnalyticsView renders analytics data using the existing chart helpers.
 * The chart helpers return DOM elements; we use refs to mount them.
 */
function ChartSection({
  title,
  dep,
  builder,
}: {
  title: string;
  /** Rebuild the (imperative) chart DOM only when this changes — not every render. */
  dep: unknown;
  builder: () => Element | null;
}): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    containerRef.current.innerHTML = "";
    const el = builder();
    if (el) {
      containerRef.current.appendChild(el);
    } else {
      const none = document.createElement("div");
      none.className = "no-data";
      none.textContent = "no data";
      containerRef.current.appendChild(none);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dep]);

  return (
    <>
      <h3>{title}</h3>
      <div ref={containerRef} />
    </>
  );
}

interface AnalyticsViewProps {
  filter: EventFilter;
  visible: boolean;
}

export function AnalyticsView({ filter, visible }: AnalyticsViewProps): React.ReactElement {
  const [data, setData] = React.useState<{
    toolCounts: ToolCount[];
    errorRate: ErrorRate | null;
    latency: Latency[];
    projectRollup: ProjectRollup[];
    timeBuckets: TimeBucket[];
  } | null>(null);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    void (async () => {
      // allSettled: a single failing metric must not reject the whole batch
      // (which would leave the tab blank and raise an unhandled rejection).
      const settled = await Promise.allSettled([
        getStats("toolCounts", filter),
        getStats("errorRate", filter),
        getStats("latency", filter),
        getStats("projectRollup", filter),
        getStats("timeBuckets", filter),
      ]);
      if (cancelled) return;
      const pick = (i: number): unknown => {
        const r = settled[i]!;
        return r.status === "fulfilled" ? r.value.data : null;
      };
      setData({
        toolCounts: (pick(0) as ToolCount[] | null) ?? [],
        errorRate: pick(1) as ErrorRate | null,
        latency: (pick(2) as Latency[] | null) ?? [],
        projectRollup: (pick(3) as ProjectRollup[] | null) ?? [],
        timeBuckets: (pick(4) as TimeBucket[] | null) ?? [],
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, filter]);

  return (
    <section id="analytics" style={{ display: visible ? "" : "none" }}>
      {data && (
        <>
          <ChartSection
            title="Tool counts"
            dep={data.toolCounts}
            builder={() =>
              data.toolCounts.length > 0
                ? barList(data.toolCounts.map((t) => ({ label: t.tool, value: t.count })))
                : null
            }
          />

          <ChartSection
            title="Error rate"
            dep={data.errorRate}
            builder={() => {
              const er = data.errorRate;
              if (er && er.total > 0) {
                const wrap = document.createElement("div");
                wrap.appendChild(gauge(er.rate));
                const num = document.createElement("div");
                num.className = "gauge-number";
                num.textContent = `${er.errors} / ${er.total} (${(er.rate * 100).toFixed(1)}%)`;
                wrap.appendChild(num);
                return wrap;
              }
              return null;
            }}
          />

          <ChartSection
            title="Latency"
            dep={data.latency}
            builder={() =>
              data.latency.length > 0
                ? table(
                    ["TOOL", "p50 ms", "p95 ms", "n"],
                    data.latency.map((l) => [l.tool, String(l.p50), String(l.p95), String(l.n)]),
                  )
                : null
            }
          />

          <ChartSection
            title="Project rollup"
            dep={data.projectRollup}
            builder={() =>
              data.projectRollup.length > 0
                ? table(
                    ["PROJECT", "EVENTS", "TOOL_CALLS", "ERRORS"],
                    data.projectRollup.map((p) => [
                      p.project,
                      String(p.events),
                      String(p.tool_calls),
                      String(p.errors),
                    ]),
                  )
                : null
            }
          />

          <ChartSection
            title="Events over time"
            dep={data.timeBuckets}
            builder={() =>
              data.timeBuckets.length > 0
                ? sparkBars(data.timeBuckets.map((b) => ({ x: b.bucket, y: b.count })))
                : null
            }
          />
        </>
      )}
    </section>
  );
}
