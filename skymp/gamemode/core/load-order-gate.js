'use strict';

function normalizedLoadOrder(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} ausente ou vazia`);
  }
  const seen = new Set();
  return value.map((plugin, index) => {
    if (typeof plugin !== 'string' || plugin.length < 1 || plugin.length > 255 || plugin.includes('/') || plugin.includes('\\')) {
      throw new Error(`${label}[${index}] invalido`);
    }
    const key = plugin.toLocaleLowerCase('en-US');
    if (seen.has(key)) throw new Error(`${label} possui plugin duplicado: ${plugin}`);
    seen.add(key);
    return { name: plugin, key };
  });
}

function compareLoadOrder(expected, actual, label) {
  if (expected.length !== actual.length) {
    return `${label} possui ${actual.length} plugin(s), manifesto exige ${expected.length}`;
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (expected[index].key !== actual[index].key) {
      return `${label}[${index}] e ${actual[index].name}, manifesto exige ${expected[index].name}`;
    }
  }
  return null;
}

function validateServerLoadOrder({ manifestLoadOrder, configuredLoadOrder, effectiveLoadOrder }) {
  try {
    const manifest = normalizedLoadOrder(manifestLoadOrder, 'manifest.loadOrder');
    const configured = normalizedLoadOrder(configuredLoadOrder, 'server-settings.loadOrder');
    const effective = normalizedLoadOrder(effectiveLoadOrder, 'mp.getEspmLoadOrder()');
    const problems = [
      compareLoadOrder(manifest, configured, 'server-settings.loadOrder'),
      compareLoadOrder(manifest, effective, 'mp.getEspmLoadOrder()'),
    ].filter(Boolean);
    return problems.length > 0 ? { ok: false, problems } : { ok: true };
  } catch (error) {
    return { ok: false, problems: [error.message] };
  }
}

function assertServerLoadOrder(input) {
  const result = validateServerLoadOrder(input);
  if (!result.ok) throw new Error(`load order reprovada: ${result.problems.join('; ')}`);
  return result;
}

module.exports = { assertServerLoadOrder, validateServerLoadOrder };
