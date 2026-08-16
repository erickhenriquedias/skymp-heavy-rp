'use strict';

function parseGameAccessRoleIds(primaryRoleId, configuredRoleIds = '') {
  return [...new Set(
    [primaryRoleId, ...String(configuredRoleIds).split(',')]
      .map((roleId) => String(roleId || '').trim())
      .filter(Boolean)
  )];
}

function getMemberGameAccess(member, roleIds) {
  if (!member?.roles?.cache || !Array.isArray(roleIds)) {
    return { eligible: false, matchedRoleId: null };
  }
  const matchedRoleId = roleIds.find((roleId) => member.roles.cache.has(roleId)) || null;
  return { eligible: matchedRoleId !== null, matchedRoleId };
}

module.exports = { parseGameAccessRoleIds, getMemberGameAccess };
