/**
 * parity.mjs — verificação de paridade de modpack, sem I/O
 *
 * Esta é a lógica que sustenta o **contrato de FormID**
 * (`docs/technical/MODS_AND_GAMEMODE_CONTRACT.md` §3): o servidor guarda
 * `base_id` no banco, e um FormID só significa alguma coisa dentro de uma
 * load order específica. Se a ordem do jogador diferir da do servidor em uma
 * única posição, o mesmo `base_id` vira um item diferente na tela dele.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Por que isto virou módulo próprio
 * ─────────────────────────────────────────────────────────────────────────────
 * Estava dentro dos handlers `ipcMain.handle` do `main.ts`, misturado com
 * leitura de disco e HTTP — ou seja, impossível de testar sem um Electron, um
 * servidor e uma pasta `Data/` de verdade. Resultado prático: o launcher tinha
 * **zero testes**, e é ele que decide se um jogador entra ou não.
 *
 * Aqui não há `fs`, `http` nem `electron`. As dependências de I/O entram como
 * argumento (`readHeader`, `hashOf`). É JS puro (`.mjs`) e não TypeScript de
 * propósito: assim `node --test` roda direto, sem passo de build — mesma
 * escolha do gamemode.
 *
 * Escrito em ESM porque o `apps/launcher` é `"type": "module"`.
 */

/**
 * Interpreta o `plugins.txt` do Skyrim.
 *
 * Formato: uma linha por plugin, `*` na frente quando está ativo, `#` para
 * comentário. O que **não** tem `*` está presente no disco mas fora da load
 * order — e portanto não desloca FormID nenhum.
 *
 * @param {string} content
 * @returns {{name: string, enabled: boolean}[]}
 */
export function parsePluginsTxt(content) {
  if (typeof content !== 'string') return [];
  return content
    .split(/\r?\n/)
    .map(linha => linha.trim())
    .filter(linha => linha.length > 0 && !linha.startsWith('#'))
    .map(linha => ({ name: linha.replace(/^\*/, ''), enabled: linha.startsWith('*') }));
}

/**
 * Lê o cabeçalho TES4 de um plugin a partir do buffer do arquivo.
 *
 * Recebe **buffer**, não caminho: é o que torna o parser testável com um
 * plugin sintético de 60 bytes em vez de um `.esm` de 300 MB.
 *
 * @param {Buffer} buffer
 * @returns {{masters: string[], isMaster: boolean, isLight: boolean, error?: string}}
 */
export function parsePluginHeader(buffer) {
  const vazio = { masters: [], isMaster: false, isLight: false };

  if (!buffer || buffer.length < 24) {
    return { ...vazio, error: 'Arquivo menor que o cabecalho TES4' };
  }
  if (buffer.toString('latin1', 0, 4) !== 'TES4') {
    return { ...vazio, error: 'Cabecalho TES4 invalido' };
  }

  const dataSize = buffer.readUInt32LE(4);
  const flags = buffer.readUInt32LE(8);
  const isMaster = (flags & 0x1) !== 0;
  const isLight = (flags & 0x200) !== 0;

  // Teto de 1 MiB: o bloco de masters vive no começo, e sem limite um arquivo
  // com `dataSize` corrompido faria o launcher alocar memória arbitrária a
  // partir de um número que veio de fora.
  const cap = Math.min(dataSize, 1024 * 1024, Math.max(0, buffer.length - 24));
  const data = buffer.subarray(24, 24 + cap);

  const masters = [];
  let offset = 0;
  while (offset + 6 <= data.length) {
    const type = data.toString('latin1', offset, offset + 4);
    const size = data.readUInt16LE(offset + 4);
    const inicio = offset + 6;
    const fim = inicio + size;
    if (fim > data.length) break;
    if (type === 'MAST') {
      const valor = data.toString('utf8', inicio, fim);
      // MAST vem terminado em NUL; sem cortar, o nome carrega o byte nulo
      // e nunca casa com o arquivo em disco.
      const nul = valor.indexOf(String.fromCharCode(0));
      const nome = (nul >= 0 ? valor.slice(0, nul) : valor).trim();
      if (nome) masters.push(nome);
    }
    offset = fim;
  }

  return { masters, isMaster, isLight };
}

/**
 * Compara o conteúdo local com o manifesto do servidor.
 *
 * @param {Object}   params
 * @param {{filename: string, hash: string}[]} params.serverMods
 * @param {string[]} params.localFiles  nomes dos arquivos em `Data/`
 * @param {(filename: string) => string} params.hashOf  hash do arquivo local
 */
