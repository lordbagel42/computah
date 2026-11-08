import assert from "node:assert/strict";
import test from "node:test";
import { ValueType } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  AggregationTemporality,
  DataPointType,
  type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import { replyLatencyBounds, sanitizeMetrics } from "../src/metrics.js";

test("native metric boundary reconstructs only fixed scalar series and supported explicit buckets", () => {
  const point = {
    startTime: [1, 0] as [number, number],
    endTime: [2, 0] as [number, number],
    attributes: { actor: "PRIVATE-CANARY", outcome: "success" },
    value: 7,
  };
  const descriptor = {
    name: "computah.slack.reply.pending",
    description: "PRIVATE-CANARY",
    unit: "PRIVATE-CANARY",
    valueType: ValueType.DOUBLE,
  };
  const input: ResourceMetrics = {
    resource: resourceFromAttributes({ secret: "PRIVATE-CANARY" }),
    scopeMetrics: [
      {
        scope: { name: "PRIVATE-CANARY" },
        metrics: [
          {
            descriptor,
            aggregationTemporality: AggregationTemporality.CUMULATIVE,
            dataPointType: DataPointType.GAUGE,
            dataPoints: [point],
          },
          {
            descriptor: { ...descriptor, name: "PRIVATE-CANARY" },
            aggregationTemporality: AggregationTemporality.CUMULATIVE,
            dataPointType: DataPointType.GAUGE,
            dataPoints: [point],
          },
          {
            descriptor: {
              ...descriptor,
              name: "computah.slack.reply.outcomes",
            },
            aggregationTemporality: AggregationTemporality.CUMULATIVE,
            dataPointType: DataPointType.SUM,
            isMonotonic: true,
            dataPoints: [
              point,
              { ...point, attributes: { outcome: "PRIVATE-CANARY" } },
              { ...point, value: NaN },
            ],
          },
          {
            descriptor: { ...descriptor, name: "computah.slack.reply.latency" },
            aggregationTemporality: AggregationTemporality.DELTA,
            dataPointType: DataPointType.HISTOGRAM,
            dataPoints: [
              {
                ...point,
                value: {
                  count: 2,
                  sum: 10001,
                  min: 5000,
                  max: 5001,
                  buckets: {
                    boundaries: replyLatencyBounds,
                    counts: [1, 1, ...Array(59).fill(0)],
                  },
                },
              },
            ],
          },
        ],
      },
    ],
  };
  const projected = sanitizeMetrics(input, 500);
  const output = JSON.stringify(projected);
  assert.ok(!output.includes("PRIVATE-CANARY"));
  assert.ok(!output.includes("actor"));
  const metrics = projected.resourceMetrics[0].scopeMetrics[0].metrics;
  assert.equal(metrics.length, 3);
  assert.deepEqual(metrics[0], {
    name: "computah.slack.reply.pending",
    unit: "{reply}",
    gauge: {
      dataPoints: [
        {
          startTimeUnixNano: "1000000000",
          timeUnixNano: "2000000000",
          attributes: [],
          asDouble: 7,
        },
      ],
    },
  });
  assert.deepEqual(metrics[1], {
    name: "computah.slack.reply.outcomes",
    unit: "{reply}",
    sum: {
      aggregationTemporality: 2,
      isMonotonic: true,
      dataPoints: [
        {
          startTimeUnixNano: "500000000",
          timeUnixNano: "2000000000",
          attributes: [{ key: "outcome", value: { stringValue: "success" } }],
          asDouble: 7,
        },
      ],
    },
  });
  const histogram = input.scopeMetrics[0].metrics[3];
  assert.equal(histogram.dataPointType, DataPointType.HISTOGRAM);
  if (histogram.dataPointType === DataPointType.HISTOGRAM)
    histogram.dataPoints[0].value.buckets.boundaries = [1, 5, 100];
  assert.equal(
    sanitizeMetrics(input, 500).resourceMetrics[0].scopeMetrics[0].metrics
      .length,
    2,
    "reject unsupported or uneven bucket geometry",
  );
});
