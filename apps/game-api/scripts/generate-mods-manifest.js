#!/usr/bin/env node
/**
 * generate-mods-manifest.js
 *
 * Gera o `mods.json` que o launcher usa pra verificar paridade de modpack,
 * a partir da pasta `Data/` de referência do servidor.
 *
 * Uso:
 *   node scripts/generate-mods-manifest.js "D:\\Skyrim Special Edition\\Data"
 *   node scripts/generate-mods-manifest.js <Data> --out ./mods.json --plugins-txt <plugins.txt>
 *
 * Sobre o algoritmo de hash: usa MD5 porque é o que o `verify-mods` do launcher
 * já compara (`apps/launcher/electron/main.ts`). Isso é deliberado e não é uma
 * falha de segurança — este hash detecta divergência e corrupção entre clientes,
 * não protege contra adulteração maliciosa. Quem quer trapacear controla a
 * própria máquina e simplesmente não roda o launcher; a defesa contra isso é o
 * servidor não confiar no cliente (ver docs/technical/MODS_AND_GAMEMODE_CONTRACT.md),
 * não um hash mais forte aqui. MD5 é ~3x mais rápido, e um modpack de Skyrim
 * tem dezenas de GB.
 *
 * A ordem em `loadOrder` importa muito mais que o conteúdo de `mods`: é ela que
 * fixa o índice de load order embutido em todo FormID.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  MODS_MANIFEST_CHANNELS,
  MODS_MANIFEST_VERSION,
  validateModsManifestContract
} = require('../../../skymp/packages/mods-manifest-contract');

const PLUGIN_EXTENSIONS = ['.esm', '.esp', '.esl'];
// Extensões que valem a pena verificar por hash. Não incluímos tudo: uma pasta
// Data tem milhares de arquivos soltos e verificar textura por textura tornaria
// o boot do launcher inviável sem ganho — divergência de textura não desloca
// FormID nem quebra sincronização.
const HASHED_EXTENSIONS = [...PLUGIN_EXTENSIONS, '.bsa', '.bsl'];

function parseArgs(argv) {
  const args = {
    dataDir: null,
    out: null,
    pluginsTxt: null,
    onlyLoadOrder: false,
    channel: process.env.MODPACK_CHANNEL || 'development',
    build: process.env.MODPACK_BUILD || 'unversioned'
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') { args.out = argv[++i]; continue; }
    if (argv[i] === '--plugins-txt') { args.pluginsTxt = argv[++i]; continue; }
    if (argv[i] === '--only-load-order') { args.onlyLoadOrder = true; continue; }
    if (argv[i] === '--channel') { args.channel = argv[++i]; continue; }
    if (argv[i] === '--build') { args.build = argv[++i]; continue; }
    rest.push(argv[i]);
  }
  args.dataDir = rest[0] || null;
  return args;
}

function md5File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * Lê a ordem de plugins de um `plugins.txt` do Skyrim (formato do gerenciador
 * de mods: uma linha por plugin, `*` prefixando os ativos).
 *
 * Preferimos essa fonte quando disponível porque a ordem alfabética do
 * diretório NÃO é a load order real — e usar a ordem errada aqui produziria um
 * manifesto que reprova todo mundo, ou pior, que aprova uma ordem divergente.
 */