export function compareMods({ serverMods, localFiles, hashOf }) {
  if (!Array.isArray(serverMods)) {
    const error = 'Manifesto invalido do servidor.';
    return { success: false, error, problems: [error] };
  }

  // Windows não distingue caixa; o manifesto é gerado noutra máquina.
  const porNomeMinusculo = new Map(localFiles.map(f => [f.toLowerCase(), f]));
  const problems = [];

  for (const mod of serverMods) {
    const local = porNomeMinusculo.get(String(mod.filename).toLowerCase());
    if (!local) {
      problems.push(`Mod faltando: ${mod.filename}`);
      continue;
    }
    if (hashOf(local) !== mod.hash) {
      problems.push(`O mod ${mod.filename} esta modificado ou corrompido!`);
    }
  }

  if (problems.length > 0) {
    return { success: false, error: problems[0], problems };
  }
  return { success: true, problems: [] };
}

/**
 * Verifica a load order contra a do servidor.
 *
 * Três classes de problema, e a terceira é a que faltava:
 *
 *   1. **Plugin ausente** — o servidor exige e o jogador não tem.
 *   2. **Master fora de ordem** — a dependência carrega depois do dependente.
 *   3. **Plugin extra** — o jogador tem um plugin que o servidor não conhece.
 *
 * O caso 3 é o mais perigoso e era o que passava batido. Um `.esp` a mais na
 * load order ocupa um índice e **desloca todos os plugins seguintes**: o
 * `HeavyRP.esm` que é `02` no servidor vira `03` no cliente, e todo `base_id`
 * gravado no banco passa a apontar para outro registro na tela daquele jogador.
 *
 * Ele passava porque as duas verificações eram feitas **na direção errada**:
 * ambas percorriam a lista do servidor perguntando "o jogador tem isto?", e
 * nenhuma percorria a do jogador perguntando "o servidor conhece isto?".
 *
 * `enabledPlugins` (do `plugins.txt`) é o que define a load order real. Sem
 * ele, a checagem cai para os arquivos presentes em `Data/` — mais grosseira,
 * porque um plugin presente e desativado não desloca nada, mas é a direção
 * segura: falso positivo aqui é "você tem um arquivo que não deveria".
 *
 * @param {Object} params
 * @param {string[]} params.localPlugins           arquivos de plugin em `Data/`
 * @param {string[]} params.serverLoadOrder        ordem canônica do servidor
 * @param {string[]} [params.enabledPlugins]       ativos no `plugins.txt`
 * @param {(name: string) => Object} params.readHeader
 */
export function analyzePlugins({ localPlugins, serverLoadOrder, enabledPlugins, readHeader }) {
  const problems = [];
  const plugins = [];

  const locaisPorMinusculo = new Map(localPlugins.map(f => [f.toLowerCase(), f]));

  // Sem ordem do servidor não existe paridade a verificar. Antes o código caía
  // para a ordem local, o que fazia a checagem comparar o jogador consigo mesmo
  // e responder "ok" sempre — a pior resposta possível, porque parece
  // aprovação.
  if (!Array.isArray(serverLoadOrder) || serverLoadOrder.length === 0) {
    return {
      ok: false,
      problems: ['Servidor nao informou load order: impossivel verificar paridade.'],
      plugins: []
    };
  }

  const indiceNaOrdem = new Map(serverLoadOrder.map((f, i) => [String(f).toLowerCase(), i]));

  for (const plugin of serverLoadOrder) {
    const nomeLocal = locaisPorMinusculo.get(String(plugin).toLowerCase());
    if (!nomeLocal) {
      problems.push(`Plugin ausente: ${plugin}`);
      continue;
    }

    const header = readHeader(nomeLocal);
    plugins.push({ name: nomeLocal, ...header });
    if (header.error) problems.push(`${nomeLocal}: ${header.error}`);

    for (const master of header.masters || []) {
      if (!locaisPorMinusculo.has(master.toLowerCase())) {
        problems.push(`${nomeLocal}: master ausente ${master}`);
        continue;
      }
      const iMaster = indiceNaOrdem.get(master.toLowerCase());
      const iPlugin = indiceNaOrdem.get(String(plugin).toLowerCase());
      if (iMaster !== undefined && iPlugin !== undefined && iMaster > iPlugin) {
        problems.push(`${nomeLocal}: master ${master} carrega depois do plugin`);
      }
    }
  }

  // A direção que faltava.
  const candidatos = Array.isArray(enabledPlugins) && enabledPlugins.length > 0
    ? enabledPlugins
    : localPlugins;

  for (const local of candidatos) {
    if (!indiceNaOrdem.has(String(local).toLowerCase())) {
      problems.push(
        `Plugin extra na load order: ${local}. Ele desloca os FormIDs de todos ` +
        `os plugins seguintes, entao os itens do servidor apareceriam trocados.`
      );
    }
  }

  return { ok: problems.length === 0, problems, plugins };
}

