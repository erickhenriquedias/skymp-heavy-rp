-- Schema de Banco de Dados para SkyMP Heavy RP (MySQL/MariaDB)

CREATE DATABASE IF NOT EXISTS `skymp_rp` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE `skymp_rp`;

-- Controle do runner automatico. O checksum impede alterar silenciosamente uma
-- migration que ja foi aplicada em outro ambiente.
CREATE TABLE IF NOT EXISTS `schema_migrations` (
  `version`     INT UNSIGNED NOT NULL,
  `name`        VARCHAR(191) NOT NULL,
  `checksum`    CHAR(64) NOT NULL,
  `duration_ms` INT UNSIGNED NOT NULL,
  `applied_at`  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`version`),
  UNIQUE KEY `uq_schema_migrations_name` (`name`)
) ENGINE=InnoDB;

-- 1. Contas de Jogadores (com suporte a VIP e Monetizacao)
CREATE TABLE IF NOT EXISTS `accounts` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `status` VARCHAR(32) NOT NULL DEFAULT 'active' COMMENT 'active, suspended, banned',
  -- VIP / Apoiador
  `vip_level` INT NOT NULL DEFAULT 0 COMMENT '0: Padrao, 1: Apoiador, 2: VIP Gold, 3: VIP Platinum',
  `vip_expires_at` TIMESTAMP NULL DEFAULT NULL COMMENT 'Data de expiracao do VIP (NULL para permanente ou inativo)',
  `coins` INT NOT NULL DEFAULT 0 COMMENT 'Moedas da loja virtual (adquiridas por doacao)',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- 2. Identidades do Discord (Login via Discord OAuth)
