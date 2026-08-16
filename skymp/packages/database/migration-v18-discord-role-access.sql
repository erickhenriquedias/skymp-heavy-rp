-- =============================================================================
-- Migration v18 - Cargo Discord como fonte server-side de whitelist
-- Aplicar apos migration-v17-whitelist-character-link.sql.
-- =============================================================================
USE `skymp_rp`;

ALTER TABLE `whitelist_applications`
  ADD COLUMN IF NOT EXISTS `approval_source` VARCHAR(32) DEFAULT NULL
    COMMENT 'staff, discord_role ou local' AFTER `status`;

UPDATE `whitelist_applications`
   SET approval_source = 'staff'
 WHERE status = 'approved' AND approval_source IS NULL;

CREATE TABLE IF NOT EXISTS `discord_role_access` (
  `account_id` INT NOT NULL,
  `discord_id` VARCHAR(64) NOT NULL,
  `eligible` TINYINT(1) NOT NULL DEFAULT 0,
  `matched_role_id` VARCHAR(64) DEFAULT NULL,
  `verified_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `expires_at` TIMESTAMP NOT NULL,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`account_id`),
  UNIQUE KEY `uq_discord_role_access_identity` (`discord_id`),
  KEY `idx_discord_role_access_expiry` (`eligible`, `expires_at`),
  CONSTRAINT `fk_discord_role_access_account`
    FOREIGN KEY (`account_id`) REFERENCES `accounts` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_discord_role_access_identity`
    FOREIGN KEY (`discord_id`) REFERENCES `discord_identities` (`discord_id`) ON DELETE CASCADE
) ENGINE=InnoDB;
