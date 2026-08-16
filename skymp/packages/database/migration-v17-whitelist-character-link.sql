-- =============================================================================
-- Migration v17 - Vinculo atomico entre candidatura e personagem
-- Aplicar apos migration-v16-inventory-projection.sql.
-- =============================================================================
USE `skymp_rp`;

ALTER TABLE `whitelist_applications`
  ADD COLUMN IF NOT EXISTS `character_id` INT DEFAULT NULL AFTER `account_id`;

-- Backfill deliberadamente conservador. Nao adivinha qual ficha pertence a
-- qual candidatura quando uma conta possui historico ambiguo.
UPDATE `whitelist_applications` wa
INNER JOIN (
  SELECT account_id, MIN(id) AS application_id
    FROM `whitelist_applications`
   GROUP BY account_id
  HAVING COUNT(*) = 1
) a ON a.application_id = wa.id
INNER JOIN (
  SELECT account_id, MIN(id) AS character_id
    FROM `characters`
   GROUP BY account_id
  HAVING COUNT(*) = 1
) c ON c.account_id = wa.account_id
SET wa.character_id = c.character_id
WHERE wa.character_id IS NULL;

UPDATE `whitelist_applications` wa
INNER JOIN (
  SELECT account_id, MIN(id) AS application_id
    FROM `whitelist_applications`
   WHERE status = 'pending'
   GROUP BY account_id
  HAVING COUNT(*) = 1
) a ON a.application_id = wa.id
INNER JOIN (
  SELECT account_id, MIN(id) AS character_id
    FROM `characters`
   WHERE status = 'pending'
   GROUP BY account_id
  HAVING COUNT(*) = 1
) c ON c.account_id = wa.account_id
SET wa.character_id = c.character_id
WHERE wa.character_id IS NULL;

ALTER TABLE `whitelist_applications`
  ADD UNIQUE INDEX IF NOT EXISTS `uq_whitelist_character` (`character_id`),
  ADD INDEX IF NOT EXISTS `idx_whitelist_account_status_created` (`account_id`, `status`, `created_at`),
  ADD CONSTRAINT `fk_whitelist_character`
    FOREIGN KEY IF NOT EXISTS (`character_id`) REFERENCES `characters` (`id`) ON DELETE SET NULL;
