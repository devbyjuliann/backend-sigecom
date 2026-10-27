ALTER TABLE inventory_movements
  DROP FOREIGN KEY fk_inventory_movements_balance_version,
  ADD CONSTRAINT fk_inventory_movements_balance
    FOREIGN KEY (product_id, warehouse_id)
    REFERENCES inventory_balances (product_id, warehouse_id) ON DELETE RESTRICT;