function readPluginsTxt(pluginsTxtPath) {
  const lines = fs.readFileSync(pluginsTxtPath, 'utf8').split(/\r?\n/);
  const order = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const enabled = trimmed.startsWith('*');
    const name = enabled ? trimmed.slice(1).trim() : trimmed;
    if (!name) continue;
    if (!PLUGIN_EXTENSIONS.includes(path.extname(name).toLowerCase())) continue;
    if (enabled) order.push(name);
  }
  return order;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.dataDir) {
    console.error('Uso: node scripts/generate-mods-manifest.js <Data> [--out mods.json] [--plugins-txt plugins.txt] [--only-load-order] [--channel development|beta|stable] [--build id]');
    process.exit(1);
  }

  if (!MODS_MANIFEST_CHANNELS.includes(args.channel)) {
    console.error(`[manifest] Canal invalido: ${args.channel}. Use ${MODS_MANIFEST_CHANNELS.join(', ')}.`);
    process.exit(1);
  }
  if (typeof args.build !== 'string' || args.build.trim().length === 0 || args.build.length > 128) {
    console.error('[manifest] --build precisa ser um identificador nao vazio de ate 128 caracteres.');
    process.exit(1);
  }

  const dataDir = path.resolve(args.dataDir);
  if (!fs.existsSync(dataDir) || !fs.statSync(dataDir).isDirectory()) {
    console.error(`[manifest] Pasta Data nao encontrada: ${dataDir}`);
    process.exit(1);
  }

  const outPath = path.resolve(args.out || path.join(__dirname, '..', 'mods.json'));

  // Listagem completa da Data. Continua sendo a fonte da validacao da load
  // order mesmo quando o que vai ser hasheado e um subconjunto.
  const todosArquivos = fs.readdirSync(dataDir)
    .filter((name) => HASHED_EXTENSIONS.includes(path.extname(name).toLowerCase()))
    .filter((name) => {
      try { return fs.statSync(path.join(dataDir, name)).isFile(); } catch { return false; }
    })
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

  if (todosArquivos.length === 0) {
    console.error(`[manifest] Nenhum plugin ou BSA encontrado em ${dataDir}. Caminho errado?`);
    process.exit(1);
  }

  // `--only-load-order`: hasheia SO os plugins da load order, ignorando o resto
  // da Data.
  //
  // Existe porque `compareMods` (apps/launcher/electron/parity.mjs) exige que
  // TODO arquivo do manifesto exista no cliente com o mesmo hash. Gerar a
  // partir de uma Data de trabalho, com dezenas de mods instalados, produz um
  // manifesto que diz "tenha exatamente a minha maquina" — e reprova qualquer
  // testador com instalacao limpa, com um "Mod faltando" sobre um mod que nao
  // faz parte de nada.
  //
  // Enquanto o modpack oficial nao existe, o que precisa ser identico entre
  // clientes e a LOAD ORDER, porque e dela que sai o indice embutido em todo
  // FormID (MODS_AND_GAMEMODE_CONTRACT.md secao 3). Textura e mesh divergentes
  // nao deslocam FormID — pelo mesmo motivo que este script ja nao hasheia a
  // Data inteira, so plugins e BSAs.
  //
  // Nao use em producao com modpack fechado: la o manifesto deve cobrir o
  // conteudo tambem, e ai o padrao (sem a flag) e o certo.
  let entries = todosArquivos;
  if (args.onlyLoadOrder) {
    if (!args.pluginsTxt) {
      console.error('[manifest] --only-load-order exige --plugins-txt: sem ele nao ha load order pra restringir.');
      process.exit(1);
    }
    const daOrdem = new Set(readPluginsTxt(path.resolve(args.pluginsTxt)).map((p) => p.toLowerCase()));
    entries = todosArquivos.filter((name) => daOrdem.has(name.toLowerCase()));
    console.log(`[manifest] --only-load-order: ${entries.length} de ${todosArquivos.length} arquivos entram no manifesto.`);
  }

  console.log(`[manifest] Hasheando ${entries.length} arquivos em ${dataDir}...`);
  const mods = [];
  for (const filename of entries) {
    const hash = await md5File(path.join(dataDir, filename));
    mods.push({ filename, hash });
    process.stdout.write(`  ${filename} ${hash}\n`);
  }

  let loadOrder;
  if (args.pluginsTxt) {
    const pluginsTxtPath = path.resolve(args.pluginsTxt);
    if (!fs.existsSync(pluginsTxtPath)) {
      console.error(`[manifest] plugins.txt nao encontrado: ${pluginsTxtPath}`);
      process.exit(1);
    }
    loadOrder = readPluginsTxt(pluginsTxtPath);
    console.log(`[manifest] Load order lida de ${pluginsTxtPath}: ${loadOrder.length} plugins.`);

    // Valida contra a Data inteira, nao contra `entries`: com
    // `--only-load-order` o `entries` foi derivado da propria load order, e
    // comparar os dois faria a checagem concordar consigo mesma e nunca acusar
    // um plugin ausente.
    const known = new Set(todosArquivos.map((e) => e.toLowerCase()));
    const missing = loadOrder.filter((p) => !known.has(p.toLowerCase()));
    if (missing.length > 0) {
      console.error(`[manifest] ERRO: plugins na load order que nao existem em Data/: ${missing.join(', ')}`);
      process.exit(1);
    }
  } else {
    loadOrder = entries.filter((name) => PLUGIN_EXTENSIONS.includes(path.extname(name).toLowerCase()));
    console.warn('[manifest] AVISO: --plugins-txt nao informado.');
    console.warn('[manifest] A load order foi inferida por ordem alfabetica do diretorio, que NAO e');
    console.warn('[manifest] a load order real do Skyrim. Isso serve pra teste local, mas em producao');
    console.warn('[manifest] gera um manifesto que reprova clientes corretos. Passe --plugins-txt.');
  }

  const manifest = {
    manifestVersion: MODS_MANIFEST_VERSION,
    channel: args.channel,
    build: args.build.trim(),
    generatedAt: new Date().toISOString(),
    loadOrderSource: args.pluginsTxt ? 'plugins.txt' : 'directory-order (NAO CONFIAVEL)',
    mods,
    loadOrder
  };

  const contract = validateModsManifestContract(manifest);
  if (!contract.ok) throw new Error(`Contrato do manifesto invalido: ${contract.reason}`);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2));
  console.log(`\n[manifest] Escrito em ${outPath}`);
  console.log(`[manifest] ${mods.length} arquivos verificados, ${loadOrder.length} plugins na ordem.`);
}

main().catch((err) => {
  console.error('[manifest] Falhou:', err.message);
  process.exit(1);
});
