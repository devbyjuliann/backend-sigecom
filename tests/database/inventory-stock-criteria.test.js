import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LOW_STOCK_SQL,
  isLowStock,
  stockStatus,
} from "../../src/modules/inventory/stock-criteria.js";

test("stock criteria distinguish unregistered, exhausted, low, and available balances", () => {
  const cases = [
    {
      name: "missing balance is unregistered and never low",
      input: { hasBalance: false, quantity: null, minimumStock: 5 },
      low: false,
      status: "unregistered",
    },
    {
      name: "zero minimum does not activate low-stock threshold",
      input: { hasBalance: true, quantity: 0, minimumStock: 0 },
      low: false,
      status: "exhausted",
    },
    {
      name: "registered zero stock is exhausted and below a positive minimum",
      input: { hasBalance: true, quantity: 0, minimumStock: 5 },
      low: true,
      status: "exhausted",
    },
    {
      name: "positive quantity below threshold is low",
      input: { hasBalance: true, quantity: 4, minimumStock: 5 },
      low: true,
      status: "low",
    },
    {
      name: "quantity equal to threshold is available",
      input: { hasBalance: true, quantity: 5, minimumStock: 5 },
      low: false,
      status: "available",
    },
    {
      name: "quantity above threshold is available",
      input: { hasBalance: true, quantity: 6, minimumStock: 5 },
      low: false,
      status: "available",
    },
  ];

  for (const { name, input, low, status } of cases) {
    assert.equal(isLowStock(input), low, name);
    assert.equal(stockStatus(input), status, name);
  }
});

test("low-stock SQL requires a registered balance, positive minimum, and quantity below it", () => {
  assert.equal(
    LOW_STOCK_SQL,
    "ib.id IS NOT NULL AND p.minimum_stock > 0 AND ib.quantity < p.minimum_stock",
  );
});
