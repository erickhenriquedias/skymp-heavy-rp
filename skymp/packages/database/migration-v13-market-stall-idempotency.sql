-- v13 - Idempotencia de compra em barracas de jogadores
USE `skymp_rp`;

ALTER TABLE `market_stall_sales`
  ADD COLUMN IF NOT EXISTS `idempotency_key` VARCHAR(64) NULL AFTER `city_id`,
  ADD UNIQUE KEY IF NOT EXISTS `uq_market_stall_sales_idempotency` (`idempotency_key`);
