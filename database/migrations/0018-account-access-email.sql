ALTER TABLE users
  ADD COLUMN credential_state ENUM('active', 'pending_invitation')
    NOT NULL DEFAULT 'active' AFTER is_active,
  ADD KEY idx_users_credentials_active (is_active, credential_state, id);

CREATE TABLE account_access_tokens (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  purpose VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  consumed_at DATETIME(3) NULL,
  revoked_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_account_access_tokens_hash (token_hash),
  KEY idx_account_access_tokens_user_state
    (user_id, purpose, consumed_at, revoked_at, expires_at),
  CONSTRAINT fk_account_access_tokens_user
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT chk_account_access_tokens_purpose
    CHECK (purpose = 'password_recovery'),
  CONSTRAINT chk_account_access_tokens_hash
    CHECK (token_hash REGEXP '^[0-9a-f]{64}$'),
  CONSTRAINT chk_account_access_tokens_state
    CHECK (consumed_at IS NULL OR revoked_at IS NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
