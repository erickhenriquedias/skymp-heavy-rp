-- =============================================================================
-- Migration v19 - Lease exato por conexão de jogo
-- Aplicar após migration-v18-discord-role-access.sql.
--
-- O token do lease nunca é persistido em claro. Seu hash liga o disconnect à
-- sessão exata e impede que um evento atrasado da conexão anterior revogue o
-- reconnect novo da mesma conta.
-- =============================================================================
USE `skymp_rp`;

ALTER TABLE `game_sessions`
  ADD COLUMN IF NOT EXISTS `connection_lease_hash` CHAR(64) NULL
    COMMENT 'SHA-256 do lease entregue somente ao gamemode' AFTER `revoked_at`,
  ADD COLUMN IF NOT EXISTS `connected_at` DATETIME(6) NULL
    COMMENT 'Momento em que o gamemode reivindicou esta sessão' AFTER `connection_lease_hash`,
  ADD COLUMN IF NOT EXISTS `disconnected_at` DATETIME(6) NULL
    COMMENT 'Momento em que o lease exato foi liberado' AFTER `connected_at`;

ALTER TABLE `game_sessions`
  ADD UNIQUE INDEX IF NOT EXISTS `uq_game_session_connection_lease` (`connection_lease_hash`);
