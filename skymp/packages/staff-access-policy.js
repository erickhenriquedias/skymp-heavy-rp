'use strict';

// Fonte única das permissões administrativas atuais. Nomes são mantidos por
// compatibilidade com os comandos existentes; a migração para nomes de domínio
// do ADR 005 continua sendo uma mudança separada e explícita.
const ROLE_PERMISSIONS = Object.freeze({
  moderator: Object.freeze(['kick', 'teleport', 'view_audit', 'manage_whitelist']),
  admin: Object.freeze([
    'kick', 'teleport', 'view_audit', 'manage_whitelist', 'ban', 'add_item',
    'set_gold', 'retire_character', 'manage_recipes', 'reveal_identity', 'run_world_probe'
  ]),
  owner: Object.freeze([
    'kick', 'teleport', 'view_audit', 'manage_whitelist', 'ban', 'add_item',
    'set_gold', 'manage_staff', 'retire_character', 'manage_recipes',
    'reveal_identity', 'run_world_probe'
  ])
});

function permissionsForRole(role) {
  if (typeof role !== 'string' || !Object.hasOwn(ROLE_PERMISSIONS, role)) return null;
  const permissions = ROLE_PERMISSIONS[role];
  return new Set(permissions);
}

module.exports = { ROLE_PERMISSIONS, permissionsForRole };
