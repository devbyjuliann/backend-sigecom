import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bogotaUtcBoundaries,
  calculateReferenceBalance,
  validateSalesActivityPeriod,
} from "../../src/modules/reports/sales-activity-service.js";

test("Bogotá period boundaries include midnight and exclude following midnight", () => {
  assert.deepEqual(bogotaUtcBoundaries("2026-01-10", "2026-01-10"), {
    startUtc: "2026-01-10 05:00:00.000",
    endUtc: "2026-01-11 05:00:00.000",
  });
});

test("period validation rejects impossible, inverted and over-92-day ranges", () => {
  assert.throws(() => validateSalesActivityPeriod("2026-02-30", "2026-03-01"));
  assert.throws(() => validateSalesActivityPeriod("0000-01-01", "0000-01-01"));
  assert.throws(() => validateSalesActivityPeriod("2026-03-02", "2026-03-01"));
  assert.throws(() => validateSalesActivityPeriod("2026-01-01", "2026-04-03"));
  assert.doesNotThrow(() =>
    validateSalesActivityPeriod("2026-01-01", "2026-04-02"),
  );
});

test("reference balance uses exact decimal arithmetic for large and negative totals", () => {
  assert.equal(
    calculateReferenceBalance(
      "999999999999999999999999.99",
      "2.45",
      "1000000000000000000000000.00",
    ),
    "-2.46",
  );
  assert.equal(calculateReferenceBalance("10.00", "12.25", "1.00"), "-3.25");
});
