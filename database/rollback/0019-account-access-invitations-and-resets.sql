-- MANUAL ROLLBACK ONLY. Do not run through the migration runner.
-- This guard refuses to discard accounts awaiting an administrative reset.

DROP PROCEDURE IF EXISTS rollback_0019_account_access_extensions;
DELIMITER //
CREATE PROCEDURE rollback_0019_account_access_extensions()
BEGIN
  DECLARE pending_reset_count BIGINT DEFAULT 0;

  SELECT COUNT(*) INTO pending_reset_count
  FROM users
  WHERE credential_state = 'pending_admin_reset';

  IF pending_reset_count > 0 THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Rollback blocked: resolve pending administrator resets first.';
  END IF;

  UPDATE account_access_tokens
  SET revoked_at = UTC_TIMESTAMP(3)
  WHERE purpose IN ('account_invitation', 'admin_password_reset')
    AND consumed_at IS NULL AND revoked_at IS NULL;

  ALTER TABLE account_access_tokens
    DROP CONSTRAINT chk_account_access_tokens_purpose,
    ADD CONSTRAINT chk_account_access_tokens_purpose
      CHECK (purpose = 'password_recovery');

  ALTER TABLE users
    MODIFY COLUMN credential_state
      ENUM('active', 'pending_invitation')
      NOT NULL DEFAULT 'active';
END//
DELIMITER ;

CALL rollback_0019_account_access_extensions();
DROP PROCEDURE rollback_0019_account_access_extensions;