/**
 * Interpreta o `Skyrim.ccc`.
 *
 * Formato: um nome de plugin por linha, sem `*` — diferente do `plugins.txt`,
 * porque aqui não existe "desativado". O que está listado e presente no disco
 * carrega, ponto.
 *
 * @param {string} content
 * @returns {string[]}
 */
export function parseCccTxt(content) {
  if (typeof content !== 'string') return [];
  return content
    .split(/\r?\n/)
    .map(linha => linha.trim())
    .filter(linha => linha.length > 0 && !linha.startsWith('#'));
}

/**
 * Confere a paridade do conteúdo Creation Club — o buraco que `analyzePlugins`
 * não cobre.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Por que esta função existe
 * ─────────────────────────────────────────────────────────────────────────────
 * `analyzePlugins` compara o `plugins.txt` do jogador com a ordem do servidor.
 * **Conteúdo Creation Club nunca aparece no `plugins.txt`.** O Skyrim AE lê o
 * `Skyrim.ccc`, carrega o que estiver listado *e presente em `Data/`*, e
 * encaixa esses plugins logo depois dos masters vanilla — ocupando índices que
 * o servidor não conhece.
 *
 * Como o primeiro byte de todo FormID é o índice de load order, o efeito é o
 * mesmo do "plugin extra": o `base_id` do banco passa a apontar pra outro
 * record na tela daquele jogador. Sem erro e sem log — o sintoma é um baú com
 * outra coisa dentro (a falha do QA 2.15).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * O que torna isto pior que um mod extra
 * ─────────────────────────────────────────────────────────────────────────────
 * O conteúdo do `Skyrim.ccc` **varia conforme o que aquela conta Steam
 * possui**. Não é o mesmo arquivo para dois testadores, e o jogador não
 * escolheu nada disso. Um verificador que só olha `Data/` contra o manifesto
 * não enxerga a diferença, porque os arquivos até podem estar lá — o que muda
 * é o que o executável decide carregar.
 *
 * Por isso a checagem é bidirecional, como em `analyzePlugins`:
 *
 * - CC que o jogador carrega e o servidor não declara → desloca índice;
 * - CC que o servidor declara e o jogador não carrega → falta record.
 *
 * A segunda direção é o risco de exigir Creation Club no modpack oficial: ela
 * só passa se **todo** jogador tiver exatamente as mesmas licenças de CC.
 *
 * @param {Object} params
 * @param {string[]} params.cccEntries        linhas do `Skyrim.ccc` (via `parseCccTxt`)
 * @param {string[]} params.localPlugins      arquivos de plugin presentes em `Data/`
 * @param {string[]} params.serverLoadOrder   ordem canônica do servidor
 * @returns {{ok: boolean, problems: string[], effective: string[]}}
 */
export function analyzeCreationClub({ cccEntries, localPlugins, serverLoadOrder }) {
  const problems = [];

  if (!Array.isArray(serverLoadOrder) || serverLoadOrder.length === 0) {
    return {
      ok: false,
      problems: ['Servidor nao informou load order: impossivel verificar paridade de Creation Club.'],
      effective: []
    };
  }

  const presentes = new Set((localPlugins || []).map(f => String(f).toLowerCase()));
  const naOrdem = new Set(serverLoadOrder.map(f => String(f).toLowerCase()));

  // Listado no .ccc *e* presente no disco. Entrada sem arquivo não carrega e
  // não desloca nada — tratá-la como problema seria falso positivo em toda
  // instalação que não comprou tudo.
  const effective = (cccEntries || [])
    .filter(nome => presentes.has(String(nome).toLowerCase()));

  for (const cc of effective) {
    if (!naOrdem.has(String(cc).toLowerCase())) {
      problems.push(
        `Creation Club ativo fora da load order do servidor: ${cc}. O jogo carrega ` +
        `este plugin sozinho, pelo Skyrim.ccc, mesmo sem estar no plugins.txt — ` +
        `e ele desloca os FormIDs de todos os plugins seguintes.`
      );
    }
  }

  // Direção inversa: o servidor conta com um CC que este jogador não carrega.
  const efetivosMinusculo = new Set(effective.map(n => String(n).toLowerCase()));
  for (const declarado of serverLoadOrder) {
    const nome = String(declarado);
    if (!/^cc[a-z0-9]/i.test(nome)) continue; // só conteúdo Creation Club
    if (!efetivosMinusculo.has(nome.toLowerCase())) {
      problems.push(
        `Creation Club exigido pelo servidor e ausente: ${nome}. Ou a conta Steam ` +
        `nao possui este conteudo, ou ele nao esta listado no Skyrim.ccc.`
      );
    }
  }

  return { ok: problems.length === 0, problems, effective };
}
