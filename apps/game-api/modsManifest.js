/**
 * modsManifest.js
 *
 * Carrega e serve o manifesto de paridade de modpack (`mods.json`).
 *
 * Este é o arquivo que sustenta o contrato de FormID descrito em
 * `docs/technical/MODS_AND_GAMEMODE_CONTRACT.md`: o launcher compara o hash de
 * cada arquivo em `Data/` contra esta lista, e valida a ordem dos plugins
 * contra `loadOrder`. Sem os dois batendo, o mesmo `base_id` no banco pode
 * significar itens diferentes na tela de cada jogador.
 *
 * O manifesto é gerado offline por `scripts/generate-mods-manifest.js` a partir
 * da pasta `Data/` do servidor. Aqui só lemos e servimos — de propósito: gerar
 * hash sob demanda numa requisição HTTP seria lento e daria margem a servir um
 * manifesto inconsistente enquanto alguém copia arquivos pra pasta.
 */

const fs = require('fs');
const { validateModsManifestContract } = require('../../skymp/packages/mods-manifest-contract');

function isValidManifest(data) {
  if (!data || typeof data !== 'object') return false;
  if (!Array.isArray(data.mods)) return false;
  if (!Array.isArray(data.loadOrder)) return false;
  return data.mods.every((mod) =>
    mod && typeof mod.filename === 'string' && mod.filename.length > 0 &&
    typeof mod.hash === 'string' && mod.hash.length > 0
  );
}

/**
 * Lê o manifesto do disco, com cache invalidado por mtime.
 *
 * Retorna `{ ok: false, reason }` em vez de lançar ou de devolver um manifesto
 * vazio: um manifesto ausente ou corrompido precisa virar erro visível pro
 * launcher, não uma lista vazia — lista vazia passaria na verificação de
 * paridade e deixaria qualquer modpack entrar, que é exatamente o oposto do
 * que este arquivo existe pra impedir.
 */
function createManifestLoader(manifestPath) {
  let cached = null;
  let cachedMtimeMs = null;

  function load() {
    let stat;
    try {
      stat = fs.statSync(manifestPath);
    } catch {
      return { ok: false, reason: 'manifest_missing' };
    }

    if (cached && cachedMtimeMs === stat.mtimeMs) {
      return { ok: true, manifest: cached };
    }

    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch {
      return { ok: false, reason: 'manifest_invalid_json' };
    }

    const contract = validateModsManifestContract(parsed);
    if (!contract.ok) return contract;

    if (!isValidManifest(parsed)) {
      return { ok: false, reason: 'manifest_invalid_shape' };
    }
    if (parsed.mods.length === 0 || parsed.loadOrder.length === 0) {
      return { ok: false, reason: 'manifest_empty' };
    }

    cached = parsed;
    cachedMtimeMs = stat.mtimeMs;
    return { ok: true, manifest: parsed };
  }

  return { load };
}

module.exports = { createManifestLoader, isValidManifest };
