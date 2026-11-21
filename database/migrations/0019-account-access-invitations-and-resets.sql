ALTER TABLE users
  MODIFY COLUMN credential_state
    ENUM('active', 'pending_invitation', 'pending_admin_reset')
    NOT NULL DEFAULT 'active';

ALTER TABLE account_access_tokens
  DROP CONSTRAINT chk_account_access_tokens_purpose,
  ADD CONSTRAINT chk_account_access_tokens_purpose
    CHECK (purpose IN (
      'password_recovery',
      'account_invitation',
      'admin_password_reset'
    ));
