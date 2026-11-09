import { createInventoryReportsService } from "./inventory-analytics-service.js";

export function createInventoryAnalyticsApiService({ dbPool }) {
  const analytics = createInventoryReportsService({ dbPool });

  async function withReadTransaction(operation) {
    const connection = await dbPool.getConnection();
    try {
      await connection.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      await connection.query("SET TRANSACTION READ ONLY");
      await connection.beginTransaction();
      const result = await operation(connection);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async function balances({ auth, ...filters }) {
    return withReadTransaction(async (connection) => {
      const result = await analytics.currentStock({
        auth,
        connection,
        ...filters,
      });
      return {
        ...result,
        view: "balances",
        criteria: {
          warehouseId: filters.warehouseId ?? null,
          unit: filters.unit ?? null,
          status: filters.status ?? null,
          productStatus: filters.productStatus ?? null,
          page: filters.page ?? 1,
          pageSize: filters.pageSize ?? 20,
          scope: result.coverage.scope ?? "assigned_warehouses",
          observationUnit: "product_warehouse_pairs",
          temporalClarification:
            "Las existencias representan cantidades actuales verificables y no corresponden a un cierre histórico.",
        },
      };
    });
  }

  async function movements({ auth, ...filters }) {
    return withReadTransaction(async (connection) => {
      const result = await analytics.periodActivity({
        auth,
        connection,
        ...filters,
      });
      return {
        ...result,
        view: "movements",
        criteria: {
          ...result.criteria,
          warehouseId: filters.warehouseId ?? null,
          unit: filters.unit ?? null,
          operationType: filters.operationType ?? null,
          direction: filters.direction ?? null,
          page: filters.page ?? 1,
          pageSize: filters.pageSize ?? 20,
          scope: result.coverage.scope ?? "assigned_warehouses",
          observationUnits: {
            candidates: "movements",
            operations: "transfer_operations",
            groups: "warehouse_operation_type_unit",
          },
        },
      };
    });
  }

  async function warehouses({ auth, view, ...filters }) {
    return withReadTransaction(async (connection) => ({
      view,
      ...(await analytics.listAuthorizedWarehouses({
        auth,
        view,
        connection,
        ...filters,
      })),
    }));
  }

  return { balances, movements, warehouses };
}
