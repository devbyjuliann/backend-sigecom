import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildPurchaseOrdersEligibleQuery,
  calculatePurchaseOrderSituation,
  createPurchaseOrdersService,
  validatePurchaseOrdersPeriod,
} from "../src/modules/reports/purchase-orders-service.js";

test("eligible SQL applies integrity and mode filters before deterministic pagination", () => {
  const pending = buildPurchaseOrdersEligibleQuery({
    warehouseIds: ["2", "9"],
    mode: "pending",
    pageSize: 20,
    offset: 0,
    situation: "partially_received",
  });
  assert.match(pending.sql, /order_integrity/);
  assert.match(pending.sql, /receipt_integrity/);
  assert.match(pending.sql, /HAVING/);
  assert.doesNotMatch(pending.sql, /po\.order_date\s*[<>]=\s*\?/);
  assert.match(
    pending.sql,
    /ORDER BY order_date ASC, id ASC\s+LIMIT \? OFFSET \?/,
  );
  assert.doesNotMatch(pending.sql, /ROW_NUMBER|page_row/);
  assert.deepEqual(pending.params.slice(-3), ["partially_received", 20, 0]);

  const period = buildPurchaseOrdersEligibleQuery({
    warehouseIds: ["2"],
    mode: "period",
    dateFrom: "2026-01-01",
    dateTo: "2026-03-31",
    pageSize: 10,
    offset: 10,
  });
  assert.match(period.sql, /order_date >= \? AND po\.order_date <= \?/);
  assert.match(
    period.sql,
    /ORDER BY order_date DESC, id DESC\s+LIMIT \? OFFSET \?/,
  );
  assert.doesNotMatch(period.sql, /ROW_NUMBER|page_row/);
  assert.deepEqual(period.params.slice(0, 3), [
    "2",
    "2026-01-01",
    "2026-03-31",
  ]);
});

test("purchase-order search is scoped, parameterized, and treats LIKE wildcards literally", () => {
  const query = buildPurchaseOrdersEligibleQuery({
    warehouseIds: ["4"],
    mode: "period",
    dateFrom: "2026-01-01",
    dateTo: "2026-01-31",
    q: "OC_%!",
    pageSize: 10,
    offset: 20,
  });
  assert.match(query.sql, /po\.commercial_code LIKE \? ESCAPE '!'/);
  assert.deepEqual(query.params, [
    "4",
    "%OC!_!%!!%",
    "2026-01-01",
    "2026-01-31",
    10,
    20,
  ]);
  assert.doesNotMatch(query.sql, /OC_%!/);
});

test("derives pending, received, and closed quantities without treating closure as receipt", () => {
  assert.deepEqual(
    calculatePurchaseOrderSituation({
      status: "confirmed",
      closedAt: null,
      lines: [
        {
          quantity: "10",
          receivedQuantity: "4",
          unit: "caja",
          unitCost: "2.00",
          lineTotal: "20.00",
        },
      ],
    }),
    {
      situation: "partially_received",
      receiptProgress: "partial",
      hasClosure: false,
      orderedValue: "20.00",
      orderedByUnit: [{ unit: "caja", quantity: "10" }],
      receivedByUnit: [{ unit: "caja", quantity: "4" }],
      pendingByUnit: [{ unit: "caja", quantity: "6" }],
      closedByUnit: [],
      lines: [
        {
          quantity: "10",
          receivedQuantity: "4",
          pendingQuantity: "6",
          closedQuantity: "0",
          unit: "caja",
          unitCost: "2.00",
          lineTotal: "20.00",
        },
      ],
    },
  );

  const closed = calculatePurchaseOrderSituation({
    status: "confirmed",
    closedAt: "2026-11-01T12:00:00.000Z",
    lines: [
      {
        quantity: "9",
        receivedQuantity: "5",
        unit: "unidad",
        unitCost: "1.00",
        lineTotal: "9.00",
      },
    ],
  });
  assert.equal(closed.situation, "closed_with_remnant");
  assert.equal(closed.receiptProgress, "partial");
  assert.equal(closed.lines[0].pendingQuantity, "0");
  assert.equal(closed.lines[0].closedQuantity, "4");
});

test("drafts without active lines remain legitimate and canceled orders have no applicable pending", () => {
  assert.equal(
    calculatePurchaseOrderSituation({
      status: "draft",
      closedAt: null,
      lines: [],
    }).situation,
    "draft_without_lines",
  );
  const cancelled = calculatePurchaseOrderSituation({
    status: "cancelled",
    closedAt: null,
    lines: [
      {
        quantity: "3",
        receivedQuantity: "0",
        unit: "caja",
        unitCost: "1.00",
        lineTotal: "3.00",
      },
    ],
  });
  assert.equal(cancelled.situation, "cancelled");
  assert.equal(cancelled.lines[0].pendingQuantity, null);
});

test("fully received orders are not counted as currently pending", () => {
  const result = calculatePurchaseOrderSituation({
    status: "confirmed",
    closedAt: null,
    lines: [
      {
        quantity: "4",
        receivedQuantity: "4",
        unit: "caja",
        unitCost: "1.25",
        lineTotal: "5.00",
      },
    ],
  });
  assert.equal(result.situation, "fully_received");
  assert.deepEqual(result.pendingByUnit, []);
  assert.deepEqual(result.closedByUnit, []);
  assert.equal(result.lines[0].pendingQuantity, "0");
});

test("rejects received quantities above order and invalid documentary periods", () => {
  assert.throws(
    () =>
      calculatePurchaseOrderSituation({
        status: "confirmed",
        closedAt: null,
        lines: [
          {
            quantity: "2",
            receivedQuantity: "3",
            unit: "caja",
            unitCost: "1.00",
            lineTotal: "2.00",
          },
        ],
      }),
    /excede la cantidad ordenada/,
  );
  assert.equal(validatePurchaseOrdersPeriod("2026-01-01", "2026-04-02"), true);
  assert.throws(
    () => validatePurchaseOrdersPeriod("2026-01-01", "2026-04-03"),
    /92 días/,
  );
  assert.throws(
    () => validatePurchaseOrdersPeriod("2026-02-30", "2026-03-01"),
    /92 días/,
  );
});

test("commits and releases its read-only transaction when authorized scope is empty", async () => {
  const calls = [];
  const connection = {
    async query(sql) {
      calls.push(sql);
    },
    async beginTransaction() {
      calls.push("BEGIN");
    },
    async execute(sql) {
      if (sql.includes("FROM user_sessions"))
        return [[{ role_code: "administrator", password_change_required: 0 }]];
      if (sql.includes("FROM role_permissions"))
        return [
          [
            { code: "reports.read" },
            { code: "warehouses.read" },
            { code: "purchases.read" },
          ],
        ];
      if (sql.includes("FROM user_warehouses")) return [[]];
      throw new Error("Unexpected SQL in empty-scope test");
    },
    async commit() {
      calls.push("COMMIT");
    },
    release() {
      calls.push("RELEASE");
    },
  };
  const service = createPurchaseOrdersService({
    dbPool: { getConnection: async () => connection },
  });
  const result = await service.summarize({
    auth: {
      user: { id: "1", role: "administrator" },
      sessionId: "1",
    },
    mode: "pending",
  });
  assert.equal(result.summary.verifiedOrders, 0);
  assert.ok(calls.includes("SET TRANSACTION READ ONLY"));
  assert.ok(calls.includes("COMMIT"));
  assert.ok(calls.includes("RELEASE"));
});
