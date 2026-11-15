import assert from "node:assert/strict";
import { test } from "node:test";
import { createDashboardService } from "../../src/modules/dashboard/dashboard-service.js";

test("commercial dashboard queries require module and warehouse permissions and stay within assigned warehouses", async () => {
  const calls = [];
  const dbPool = {
    async execute(sql, values = []) {
      calls.push({ sql, values });
      if (sql.includes("dashboard:salesNet"))
        return [[{ month: "2026-11", value: "110.00" }]];
      if (sql.includes("dashboard:purchasesReceived"))
        return [[{ value: "80.25" }]];
      if (sql.includes("dashboard:stockedProducts")) return [[{ total: "6" }]];
      if (sql.includes("dashboard:lowStock")) return [[{ total: "2" }]];
      if (sql.includes("dashboard:pendingReceipts")) return [[{ total: "3" }]];
      if (sql.includes("dashboard:topProducts"))
        return [
          [
            {
              product_id: "7",
              sku: "SKU-7",
              name: "Producto 7",
              unit: "caja",
              quantity: "4",
              amount: "80.00",
            },
          ],
        ];
      if (sql.includes("dashboard:inventoryByWarehouse"))
        return [
          [
            {
              warehouse_id: "9",
              warehouse_code: "B-9",
              warehouse_name: "Bodega 9",
              stocked_products: "6",
              stocked_pairs: "8",
            },
          ],
        ];
      if (sql.includes("dashboard:recentActivity"))
        return [
          [
            {
              type: "sale_confirmation",
              occurred_at: "2026-11-14T10:00:00.000Z",
              document_code: "VE-1",
              warehouse_code: "B-9",
              warehouse_name: "Bodega 9",
              amount: "20.00",
            },
          ],
        ];
      return [[{ total: "0" }]];
    },
  };
  const service = createDashboardService({ dbPool });
  const permissions = new Set([
    "sales.read",
    "purchases.read",
    "inventory.read",
    "warehouses.read",
  ]);

  const summary = await service.getSummary({
    userId: "17",
    permissions,
    now: new Date("2026-11-14T12:00:00.000Z"),
  });

  assert.deepEqual(summary.commercial, {
    period: {
      dateFrom: "2026-11-01",
      dateTo: "2026-11-30",
      timeZone: "America/Bogota",
    },
    salesNet: { available: true, value: "110.00" },
    purchasesReceived: { available: true, value: "80.25" },
    stockedProducts: { available: true, value: 6 },
    lowStockProducts: { available: true, value: 2 },
    pendingReceipts: { available: true, value: 3 },
    salesTrend: {
      available: true,
      items: [
        { month: "2026-09", value: "0.00" },
        { month: "2026-10", value: "0.00" },
        { month: "2026-11", value: "110.00" },
      ],
    },
    topProducts: {
      available: true,
      items: [
        {
          productId: "7",
          sku: "SKU-7",
          name: "Producto 7",
          unit: "caja",
          quantity: "4",
          amount: "80.00",
        },
      ],
    },
    inventoryByWarehouse: {
      available: true,
      items: [
        {
          warehouseId: "9",
          warehouseCode: "B-9",
          warehouseName: "Bodega 9",
          stockedProducts: 6,
          stockedPairs: 8,
        },
      ],
    },
    recentActivity: {
      available: true,
      items: [
        {
          type: "sale_confirmation",
          occurredAt: "2026-11-14T10:00:00.000Z",
          documentCode: "VE-1",
          warehouseCode: "B-9",
          warehouseName: "Bodega 9",
          amount: "20.00",
        },
      ],
    },
  });
  const commercialCalls = calls.filter(({ sql }) => /dashboard:/.test(sql));
  assert.equal(commercialCalls.length, 8);
  assert.equal(
    commercialCalls.some(({ sql }) => sql.includes("inventoryValue")),
    false,
  );
  assert.ok(commercialCalls.every(({ sql }) => /user_warehouses/.test(sql)));
  assert.ok(commercialCalls.every(({ values }) => values.includes("17")));
  assert.ok(
    commercialCalls
      .filter(({ sql }) => /dashboard:(salesNet|purchasesReceived)/.test(sql))
      .every(
        ({ values }) =>
          values.some((value) => String(value).startsWith("2026-11-01")) ||
          values.some((value) => String(value).startsWith("2026-09-01")),
      ),
  );
  const salesCall = commercialCalls.find(({ sql }) =>
    sql.includes("dashboard:salesNet"),
  );
  assert.ok(salesCall.values.includes("2026-09-01 05:00:00.000"));
  assert.ok(salesCall.values.includes("2026-12-01 05:00:00.000"));
});

test("commercial metrics remain unavailable and execute no commercial query without matching permissions", async () => {
  let calls = 0;
  const service = createDashboardService({
    dbPool: {
      async execute() {
        calls += 1;
        return [[{ total: "0" }]];
      },
    },
  });

  const summary = await service.getSummary({
    userId: "17",
    permissions: new Set(["products.read"]),
    now: new Date("2026-11-14T12:00:00.000Z"),
  });

  assert.deepEqual(summary.commercial.salesNet, {
    available: false,
    value: null,
  });
  assert.deepEqual(summary.commercial.purchasesReceived, {
    available: false,
    value: null,
  });
  assert.deepEqual(summary.commercial.salesTrend, {
    available: false,
    items: null,
  });
  assert.deepEqual(summary.commercial.topProducts, {
    available: false,
    items: null,
  });
  assert.deepEqual(summary.commercial.inventoryByWarehouse, {
    available: false,
    items: null,
  });
  assert.deepEqual(summary.commercial.recentActivity, {
    available: false,
    items: null,
  });
  assert.deepEqual(summary.commercial.stockedProducts, {
    available: false,
    value: null,
  });
  assert.deepEqual(summary.commercial.lowStockProducts, {
    available: false,
    value: null,
  });
  assert.deepEqual(summary.commercial.pendingReceipts, {
    available: false,
    value: null,
  });
  assert.equal(calls, 1);
});
