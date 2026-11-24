export const LOW_STOCK_SQL =
  "ib.id IS NOT NULL AND p.minimum_stock > 0 AND ib.quantity < p.minimum_stock";

export function isLowStock({ hasBalance, quantity, minimumStock }) {
  return (
    hasBalance &&
    Number(minimumStock) > 0 &&
    Number(quantity) < Number(minimumStock)
  );
}

export function stockStatus({ hasBalance, quantity, minimumStock }) {
  if (!hasBalance) return "unregistered";
  if (Number(quantity) === 0) return "exhausted";
  return isLowStock({ hasBalance, quantity, minimumStock })
    ? "low"
    : "available";
}
