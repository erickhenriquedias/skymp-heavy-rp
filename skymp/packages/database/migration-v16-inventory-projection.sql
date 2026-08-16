-- =============================================================================
-- Migration v16 - Lookup de baseIds gerenciados na projecao de inventario
-- Aplicar depois de migration-v15-economy-framework.sql.
--
-- O login consulta o ledger para distinguir item exclusivamente vanilla de
-- item que ja foi gerenciado pelo MariaDB e hoje tem saldo zero. Sem este
-- indice, personagens antigos fariam scan de todo o proprio historico.
-- =============================================================================
USE `skymp_rp`;

ALTER TABLE `inventory_transactions`
  ADD INDEX IF NOT EXISTS `idx_inv_tx_char_item` (`character_id`, `base_id`);
