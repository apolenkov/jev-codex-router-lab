import type { RouterDecision } from "./contracts.js";
import type { PassTelemetry, RouteTelemetry } from "./router.js";

export interface PriceEnvironment {
  TYPESAFE_INPUT_USD_PER_MILLION?: string;
  TYPESAFE_OUTPUT_USD_PER_MILLION?: string;
}

interface ReportBase {
  status: RouterDecision["status"];
  callCount: number;
  passes: readonly PassTelemetry[];
  totalLatencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  retryCount?: number;
  cacheStatus: "not-used";
}

export type RouteReport = ReportBase & (
  | { costUsd: number }
  | { costUsd: null; costReason: "price-not-configured" | "usage-not-observable" | "cost-overflow" }
);

const parsePrice = (value: string | undefined): number | null => {
  if (value === undefined || value.trim().length === 0) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

const hasUsage = (
  pass: PassTelemetry,
): pass is PassTelemetry & { inputTokens: number; outputTokens: number } =>
  pass.inputTokens !== undefined && pass.outputTokens !== undefined;

const hasRetryCount = (
  pass: PassTelemetry,
): pass is PassTelemetry & { retryCount: number } =>
  pass.retryCount !== undefined;

export function buildReport(
  decision: RouterDecision,
  telemetry: RouteTelemetry,
  prices: PriceEnvironment = process.env,
): RouteReport {
  const usageObservable = telemetry.passes.length > 0 && telemetry.passes.every(hasUsage);
  const inputTokens = usageObservable
    ? telemetry.passes.reduce((total, pass) => total + (pass.inputTokens ?? 0), 0)
    : null;
  const outputTokens = usageObservable
    ? telemetry.passes.reduce((total, pass) => total + (pass.outputTokens ?? 0), 0)
    : null;
  const retryObservable = telemetry.passes.length > 0 && telemetry.passes.every(hasRetryCount);
  const base: ReportBase = {
    status: decision.status,
    callCount: telemetry.passes.length,
    passes: telemetry.passes,
    totalLatencyMs: telemetry.totalLatencyMs,
    inputTokens,
    outputTokens,
    cacheStatus: "not-used",
    ...(retryObservable
      ? { retryCount: telemetry.passes.reduce((total, pass) => total + (pass.retryCount ?? 0), 0) }
      : {}),
  };
  const inputPrice = parsePrice(prices.TYPESAFE_INPUT_USD_PER_MILLION);
  const outputPrice = parsePrice(prices.TYPESAFE_OUTPUT_USD_PER_MILLION);

  if (inputPrice === null || outputPrice === null) {
    return { ...base, costUsd: null, costReason: "price-not-configured" };
  }
  if (inputTokens === null || outputTokens === null) {
    return { ...base, costUsd: null, costReason: "usage-not-observable" };
  }
  const costUsd = (inputTokens * inputPrice + outputTokens * outputPrice) / 1_000_000;
  return Number.isFinite(costUsd)
    ? { ...base, costUsd }
    : { ...base, costUsd: null, costReason: "cost-overflow" };
}
