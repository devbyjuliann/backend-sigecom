-- MANUAL ROLLBACK ONLY. Do not run through the migration runner.
-- First stop all application instances using migration 0018 and deploy the
-- previous backend version. This guard refuses to discard invitation state.
-- Pending password-recovery links are revoked before their token table is removed.

DROP PROCEDURE IF EXISTS rollback_0018_account_access_email;
DELIMITER //
CREATE PROCEDURE rollback_0018_account_access_email()
BEGIN
  DECLARE pending_invitation_count BIGINT DEFAULT 0;

  SELECT COUNT(*) INTO pending_invitation_count
  FROM users
  WHERE credential_state = 'pending_invitation';

  IF pending_invitation_count > 0 THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Rollback blocked: reconcile pending invitation accounts first.';
  END IF;

  UPDATE account_access_tokens
  SET revoked_at = UTC_TIMESTAMP(3)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

  DROP TABLE account_access_tokens;

  ALTER TABLE users
    DROP INDEX idx_users_credentials_active,
    DROP COLUMN credential_state;
END//
DELIMITER ;

CALL rollback_0018_account_access_email();
DROP PROCEDURE rollback_0018_account_access_email;