-- NOTA: access_token e refresh_token nao sao armazenados. O fluxo OAuth sempre e
-- redirecionado para o Discord ao expirar a sessao web. Nunca persistir tokens OAuth
-- em texto simples. Se necessario no futuro, usar AES-256-GCM com chave fora do banco.
CREATE TABLE IF NOT EXISTS `discord_identities` (
  `discord_id` VARCHAR(64) PRIMARY KEY,
  `account_id` INT NOT NULL,
  `username` VARCHAR(128) NOT NULL,
  `avatar` VARCHAR(256) DEFAULT NULL,
  `last_login_at` TIMESTAMP NULL DEFAULT NULL COMMENT 'Ultimo login via Discord OAuth',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `fk_discord_account` FOREIGN KEY (`account_id`) REFERENCES `accounts` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

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
  CONSTRAINT `fk_discord_role_access_account` FOREIGN KEY (`account_id`) REFERENCES `accounts` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_discord_role_access_identity` FOREIGN KEY (`discord_id`) REFERENCES `discord_identities` (`discord_id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Sessões de entrada resolvidas uma única vez pelo master. O token e o lease
-- ficam somente como SHA-256; o lease identifica a conexão exata no disconnect.
CREATE TABLE IF NOT EXISTS `game_sessions` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `token_hash` CHAR(64) NOT NULL,
  `account_id` INT NOT NULL,
  `discord_id` VARCHAR(64) NOT NULL,
  `issued_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `expires_at` TIMESTAMP NOT NULL,
  `last_resolved_at` TIMESTAMP NULL DEFAULT NULL,
  `resolve_count` INT NOT NULL DEFAULT 0 COMMENT '0=disponível; 1=consumida pelo master',
  `revoked_at` TIMESTAMP NULL DEFAULT NULL,
  `connection_lease_hash` CHAR(64) NULL COMMENT 'SHA-256 do lease da conexão atual',
  `connected_at` DATETIME(6) NULL,
  `disconnected_at` DATETIME(6) NULL,
  UNIQUE KEY `uq_game_session_hash` (`token_hash`),
  UNIQUE KEY `uq_game_session_connection_lease` (`connection_lease_hash`),
  KEY `idx_game_session_account` (`account_id`, `expires_at`),
  KEY `idx_game_session_expiry` (`expires_at`),
  CONSTRAINT `fk_game_session_account` FOREIGN KEY (`account_id`) REFERENCES `accounts` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 3. Formulários de Whitelist
CREATE TABLE IF NOT EXISTS `whitelist_applications` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `account_id` INT NOT NULL,
  `character_id` INT DEFAULT NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'pending' COMMENT 'pending, approved, rejected',
  `approval_source` VARCHAR(32) DEFAULT NULL COMMENT 'staff, discord_role ou local',
  `reviewed_by` VARCHAR(128) DEFAULT NULL,
  `reviewer_notes` TEXT DEFAULT NULL,
  `reviewed_at` TIMESTAMP NULL DEFAULT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uq_whitelist_character` (`character_id`),
  KEY `idx_whitelist_account_status_created` (`account_id`, `status`, `created_at`),
  CONSTRAINT `fk_whitelist_account` FOREIGN KEY (`account_id`) REFERENCES `accounts` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 4. Fichas de Personagem do Skyrim
CREATE TABLE IF NOT EXISTS `characters` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `account_id` INT NOT NULL,
  `first_name` VARCHAR(64) NOT NULL,
  `last_name` VARCHAR(64) NOT NULL,
  `biography` TEXT DEFAULT NULL,
  `motivations` TEXT DEFAULT NULL COMMENT 'Objetivos do personagem em jogo (rubrica de whitelist Heavy RP)',
  `weaknesses` TEXT DEFAULT NULL COMMENT 'Falhas/limites do personagem (rubrica de whitelist Heavy RP)',
  `social_ties` TEXT DEFAULT NULL COMMENT 'Laços sociais/relações pretendidas (rubrica de whitelist Heavy RP)',
  `needs_extra_review` TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'Conceito forte (nobre, mago poderoso, vampiro, lobisomem, lider de faccao) — exige aprovacao extra da staff antes de approved',
  `extra_review_notes` TEXT DEFAULT NULL COMMENT 'Notas da staff sobre a revisao extra do conceito',
  -- Coordenadas de Logout (Default: The Bannered Mare Whiterun)
  `pos_x` FLOAT NOT NULL DEFAULT 35.0,
  `pos_y` FLOAT NOT NULL DEFAULT -165.0,
  `pos_z` FLOAT NOT NULL DEFAULT -189.0,
  `angle_z` FLOAT NOT NULL DEFAULT 180.0,
  `cell_id` VARCHAR(64) NOT NULL DEFAULT '0x162e2',
  `gold` INT NOT NULL DEFAULT 0 COMMENT 'Economia in-game (Septims)',
  `status` VARCHAR(32) NOT NULL DEFAULT 'pending' COMMENT 'pending, approved, rejected, retired (soft-delete, ver admin-service.retireCharacter)',
  `racemenu_presets` TEXT DEFAULT NULL COMMENT 'JSON string contendo presets de aparencia',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `fk_character_account` FOREIGN KEY (`account_id`) REFERENCES `accounts` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 4.1. Inventário Persistente do Personagem
CREATE TABLE IF NOT EXISTS `character_known_identities` (
  `observer_character_id` INT NOT NULL,
  `target_character_id` INT NOT NULL,
  `display_name` VARCHAR(64) NOT NULL,
  `source` VARCHAR(32) NOT NULL DEFAULT 'introduced' COMMENT 'introduced, alias, staff, disguise',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`observer_character_id`, `target_character_id`),
  CONSTRAINT `fk_known_observer` FOREIGN KEY (`observer_character_id`) REFERENCES `characters` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_known_target` FOREIGN KEY (`target_character_id`) REFERENCES `characters` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 4.2. Inventario Persistente do Personagem
CREATE TABLE IF NOT EXISTS `character_inventory` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `character_id` INT NOT NULL,
  `base_id` INT NOT NULL COMMENT 'FormID nativo do Skyrim (Decimal)',
  `count` INT NOT NULL DEFAULT 1,
  CONSTRAINT `fk_inventory_character` FOREIGN KEY (`character_id`) REFERENCES `characters` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 5. Containers Persistentes (Baús controlados pelo servidor)
CREATE TABLE IF NOT EXISTS `containers` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `object_id` VARCHAR(64) NOT NULL UNIQUE COMMENT 'formDesc do objeto no mundo (ex: 0x3003A:Skyrim.esm)',
  `owner_character_id` INT DEFAULT NULL COMMENT 'Personagem dono do container',
  `label` VARCHAR(128) DEFAULT NULL COMMENT 'Etiqueta customizada do baú',
  `is_locked` TINYINT(1) NOT NULL DEFAULT 0,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `fk_container_owner` FOREIGN KEY (`owner_character_id`) REFERENCES `characters` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB;

-- 5.1. Inventário dos Containers
CREATE TABLE IF NOT EXISTS `container_inventory` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `container_id` INT NOT NULL,
  `base_id` INT NOT NULL COMMENT 'FormID nativo do Skyrim (Decimal)',
  `count` INT NOT NULL DEFAULT 1,
  CONSTRAINT `fk_container_inv` FOREIGN KEY (`container_id`) REFERENCES `containers` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 6. Propriedades e Imóveis
CREATE TABLE IF NOT EXISTS `properties` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `name` VARCHAR(128) NOT NULL COMMENT 'Nome do imóvel (ex: Casa em Whiterun 12)',
  `owner_character_id` INT DEFAULT NULL,
  `container_id` INT DEFAULT NULL COMMENT 'Container principal da propriedade',
  `door_form_desc` VARCHAR(64) DEFAULT NULL COMMENT 'formDesc da porta de entrada',
  `price_gold` INT NOT NULL DEFAULT 0 COMMENT 'Valor de aluguel/compra em Septims',
  `is_for_sale` TINYINT(1) NOT NULL DEFAULT 0,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `fk_property_owner` FOREIGN KEY (`owner_character_id`) REFERENCES `characters` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_property_container` FOREIGN KEY (`container_id`) REFERENCES `containers` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB;

-- 6.1. Acesso de Convidados a Propriedades
CREATE TABLE IF NOT EXISTS `property_guests` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `property_id` INT NOT NULL,
  `guest_character_id` INT NOT NULL,
  `granted_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `fk_guest_property` FOREIGN KEY (`property_id`) REFERENCES `properties` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_guest_character` FOREIGN KEY (`guest_character_id`) REFERENCES `characters` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 5. Compras e Resgates da Loja de Apoiador
CREATE TABLE IF NOT EXISTS `store_purchases` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `account_id` INT NOT NULL,
  `item_type` VARCHAR(64) NOT NULL COMMENT 'cosmetic, slot, vip_subscription, custom_housing',
  `item_name` VARCHAR(128) NOT NULL,
  `cost_coins` INT NOT NULL DEFAULT 0,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `fk_store_account` FOREIGN KEY (`account_id`) REFERENCES `accounts` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 6. Logs de Auditoria e Staff
CREATE TABLE IF NOT EXISTS `audit_logs` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `action` VARCHAR(128) NOT NULL,
  `actor_account_id` INT DEFAULT NULL,
  `target_account_id` INT DEFAULT NULL,
  `details` TEXT DEFAULT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- 7. Fichas Criminais (Criminal Record)
CREATE TABLE IF NOT EXISTS `criminal_records` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `character_id` INT NOT NULL,
  `crime` VARCHAR(128) NOT NULL COMMENT 'Assassinato, Roubo, Agressao, Perturbacao...',
  `bounty` INT NOT NULL DEFAULT 0 COMMENT 'Valor da recompensa em Septims',
  `hold` VARCHAR(64) NOT NULL DEFAULT 'whiterun' COMMENT 'Hold onde o crime foi cometido',
  `witness_character_id` INT DEFAULT NULL COMMENT 'Guardia ou testemunha que registrou',
  `resolved` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '0=Ativo, 1=Pago/Cumprido',
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `fk_crime_character` FOREIGN KEY (`character_id`) REFERENCES `characters` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 8. Registro de Prisoes Ativas e Historico
CREATE TABLE IF NOT EXISTS `prison_records` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `character_id` INT NOT NULL,
  `arrested_by_character_id` INT DEFAULT NULL COMMENT 'Guardia que prendeu',
  `crime_summary` TEXT DEFAULT NULL,
  `sentence_minutes` INT NOT NULL DEFAULT 10 COMMENT 'Tempo de pena em minutos in-game',
  `time_served_minutes` INT NOT NULL DEFAULT 0,
  `status` VARCHAR(32) NOT NULL DEFAULT 'active' COMMENT 'active, released, escaped',
  `cell_id` VARCHAR(64) NOT NULL DEFAULT '0x162e2' COMMENT 'Celula da prisao',
  `arrested_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `released_at` TIMESTAMP NULL DEFAULT NULL,
  CONSTRAINT `fk_prison_character` FOREIGN KEY (`character_id`) REFERENCES `characters` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 8.1. Estado Atual de Algemas (Restraints)
CREATE TABLE IF NOT EXISTS `character_restraints` (
  `character_id` INT PRIMARY KEY,
  `restrained_by_character_id` INT DEFAULT NULL,
  `type` VARCHAR(32) NOT NULL DEFAULT 'handcuffs' COMMENT 'handcuffs, rope',
  `applied_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `fk_restraint_character` FOREIGN KEY (`character_id`) REFERENCES `characters` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ═══════════════════════════════════════════════════
-- FASE BETA - Sobrevivência, Economia Regional, Crafting, Facções
-- ═══════════════════════════════════════════════════

-- 9. Status de Sobrevivência do Personagem
CREATE TABLE IF NOT EXISTS `character_survival` (
  `character_id` INT PRIMARY KEY,
  `hunger`       FLOAT NOT NULL DEFAULT 100.0 COMMENT '0=Morrendo de fome, 100=Satisfeito',
  `thirst`       FLOAT NOT NULL DEFAULT 100.0 COMMENT '0=Desidratado, 100=Hidratado',
  `fatigue`      FLOAT NOT NULL DEFAULT 100.0 COMMENT '0=Exausto, 100=Descansado',
  `updated_at`   TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `fk_survival_character` FOREIGN KEY (`character_id`) REFERENCES `characters` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 10. Holds (Regiões) e sua Economia
CREATE TABLE IF NOT EXISTS `holds` (
  `id`           VARCHAR(32) PRIMARY KEY COMMENT 'whiterun, solitude, riften, windhelm, markarth, falkreath, morthal, dawnstar, winterhold',
  `name`         VARCHAR(64) NOT NULL,
  `tax_rate`     FLOAT NOT NULL DEFAULT 0.05 COMMENT 'Taxa sobre vendas (0.05 = 5%)',
  `treasury`     INT NOT NULL DEFAULT 0 COMMENT 'Ouro acumulado em impostos',
  `ruling_faction_id` INT DEFAULT NULL COMMENT 'Facção que controla o Hold'
) ENGINE=InnoDB;

-- 10.1. Preços de Mercado Regionais (Oferta & Demanda)
CREATE TABLE IF NOT EXISTS `market_prices` (
  `id`           INT AUTO_INCREMENT PRIMARY KEY,
  `hold_id`      VARCHAR(32) NOT NULL,
  `base_id`      INT NOT NULL COMMENT 'FormID do item',
  `buy_price`    INT NOT NULL DEFAULT 10 COMMENT 'Preco de compra do jogador',
  `sell_price`   INT NOT NULL DEFAULT 7  COMMENT 'Preco de venda do jogador',
  `stock`        INT NOT NULL DEFAULT 100 COMMENT 'Estoque disponivel (oferta)',
  `updated_at`   TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_hold_item` (`hold_id`, `base_id`),
  CONSTRAINT `fk_market_hold` FOREIGN KEY (`hold_id`) REFERENCES `holds` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `regional_market_transactions` (
  `transaction_id` CHAR(36) NOT NULL PRIMARY KEY,
  `idempotency_key` VARCHAR(64) NOT NULL,
  `actor_character_id` INT NOT NULL,
  `hold_id` VARCHAR(32) NOT NULL,
  `direction` ENUM('buy', 'sell') NOT NULL,
  `base_id` INT NOT NULL,
  `count` INT NOT NULL,
  `unit_price` INT NOT NULL,
  `gross_amount` INT NOT NULL,
  `tax_amount` INT NOT NULL DEFAULT 0,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uq_regional_market_idempotency` (`idempotency_key`),
  KEY `idx_regional_market_hold_date` (`hold_id`, `created_at`),
  KEY `idx_regional_market_character_date` (`actor_character_id`, `created_at`),
  CONSTRAINT `fk_regional_market_character` FOREIGN KEY (`actor_character_id`) REFERENCES `characters` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_regional_market_hold` FOREIGN KEY (`hold_id`) REFERENCES `holds` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB;

-- 10.2. Rotas Comerciais entre Holds
CREATE TABLE IF NOT EXISTS `trade_routes` (
  `id`           INT AUTO_INCREMENT PRIMARY KEY,
  `from_hold`    VARCHAR(32) NOT NULL,
  `to_hold`      VARCHAR(32) NOT NULL,
  `bonus_pct`    FLOAT NOT NULL DEFAULT 0.15 COMMENT 'Bônus de lucro ao vender em outro Hold',
  `is_active`    TINYINT(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB;

-- 11. Receitas de Crafting
CREATE TABLE IF NOT EXISTS `crafting_recipes` (
  `id`           INT AUTO_INCREMENT PRIMARY KEY,
  `name`         VARCHAR(128) NOT NULL,
  `station_type` VARCHAR(64)  NOT NULL COMMENT 'forge, cooking_pot, tanning_rack, alchemy_lab, enchanting_table',
  `result_base_id` INT NOT NULL COMMENT 'FormID do item resultante',
  `result_count`   INT NOT NULL DEFAULT 1,
  `requires_perk`  VARCHAR(64) DEFAULT NULL COMMENT 'Nome do perk necessario',
  `created_at`   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- 11.1. Ingredientes das Receitas
CREATE TABLE IF NOT EXISTS `crafting_ingredients` (
  `id`           INT AUTO_INCREMENT PRIMARY KEY,
  `recipe_id`    INT NOT NULL,
  `base_id`      INT NOT NULL COMMENT 'FormID do ingrediente',
  `count`        INT NOT NULL DEFAULT 1,
  CONSTRAINT `fk_ingredient_recipe` FOREIGN KEY (`recipe_id`) REFERENCES `crafting_recipes` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 12. Facções e Territórios
CREATE TABLE IF NOT EXISTS `factions` (
  `id`           INT AUTO_INCREMENT PRIMARY KEY,
  `tag`          VARCHAR(16) NOT NULL UNIQUE COMMENT 'Ex: [COMP], [GUARDIA]',
  `name`         VARCHAR(128) NOT NULL,
  `description`  TEXT DEFAULT NULL,
  `color_hex`    VARCHAR(7) NOT NULL DEFAULT '#ffffff',
  `leader_character_id` INT DEFAULT NULL,
  `treasury`     INT NOT NULL DEFAULT 0,
  `created_at`   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `fk_faction_leader` FOREIGN KEY (`leader_character_id`) REFERENCES `characters` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB;

-- 12.0. Ledger de tesouros institucionais (Hold <-> Facção)
CREATE TABLE IF NOT EXISTS `institutional_treasury_transactions` (
  `transfer_id` CHAR(36) NOT NULL PRIMARY KEY,
  `idempotency_key` VARCHAR(64) NOT NULL,
  `actor_character_id` INT NOT NULL,
  `hold_id` VARCHAR(32) NOT NULL,
  `faction_id` INT NOT NULL,
  `amount` INT NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uq_institutional_treasury_idempotency` (`idempotency_key`),
  KEY `idx_institutional_treasury_hold_date` (`hold_id`, `created_at`),
  KEY `idx_institutional_treasury_faction_date` (`faction_id`, `created_at`),
  CONSTRAINT `fk_institutional_treasury_actor` FOREIGN KEY (`actor_character_id`) REFERENCES `characters` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_institutional_treasury_hold` FOREIGN KEY (`hold_id`) REFERENCES `holds` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_institutional_treasury_faction` FOREIGN KEY (`faction_id`) REFERENCES `factions` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB;

-- 12.1. Membros de Facções
CREATE TABLE IF NOT EXISTS `faction_members` (
  `id`           INT AUTO_INCREMENT PRIMARY KEY,
  `faction_id`   INT NOT NULL,
  `character_id` INT NOT NULL,
  `rank`         VARCHAR(64) NOT NULL DEFAULT 'recruit',
  `joined_at`    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_char_faction` (`character_id`, `faction_id`),
  CONSTRAINT `fk_member_faction`   FOREIGN KEY (`faction_id`)   REFERENCES `factions`   (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_member_character` FOREIGN KEY (`character_id`) REFERENCES `characters` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ── Seed: Holds iniciais ─────────────────────────────────────────────────────
-- Mapeamento correto: ID = slug do hold, name = nome do hold (nao da cidade)
-- Cidade principal → Hold: Whiterun→Whiterun Hold, Solitude→Haafingar,
-- Riften→The Rift, Windhelm→Eastmarch, Markarth→The Reach,
-- Falkreath→Falkreath Hold, Morthal→Hjaalmarch, Dawnstar→The Pale, Winterhold→Winterhold
INSERT IGNORE INTO `holds` (`id`, `name`, `tax_rate`) VALUES
  ('whiterun',    'Whiterun Hold',        0.05),
  ('solitude',    'Haafingar',            0.07),
  ('riften',      'The Rift',             0.06),
  ('windhelm',    'Eastmarch',            0.05),
  ('markarth',    'The Reach',            0.08),
  ('falkreath',   'Falkreath Hold',       0.04),
  ('morthal',     'Hjaalmarch',           0.04),
  ('dawnstar',    'The Pale',             0.05),
  ('winterhold',  'Winterhold',           0.03);

-- ═══════════════════════════════════════════════════
-- AUTORIDADE ADMINISTRATIVA — Staff separado de VIP/Apoiador
-- ═══════════════════════════════════════════════════

-- A. Papéis de Staff (separados do vip_level)
-- vip_level na tabela accounts e APENAS para monetizacao (0-3).
-- Poder administrativo NUNCA deriva de vip_level.
CREATE TABLE IF NOT EXISTS `staff_roles` (
  `id`                    INT AUTO_INCREMENT PRIMARY KEY,
  `account_id`            INT NOT NULL UNIQUE,
  `role`                  VARCHAR(32) NOT NULL COMMENT 'moderator, admin, owner',
  `granted_by_account_id` INT DEFAULT NULL COMMENT 'Quem concedeu o cargo',
  `notes`                 VARCHAR(256) DEFAULT NULL,
  `granted_at`            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `fk_staff_account`  FOREIGN KEY (`account_id`) REFERENCES `accounts` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_staff_grantor` FOREIGN KEY (`granted_by_account_id`) REFERENCES `accounts` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB;

-- B. Permissoes granulares por cargo (para controle futuro fino)
CREATE TABLE IF NOT EXISTS `staff_permissions` (
  `id`            INT AUTO_INCREMENT PRIMARY KEY,
  `staff_role_id` INT NOT NULL,
  `permission`    VARCHAR(64) NOT NULL COMMENT 'kick, ban, teleport, add_item, set_gold, view_audit, manage_whitelist',
  UNIQUE KEY `uk_role_perm` (`staff_role_id`, `permission`),
  CONSTRAINT `fk_perm_role` FOREIGN KEY (`staff_role_id`) REFERENCES `staff_roles` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ── Seed: Permissões padrão por cargo ────────────────────────────────────────
-- Inseridas depois que os registros de staff_roles existirem (via aplicação).
-- Referência: moderator=[kick,teleport,view_audit], admin=[+ban,add_item,set_gold], owner=[todos]

-- ═══════════════════════════════════════════════════
-- LEDGER FINANCEIRO — Transações auditáveis de inventário e ouro
-- ═══════════════════════════════════════════════════

-- C. Ledger de Inventário
-- Toda mudança de item passa por aqui. Nunca modificar character_inventory diretamente.
CREATE TABLE IF NOT EXISTS `inventory_transactions` (
  `transaction_id`   CHAR(36)     NOT NULL PRIMARY KEY COMMENT 'UUID v4',
  `character_id`     INT          NOT NULL,
  `base_id`          INT          NOT NULL COMMENT 'FormID nativo do Skyrim',
  `delta`            INT          NOT NULL COMMENT 'Positivo = ganhou, Negativo = perdeu',
  `reason`           VARCHAR(64)  NOT NULL COMMENT 'woodcutting, admin_give, trade, craft, loot...',
  `module`           VARCHAR(32)  NOT NULL COMMENT 'Modulo que originou a transacao',
  `idempotency_key`  VARCHAR(128) DEFAULT NULL UNIQUE COMMENT 'Previne duplicatas em retries',
  `status`           VARCHAR(16)  NOT NULL DEFAULT 'committed' COMMENT 'committed, rolled_back',
  `created_at`       TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `fk_inv_tx_char` FOREIGN KEY (`character_id`) REFERENCES `characters` (`id`) ON DELETE CASCADE,
  INDEX `idx_inv_tx_char_date` (`character_id`, `created_at`),
  INDEX `idx_inv_tx_char_item` (`character_id`, `base_id`)
) ENGINE=InnoDB;

-- D. Ledger de Ouro
CREATE TABLE IF NOT EXISTS `gold_transactions` (
  `transaction_id`   CHAR(36)     NOT NULL PRIMARY KEY COMMENT 'UUID v4',
  `character_id`     INT          NOT NULL,
  `delta`            INT          NOT NULL COMMENT 'Positivo = ganhou, Negativo = perdeu',
  `reason`           VARCHAR(64)  NOT NULL,
  `module`           VARCHAR(32)  NOT NULL,
  `idempotency_key`  VARCHAR(128) DEFAULT NULL UNIQUE,
  `status`           VARCHAR(16)  NOT NULL DEFAULT 'committed',
  `created_at`       TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `fk_gold_tx_char` FOREIGN KEY (`character_id`) REFERENCES `characters` (`id`) ON DELETE CASCADE,
  INDEX `idx_gold_tx_char_date` (`character_id`, `created_at`)
) ENGINE=InnoDB;

-- ═══════════════════════════════════════════════════
-- SISTEMAS ESTACIONADOS — Cavalos, Disfarces, Magia, Doenças
-- ═══════════════════════════════════════════════════

-- 13. Cavalos Persistentes
CREATE TABLE IF NOT EXISTS `horses` (
  `id`             INT AUTO_INCREMENT PRIMARY KEY,
  `name`           VARCHAR(64)  NOT NULL DEFAULT 'Cavalo',
  `base_id`        INT          NOT NULL COMMENT 'FormID da raça (ex: 0x00067C43)',
  `owner_character_id` INT DEFAULT NULL,
  `health`         FLOAT NOT NULL DEFAULT 500.0,
  `speed_bonus`    FLOAT NOT NULL DEFAULT 0.0  COMMENT 'Bônus de velocidade treinada',
  `last_pos_x`     FLOAT DEFAULT NULL,
  `last_pos_y`     FLOAT DEFAULT NULL,
  `last_pos_z`     FLOAT DEFAULT NULL,
  `last_cell`      VARCHAR(64) DEFAULT NULL,
  `for_sale`       TINYINT(1) NOT NULL DEFAULT 0,
  `sale_price`     INT NOT NULL DEFAULT 0,
  `created_at`     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `fk_horse_owner` FOREIGN KEY (`owner_character_id`) REFERENCES `characters` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB;

-- 14. Disfarces e Identidades Falsas
CREATE TABLE IF NOT EXISTS `disguises` (
  `id`             INT AUTO_INCREMENT PRIMARY KEY,
  `character_id`   INT NOT NULL,
  `fake_name`      VARCHAR(128) NOT NULL,
  `fake_faction_id` INT DEFAULT NULL  COMMENT 'Facção fingida',
  `is_active`      TINYINT(1) NOT NULL DEFAULT 0,
  `detection_roll` INT NOT NULL DEFAULT 15  COMMENT 'DC de Percepção para detectar (1-20)',
  `created_at`     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_char_disguise` (`character_id`),
  CONSTRAINT `fk_disguise_char` FOREIGN KEY (`character_id`) REFERENCES `characters` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 15. Licenças de Magia (Spells Aprovados para RP)
CREATE TABLE IF NOT EXISTS `magic_licenses` (
  `id`             INT AUTO_INCREMENT PRIMARY KEY,
  `character_id`   INT NOT NULL,
  `spell_name`     VARCHAR(128) NOT NULL,
  `spell_base_id`  INT NOT NULL  COMMENT 'FormID do feitiço',
  `school`         VARCHAR(32) NOT NULL DEFAULT 'alteration' COMMENT 'alteration, conjuration, destruction, illusion, restoration',
  `level`          VARCHAR(16) NOT NULL DEFAULT 'novice' COMMENT 'novice, apprentice, adept, expert, master',
  `granted_by_character_id` INT DEFAULT NULL,
  `narrative_justification` TEXT DEFAULT NULL,
  `granted_at`     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `fk_magic_char` FOREIGN KEY (`character_id`) REFERENCES `characters` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 15.1. Usos de Magia Não Autorizada (para audit)
CREATE TABLE IF NOT EXISTS `magic_violations` (
  `id`             INT AUTO_INCREMENT PRIMARY KEY,
  `character_id`   INT NOT NULL,
  `spell_base_id`  INT NOT NULL,
  `location`       VARCHAR(64) DEFAULT NULL,
  `detected_at`    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `fk_violation_char` FOREIGN KEY (`character_id`) REFERENCES `characters` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 16. Doenças Persistentes
CREATE TABLE IF NOT EXISTS `character_diseases` (
  `id`             INT AUTO_INCREMENT PRIMARY KEY,
  `character_id`   INT NOT NULL,
  `disease`        VARCHAR(64)  NOT NULL COMMENT 'rockjoint, ataxia, brain_rot, witbane, rattles, vampirism_stage1',
  `severity`       INT NOT NULL DEFAULT 1  COMMENT '1=Leve, 2=Moderada, 3=Grave',
  `contracted_at`  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `cured_at`       TIMESTAMP NULL DEFAULT NULL,
  `is_active`      TINYINT(1) NOT NULL DEFAULT 1,
  CONSTRAINT `fk_disease_char` FOREIGN KEY (`character_id`) REFERENCES `characters` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 17. Afinidade da Alma (soul-service)
-- Desenho: docs/design/SOUL_AFFINITY.md. Detalhes de cada decisao de modelagem
-- estao em migration-v10-soul.sql, que cria estas mesmas quatro tabelas em banco
-- ja existente.

-- 17.1. A alma: sete valores derivados da ficha aprovada, mais a semente.
-- SENSIVEL: `soul_seed` nunca sai do servidor (ver §III.3).
CREATE TABLE IF NOT EXISTS `character_soul` (
  `character_id`  INT NOT NULL PRIMARY KEY,
  `soul_seed`     CHAR(64) NOT NULL COMMENT 'HMAC hex. SENSIVEL: nunca sai do servidor',
  `arcana`        TINYINT UNSIGNED NOT NULL COMMENT '0-100. As quatro afinidades somam 200',
  `divina`        TINYINT UNSIGNED NOT NULL,
  `sombria`       TINYINT UNSIGNED NOT NULL,
  `bestial`       TINYINT UNSIGNED NOT NULL,
  `vontade`       TINYINT UNSIGNED NOT NULL COMMENT '0-100. Os tres tracos somam 150',
  `sensibilidade` TINYINT UNSIGNED NOT NULL,
  `estabilidade`  TINYINT UNSIGNED NOT NULL,
  `created_at`    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `fk_soul_character` FOREIGN KEY (`character_id`) REFERENCES `characters` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 17.2. Sinais: o primeiro sai no primeiro spawn, pra que a primeira sessao nao
-- seja vazia. `sign_key` e chave de catalogo, nunca texto do jogador.
CREATE TABLE IF NOT EXISTS `character_signs` (
  `id`           INT AUTO_INCREMENT PRIMARY KEY,
  `character_id` INT NOT NULL,
  `sign_key`     VARCHAR(64) NOT NULL COMMENT 'Chave do catalogo em soul-service.js',
  `source`       VARCHAR(32) NOT NULL DEFAULT 'first_spawn' COMMENT 'first_spawn, event, ritual',
  `revealed_at`  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_sign_character_key` (`character_id`, `sign_key`),
  CONSTRAINT `fk_sign_character` FOREIGN KEY (`character_id`) REFERENCES `characters` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 17.3. Marcas: sao a progressao. Marca nunca e removida, no maximo coberta —
-- por isso nao ha `removed_at` nem status.
CREATE TABLE IF NOT EXISTS `character_marks` (
  `id`              INT AUTO_INCREMENT PRIMARY KEY,
  `character_id`    INT NOT NULL,
  `kind`            VARCHAR(16) NOT NULL COMMENT 'fisica, espiritual, social',
  `visibility`      VARCHAR(16) NOT NULL COMMENT 'visivel, sentida, conhecida',
  `descriptor`      VARCHAR(64) NOT NULL COMMENT 'Chave do catalogo em soul-service.js',
  `origin_event_id` VARCHAR(128) DEFAULT NULL COMMENT 'Rastro ate a linha soul:resolve em audit_logs',
  `created_at`      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY `idx_marks_character` (`character_id`),
  CONSTRAINT `fk_mark_character` FOREIGN KEY (`character_id`) REFERENCES `characters` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 17.4. Arvore de Transformacao: maquina de estados irma de
-- core/character-state.js, separada dela de proposito (segundos vs meses).
-- `consented_at` obrigatorio em no irreversivel (SOUL_AFFINITY §14.2).
CREATE TABLE IF NOT EXISTS `character_paths` (
  `id`           INT AUTO_INCREMENT PRIMARY KEY,
  `character_id` INT NOT NULL,
  `tree`         VARCHAR(16) NOT NULL COMMENT 'arcana, divina, sombria, bestial',
  `node`         VARCHAR(32) NOT NULL,
  `entered_at`   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `consented_at` TIMESTAMP NULL DEFAULT NULL COMMENT 'Obrigatorio em no irreversivel',
  `metadata`     TEXT DEFAULT NULL COMMENT 'JSON',
  UNIQUE KEY `uk_path_character_tree` (`character_id`, `tree`),
  CONSTRAINT `fk_path_character` FOREIGN KEY (`character_id`) REFERENCES `characters` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;
