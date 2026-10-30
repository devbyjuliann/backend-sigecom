import assert from "node:assert/strict";
import { test } from "node:test";
import { inventoryEngineValidation } from "../../src/modules/inventory/inventory-engine.js";

test("inventory operation validation accepts bounded integers and rejects fractions and overflow", () => {
  const payload = inventoryEngineValidation.normalizePayload({
    type: "initial_stock",
    sourceWarehouseId: "9007199254740993",
    destinationWarehouseId: null,
    reason: "Conteo controlado",
    reference: null,
    lines: [{ productId: "9007199254740995", quantity: 4_294_967_295 }],
  });
  assert.equal(payload.sourceWarehouseId, "9007199254740993");
  assert.equal(payload.lines[0].productId, "9007199254740995");
  assert.equal(payload.lines[0].quantity, 4_294_967_295);

  for (const quantity of [
    0,
    -1,
    1.25,
    4_294_967_296,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.throws(
      () =>
        inventoryEngineValidation.normalizePayload({
          type: "initial_stock",
          sourceWarehouseId: "1",
          destinationWarehouseId: null,
          reason: "Conteo controlado",
          reference: null,
          lines: [{ productId: "2", quantity }],
        }),
      (error) => error.code === "INVALID_INVENTORY_OPERATION",
    );
  }
});

test("inventory versions remain exact decimal strings across the unsigned BIGINT range", () => {
  assert.equal(
    inventoryEngineValidation.normalizeVersion("18446744073709551615"),
    "18446744073709551615",
  );
  assert.throws(
    () => inventoryEngineValidation.normalizeVersion("18446744073709551616"),
    (error) => error.code === "INVALID_INVENTORY_OPERATION",
  );
  assert.throws(
    () => inventoryEngineValidation.normalizeVersion(Number.MAX_SAFE_INTEGER),
    (error) => error.code === "INVALID_INVENTORY_OPERATION",
  );
});

test("purchase receipt ledger operations preserve their commercial source association", () => {
  const input = {
    type: "purchase_receipt",
    sourceWarehouseId: "17",
    destinationWarehouseId: null,
    sourceType: "purchase_receipt",
    sourceId: "9007199254740993",
    reason: "Recepción de orden OC-000042",
    reference: "REM-42",
    lines: [
      { productId: "9007199254740995", quantity: 6, expectedVersion: "0" },
    ],
  };
  assert.throws(
    () => inventoryEngineValidation.normalizePayload(input),
    /no está habilitado/i,
  );
  const payload = inventoryEngineValidation.normalizePayload(input, {
    allowPurchaseReceipt: true,
  });

  assert.equal(payload.type, "purchase_receipt");
  assert.equal(payload.sourceType, "purchase_receipt");
  assert.equal(payload.sourceId, "9007199254740993");
  assert.equal(payload.lines[0].expectedVersion, "0");
});
