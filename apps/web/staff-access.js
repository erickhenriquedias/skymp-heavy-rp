'use strict';

// O painel não deriva poder de vip_level, Discord ou campos enviados pela UI.
const {
  ROLE_PERMISSIONS,
  permissionsForRole
} = require('../../skymp/packages/staff-access-policy');

function createStaffGuard(db, requiredPermission = null) {
  if (typeof db !== 'function') throw new TypeError('db deve ser função');
  return async function staffGuard(req, res, next) {
    if (!req.isAuthenticated || !req.isAuthenticated()) {
      return res.status(401).json({ error: 'Não autenticado' });
    }
    try {
      const rows = await db(
        'SELECT role FROM staff_roles WHERE account_id = ? LIMIT 1',
        [req.user.accountId]
      );
      if (rows.length === 0) return res.status(403).json({ error: 'Acesso staff negado' });

      const role = rows[0].role;
      const permissions = permissionsForRole(role);
      if (!permissions) {
        console.error(`[staff-access] Cargo desconhecido recusado: ${role}`);
        return res.status(403).json({ error: 'Cargo de staff inválido' });
      }
      if (requiredPermission && !permissions.has(requiredPermission)) {
        return res.status(403).json({ error: 'Permissão insuficiente' });
      }

      req.staff = { role, permissions };
      return next();
    } catch (error) {
      console.error('[staff-access] Falha ao verificar acesso:', error);
      return res.status(500).json({ error: 'Erro interno do servidor' });
    }
  };
}

module.exports = { ROLE_PERMISSIONS, permissionsForRole, createStaffGuard };
