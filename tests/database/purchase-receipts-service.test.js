import assert from "node:assert/strict";
import { test } from "node:test";
import {
  calculateReferenceNetReceived,
  calculateUnitDifferences,
  validatePurchaseReceiptsPeriod,
} from "../../src/modules/reports/purchase-receipts-service.js";

test("purchase receipt periods accept at most 92 valid inclusive Bogotá days", () => {
  assert.equal(
    validatePurchaseReceiptsPeriod("2026-01-01", "2026-04-02"),
    true,
  );
  assert.throws(() =>
    validatePurchaseReceiptsPeriod("2026-01-01", "2026-04-03"),
  );
  assert.throws(() =>
    validatePurchaseReceiptsPeriod("2026-02-30", "2026-03-01"),
  );
  assert.throws(() =>
    validatePurchaseReceiptsPeriod("2026-03-02", "2026-03-01"),
  );
});

test("purchase reference value subtracts exact decimal amounts and can be negative", () => {
  assert.equal(
    calculateReferenceNetReceived(
      "999999999999999999999999999999999999.99",
      "1000000000000000000000000000000000000.00",
    ),
    "-0.01",
  );
  assert.equal(calculateReferenceNetReceived("0.00", "0.00"), "0.00");
});

test("physical quantities are differenced exactly and independently by unit", () => {
  assert.deepEqual(
    calculateUnitDifferences([
      {
        unit: "caja",
        received: "9007199254740993",
        returned: "9007199254740994",
      },
      { unit: "unidad", received: "2", returned: "1" },
    ]),
    [
      {
        unit: "caja",
        quantityReceived: "9007199254740993",
        quantityReturned: "9007199254740994",
        quantityDifference: "-1",
      },
      {
        unit: "unidad",
        quantityReceived: "2",
        quantityReturned: "1",
        quantityDifference: "1",
      },
    ],
  );
});
