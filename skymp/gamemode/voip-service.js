/**
 * voip-service.js
 * VOIP por proximidade: sinalização WebRTC (caminho antigo) + relay de áudio (caminho novo).
 *
 * Arquitetura:
 * - Um WebSocketServer (porta 7778, bind local por padrão) recebe conexoes dos clientes CEF.
 * - Cada cliente se autentica enviando { type: 'auth', actorId, ticket, role }. O ticket é
 *   um token de uso único e curta duração emitido pelo servidor (issueTicket) quando o
 *   jogador roda /voz — sem isso, qualquer processo que conecte no WebSocket local
 *   poderia reivindicar o actorId de outro jogador e sequestrar o slot de voz dele.
 * - O servidor calcula a distancia entre atores a cada 2 segundos.
 * - Com base na distancia, envia { type: 'proximity_update', peers: [...] } ao cliente.
 *
 * Um mesmo jogador tem DUAS conexões, porque falar e ouvir saem por processos
 * diferentes desde que a captura foi pra fora do CEF (ver `role` em §2 abaixo e
 * `docs/technical/VOICE_NATIVE_HELPER.md` §10).
 *
 * Dois caminhos convivem aqui de propósito, e a Fase 2 remove o primeiro:
 *
 * 1. WebRTC P2P (offer/answer/ice). O servidor só repassa sinalização; o áudio vai
 *    direto entre os clientes, e o `index.html` ajusta o GainNode com o
 *    `proximity_update`. É o que roda no client SkyMP oficial — e é o caminho que
 *    *não funciona*, porque a captura (`getUserMedia`) é bloqueada no CEF embutido.
 *
 * 2. Relay pelo servidor (`audio_frame`). Um helper nativo fora do CEF captura o
 *    microfone via WASAPI e manda os frames por este mesmo WebSocket; o servidor
 *    retransmite pra quem está em alcance, com o volume já calculado. O navegador
 *    do jogo só *toca* — tocar nunca foi bloqueado pela CEF, só a captura era.
 *    Ver `docs/technical/VOICE_NATIVE_HELPER.md`.
 *
 * Por que relay e não P2P: reverter a flag do Chromium que libera o microfone é
 * um caminho descartado (`docs/technical/VOICE_CLIENT_PATCH.md`) — a remoção foi
 * deliberada na SkyrimPlatform 2.1, e reabri-la exporia o microfone do jogador a
 * qualquer servidor SkyMP que ele conectasse depois, não só a este. De quebra, o
 * relay resolve NAT/CGNAT: dois jogadores em redes residenciais distintas não
 * fecham conexão direta, mas os dois alcançam o servidor.
 *
 * Nota de 14/08/2026: a CEF do SkyMP é a **108** (Chromium 108.0.5359.125), não
 * a "~70" que este cabeçalho e os docs de voz afirmavam. A 108 tem
 * `CefPermissionHandler`, então existe um caminho de microfone **por origem e
 * só áudio** que não depende de flag global nenhuma. Isso não muda uma linha
 * deste arquivo — a proximidade, o mute por ator e o cálculo de volume valem
 * igual em qualquer transporte —, mas muda qual é o próximo passo.
 * Ver `docs/technical/SKYVOICE_LIVEKIT_AUDIT.md` §5 e `core/voice/`.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
// O gamemode roda em CommonJS dentro do Node embutido pelo SkyMP. A tipagem
// publicada por `ws` e a do Node atual divergem ao inferir destructuring de
// `require`, embora o valor exista em runtime no ws 8.x. Manter a fronteira
// como `any` evita um falso positivo do checkJs sem mudar o contrato real.
/** @type {any} */
const ws = require('ws');
const { WebSocketServer, WebSocket } = ws;
const commands = require('./commands');

const VOIP_PORT = Number.parseInt(process.env.VOIP_PORT, 10) || 7778;
const VOIP_BIND_HOST = process.env.VOIP_BIND_HOST || '127.0.0.1';
const VOIP_PUBLIC_HOST = process.env.VOIP_PUBLIC_HOST || '127.0.0.1';

/**
 * ⚠️ ANDAIME DE TESTE, padrão desligado. Ver `_exposeDebugTicket`.
 *
 * Ligada, faz o /voz gravar o ticket do helper em texto puro (arquivo + log).
 * Não entra em nenhum `.env.example`: quem precisa liga à mão durante o teste
 * manual e desliga depois. A Fase 3 remove a flag inteira.
 *
 * Lida a cada chamada, não uma vez no load: o padrão é desligado, e uma flag que
 * só pode ser ligada reiniciando o servidor é uma flag que alguém vai deixar
 * ligada no `.env` pra não ter que reiniciar de novo. Custa um `process.env` por
 * /voz — que é um comando humano, não um caminho quente.
 */
const VOIP_DEBUG_TICKET_FILE = path.join(__dirname, '.voip-debug-ticket.json');

function _debugExposeTicketEnabled() {
  return process.env.VOIP_DEBUG_EXPOSE_TICKET === 'true';
}

/**
 * Os dois papéis de conexão de um mesmo jogador.
 *
 * `listener` é o `index.html` dentro do CEF: recebe `proximity_update`,
 * `audio_frame` e a sinalização WebRTC, e é ele quem toca som.
 * `sender` é o helper nativo (`voice-helper/`): só empurra `audio_frame` e
 * ignora tudo que chega, porque não tem alto-falante nenhum pra alimentar.
 *
 * `listener` é o padrão de propósito — o `index.html` atual não manda o campo
 * `role`, e um cliente antigo que só escuta é exatamente um listener. Assim a
 * compatibilidade não custa um ramo de código, ela é o caso base.
 */
const VOIP_ROLES = ['listener', 'sender'];
const DEFAULT_VOIP_ROLE = 'listener';

/**
 * Clientes conectados: actorId -> entrada do ator.
 *
 *   { listener: conexão|null, sender: conexão|null, voiceMode, muted }
 *
 * Cada conexão é `{ ws, actorId, role, oversizedFrameLogged }`.
 *
 * Era `Map<actorId, conexão>` — uma conexão por ator — e isso impedia um jogador
 * de falar e ouvir ao mesmo tempo: helper e UI autenticam com o MESMO actorId, e
 * quem chegasse por último derrubava o outro. Enquanto a captura morava no
 * navegador as duas coisas saíam pelo mesmo socket e o índice estava certo; ela
 * saiu (a CEF bloqueia `getUserMedia`), e o índice ficou errado.
 *
 * O que é por CONEXÃO e o que é por ATOR:
 *
 * - Por conexão: o socket e o log de frame grande (é o socket que se comporta mal).
 * - Por ator: `voiceMode` e `muted`. Mutar é uma decisão da pessoa sobre a própria
 *   voz na cena, não sobre um cabo. Se `muted` vivesse na conexão, mutar pela UI
 *   deixaria o helper transmitindo — a pessoa se veria mutada e continuaria sendo
 *   ouvida, que é o pior defeito possível num controle de microfone.
 *
 * Ver `docs/technical/VOICE_NATIVE_HELPER.md` §10.
 */
const voipClients = new Map();

/**
 * Tickets pendentes emitidos por /voz: `${actorId}:${role}` -> { token, expiresAt }
 *
 * A chave leva o papel porque o ticket é de uso único e `issueTicket` sobrescrevia
 * o pendente do ator: com uma chave só, o `/voz` que serve a UI queima o ticket que
 * o helper usaria, e os dois papéis nunca conseguem estar autenticados juntos.
 * Um ticket por papel é o mínimo pra que a conexão dupla seja alcançável na prática
 * — sem isso a mudança em `voipClients` acima seria correta e inútil.
 */
const _pendingTickets = new Map();
const TICKET_TTL_MS = 30 * 1000;

function _ticketKey(actorId, role) {
  return `${actorId}:${role}`;
}

// Distancias de voz — derivadas dos raios do chat em core/proximity-ranges.js,
// pra que falar e escrever cheguem exatamente nas mesmas pessoas.
const { VOICE_RANGES } = require('./core/proximity-ranges');

// A regra de "o que conta como célula" mora num lugar só. Reaproveitar o
// `getCell` daqui em vez de escrever mais uma cadeia de nomes de campo é o que
// mantém voz, nametag e alcance de ação concordando sobre onde cada um está.
const rangeUtils = require('./core/range-utils');

/**
 * Formato do áudio no fio (Fase 1): PCM cru, 16-bit little-endian, mono, 48kHz,
 * quadros de 20ms (960 amostras = 1920 bytes → 2560 chars em base64).
 *
 * O servidor não decodifica nem transcodifica nada — ele é um relay burro que
 * anexa o volume e repassa os bytes. Estas constantes existem só pra derivar o
 * teto de tamanho abaixo e pra que helper, servidor e UI citem a mesma fonte.
 * Ver `docs/technical/VOICE_NATIVE_HELPER.md` §2 pro porquê de PCM antes de Opus.
 */
const AUDIO_SAMPLE_RATE = 48000;
const AUDIO_CHANNELS = 1;
const AUDIO_FRAME_MS = 20;

// PCM a 48 kHz gera 50 frames de 20 ms por segundo. O bucket deixa uma pequena
// folga para jitter do helper, mas impede que um sender autenticado transforme
// o relay em multiplicador de banda mandando centenas de frames por segundo.
const AUDIO_FRAME_RATE_PER_SECOND = 60;
const AUDIO_FRAME_BURST = 12;

/**
 * Teto do payload base64 de um `audio_frame`, em caracteres.
 *
 * Um `audio_frame` é o único ponto onde um cliente autenticado faz o servidor
 * escrever dados controlados por ele nos sockets de *outros* jogadores. Sem
 * teto, um helper com bug (ou um cliente hostil que passou pelo ticket) manda um
 * frame de megabytes e o servidor o multiplica por todo mundo em alcance —
 * amplificação, e a memória que estoura é a do servidor, não a de quem mandou.
 *
 * 8192 dá folga de 3x sobre o quadro nominal de 20ms: quadros de até 60ms passam
 * (o helper pode agrupar sob carga), qualquer coisa acima disso é bug ou abuso.
 */
const MAX_AUDIO_FRAME_B64 = 8192;
// A mensagem de audio cabe com folga e SDP/ICE continuam tendo espaco. Este
// teto e aplicado pelo ws antes de transformar bytes de rede em string/JSON.
const MAX_VOIP_MESSAGE_BYTES = 32 * 1024;

let wss = null;
let _proximityTimer = null;

/**
 * Audiência por locutor, recalculada a cada `tickProximity()`:
 *   actorId do locutor -> [{ actorId: ouvinte, volume }]
 *
 * É a transposta do que o tick já calculava e jogava fora. A proximidade custa
 * O(n²) de distância 3D; um frame chega a 50/s por locutor, então recalcular por
 * frame seria pagar esse O(n²) cinquenta vezes por segundo por pessoa falando.
 * O relay só consulta esta tabela.
 *
 * O preço é que a audiência tem até 2s de idade: quem sai do alcance continua
 * ouvindo até o próximo tick. Não é uma imprecisão nova — o `proximity_update`
 * que ajusta o ganho do WebRTC sempre teve exatamente a mesma defasagem; o relay
 * herda a propriedade em vez de introduzi-la.
 */
const _audienceByActor = new Map();

/**
 * Emite um ticket de uso único para um actorId se autenticar num papel.
 * Chamado pelo comando /voz — nunca client-initiated.
 * @param {number} actorId
 * @param {string} [role] 'listener' (padrão) ou 'sender'
 * @returns {string} token
 */
function issueTicket(actorId, role = DEFAULT_VOIP_ROLE) {
  const token = crypto.randomBytes(16).toString('hex');
  _pendingTickets.set(_ticketKey(actorId, role), { token, expiresAt: Date.now() + TICKET_TTL_MS });
  return token;
}

function _consumeTicket(actorId, token, role = DEFAULT_VOIP_ROLE) {
  const key = _ticketKey(actorId, role);
  const pending = _pendingTickets.get(key);
  if (!pending) return false;
  _pendingTickets.delete(key); // uso único, válido ou não
  if (pending.expiresAt < Date.now()) return false;
  if (pending.token !== token) return false;
  return true;
}

/** Entrada do ator, criada sob demanda no primeiro `auth` daquele actorId. */
function _entryFor(actorId) {
  let entry = voipClients.get(actorId);
  if (!entry) {
    entry = { listener: null, sender: null, voiceMode: 'normal', muted: false };
    voipClients.set(actorId, entry);
  }
  return entry;
}

/** A conexão `listener` de um ator, se estiver aberta. É quem recebe qualquer coisa. */
function _openListener(actorId) {
  const entry = voipClients.get(actorId);
  const conn = entry && entry.listener;
  return conn && conn.ws.readyState === WebSocket.OPEN ? conn : null;
}

/** True se o ator tem ao menos uma conexão aberta, em qualquer papel. */
function _hasOpenConnection(entry) {
  return VOIP_ROLES.some((role) => entry[role] && entry[role].ws.readyState === WebSocket.OPEN);
}

/** Confirma que a mensagem vem do socket autenticado que ainda ocupa o papel. */
function _isCurrentClientSocket(actorId, role, socket) {
  const entry = voipClients.get(actorId);
  return Boolean(entry && role && entry[role] && entry[role].ws === socket);
}

/**
 * Consome um frame do bucket de uma conexao. Retorna false sem enviar nada
 * quando a cadencia excede o que o formato de audio permite reproduzir.
 */
function _consumeAudioFrameQuota(conn, now = Date.now()) {
  const elapsedMs = Math.max(0, now - conn.audioLastRefillAt);
  const replenished = (elapsedMs * AUDIO_FRAME_RATE_PER_SECOND) / 1000;
  conn.audioTokens = Math.min(AUDIO_FRAME_BURST, conn.audioTokens + replenished);
  conn.audioLastRefillAt = now;

  if (conn.audioTokens < 1) return false;
  conn.audioTokens -= 1;
  return true;
}

function startVoipServer(port = VOIP_PORT, host = VOIP_BIND_HOST) {
  if (wss) return;

  wss = new WebSocketServer({ port, host, maxPayload: MAX_VOIP_MESSAGE_BYTES });

  wss.on('listening', () => {
    console.log(`[voip] WebSocket signaling server listening on ws://${host}:${port}`);
  });

  wss.on('connection', (ws) => {
    let clientActorId = null;
    let clientRole = null;

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      switch (msg.type) {
        case 'auth': {
          // Cliente se registra com seu actorId — exige ticket válido emitido por /voz.
          //
          // `role` ausente = 'listener'. O `index.html` não manda o campo e não
          // precisa passar a mandar: quem só escuta É um listener.
          const claimedActorId = parseInt(msg.actorId);
          const claimedRole = msg.role === undefined ? DEFAULT_VOIP_ROLE : msg.role;
          if (!VOIP_ROLES.includes(claimedRole)) {
            console.log(`[voip] Auth rejeitada (role desconhecido: ${msg.role}) para actorId ${msg.actorId}.`);
            ws.send(JSON.stringify({ type: 'auth_failed' }));
            ws.close();
            return;
          }
          if (!Number.isFinite(claimedActorId) || !_consumeTicket(claimedActorId, msg.ticket, claimedRole)) {
            console.log(`[voip] Auth rejeitada (ticket inválido/expirado) para actorId ${msg.actorId} como ${claimedRole}.`);
            ws.send(JSON.stringify({ type: 'auth_failed' }));
            ws.close();
            return;
          }

          clientActorId = claimedActorId;
          clientRole = claimedRole;

          const entry = _entryFor(clientActorId);
          // Reconexão no MESMO papel substitui a anterior; o papel oposto não é
          // tocado. Fechar a antiga aqui dispara o handler de `close` dela, que
          // por isso confere a identidade do socket antes de limpar o slot —
          // sem essa checagem o close atrasado da conexão velha apagaria a nova.
          const previous = entry[clientRole];
          if (previous && previous.ws !== ws) {
            try { previous.ws.close(); } catch { /* já morto */ }
          }
          entry[clientRole] = {
            ws,
            actorId: clientActorId,
            role: clientRole,
            oversizedFrameLogged: false,
            audioRateLimitLogged: false,
            audioTokens: AUDIO_FRAME_BURST,
            audioLastRefillAt: Date.now()
          };

          console.log(`[voip] Actor 0x${clientActorId.toString(16)} connected to VOIP as ${clientRole}.`);
          ws.send(JSON.stringify({ type: 'auth_ok', actorId: clientActorId, role: clientRole }));
          break;
        }

        case 'voice_mode':
          // Modo de voz é do ator, não do socket: define o alcance com que a
          // pessoa é ouvida, e quem fala (helper) não é quem tem o seletor (UI).
          if (clientActorId !== null && _isCurrentClientSocket(clientActorId, clientRole, ws)) {
            voipClients.get(clientActorId).voiceMode = msg.mode || 'normal';
          }
          break;

        case 'offer':
        case 'answer':
        case 'ice':
          // Repassa sinalizacao WebRTC para o peer alvo — sempre pro `listener`
          // dele. É o navegador que tem `RTCPeerConnection`; o helper ignoraria.
          if (clientActorId !== null && _isCurrentClientSocket(clientActorId, clientRole, ws) && msg.targetActorId) {
            const target = _openListener(parseInt(msg.targetActorId));
            if (target) {
              target.ws.send(JSON.stringify({
                ...msg,
                fromActorId: clientActorId
              }));
            }
          }
          break;

        case 'audio_frame': {
          // Caminho novo: o helper nativo manda PCM capturado fora do CEF e o
          // servidor retransmite pra quem está em alcance. Só para autenticados
          // — sem isso, uma conexão anônima injetaria áudio na cena de todo
          // mundo, que é o mesmo furo que o ticket fechou no `auth`.
          // Aceito de qualquer papel, não só do `sender`. Os dois sockets
          // provaram a mesma identidade pelo mesmo handshake, então exigir papel
          // aqui não fecharia furo nenhum — só quebraria a sonda em Node e quem
          // ainda autentica sem `role`. O relay usa a identidade autenticada.
          if (clientActorId === null || !_isCurrentClientSocket(clientActorId, clientRole, ws)) break;
          if (typeof msg.data !== 'string') break;
          const entry = voipClients.get(clientActorId);
          const conn = entry && clientRole ? entry[clientRole] : null;
          if (!conn || !_consumeAudioFrameQuota(conn)) {
            if (conn && conn.ws === ws && !conn.audioRateLimitLogged) {
              conn.audioRateLimitLogged = true;
              console.warn(`[voip] Actor 0x${clientActorId.toString(16)} excedeu o limite de audio_frame; descartando.`);
            }
            break;
          }
          if (msg.data.length > MAX_AUDIO_FRAME_B64) {
            // Loga uma vez por conexão: o descarte é barato, o log em 50Hz não.
            if (conn && conn.ws === ws && !conn.oversizedFrameLogged) {
              conn.oversizedFrameLogged = true;
              console.warn(
                `[voip] Actor 0x${clientActorId.toString(16)} mandou audio_frame de ` +
                `${msg.data.length} chars (teto ${MAX_AUDIO_FRAME_B64}); descartando.`
              );
            }
            break;
          }
          relayAudioFrame(clientActorId, msg);
          break;
        }

        case 'mute':
          // Mute é do ator, não da conexão: silencia a pessoa na cena, venha a
          // voz pelo helper ou pelo caminho antigo. Por conexão, mutar pela UI
          // deixaria o helper transmitindo — mutado na tela e audível na cena.
          if (clientActorId !== null && _isCurrentClientSocket(clientActorId, clientRole, ws)) {
            voipClients.get(clientActorId).muted = msg.muted === true;
            console.log(`[voip] Actor 0x${clientActorId.toString(16)} mute=${msg.muted}`);
          }
          break;
      }
    });

    ws.on('close', () => {
      if (clientActorId === null || clientRole === null) return;
      const entry = voipClients.get(clientActorId);
      if (!entry) return;

      // Só limpa o slot se ele ainda for DESTE socket. Uma reconexão no mesmo
      // papel fecha a conexão antiga, e o close dela chega depois de a nova já
      // estar registrada — sem esta checagem, o adeus da velha derrubaria a nova.
      if (entry[clientRole] && entry[clientRole].ws !== ws) return;
      entry[clientRole] = null;

      // `peer_left` só quando sai o `listener`. Sair o `sender` significa que a
      // pessoa fechou o helper: ela para de falar, mas continua na cena de voz e
      // continua ouvindo pela UI. Anunciar saída aí faria os outros derrubarem o
      // caminho de áudio de alguém que ainda está lá, ouvindo.
      if (clientRole === 'listener') {
        broadcast({ type: 'peer_left', actorId: clientActorId }, clientActorId);
      }

      // A entrada só some quando os dois papéis se foram — enquanto sobrar um, o
      // ator segue na cena, com seu `muted`/`voiceMode` preservados.
      if (!entry.listener && !entry.sender) voipClients.delete(clientActorId);

      console.log(`[voip] Actor 0x${clientActorId.toString(16)} disconnected from VOIP (${clientRole}).`);
    });

    ws.on('error', (err) => {
      console.error('[voip] WebSocket error:', err.message);
    });
  });

  // Ticker de proximidade: a cada 2s calcula volumes para todos os pares.
  // unref: um ticker pendente não deve impedir o processo (ou os testes) de encerrar.
  _proximityTimer = setInterval(() => tickProximity(), 2000);
  if (typeof _proximityTimer.unref === 'function') _proximityTimer.unref();

  console.log('[voip] VOIP service initialized.');
}

/**
 * Calcula a distancia 3D entre dois atores, envia os volumes ajustados e
 * reconstrói a audiência de cada locutor (usada pelo relay de `audio_frame`).
 */
function tickProximity() {
  // Zera antes de qualquer saída: sem posição não há proximidade, e sem
  // proximidade nada deve ser retransmitido. Uma audiência velha sobrevivendo a
  // um tick que falhou faria o relay continuar entregando com base em onde as
  // pessoas estavam, não onde estão.
  _audienceByActor.clear();

  if (typeof mp === 'undefined') return;

  // A posição é lida uma vez por ATOR, não por conexão. Um jogador com helper e
  // UI abertos é uma pessoa num lugar só; iterar conexões faria a mesma posição
  // ser lida duas vezes e o par aparecer duplicado na audiência — cada quadro
  // entregue em dobro pro mesmo ouvinte.
  const actors = [];
  for (const [actorId, entry] of voipClients.entries()) {
    if (!_hasOpenConnection(entry)) continue;
    if (entry.muted) continue;
    try {
      const loc = mp.get(actorId, 'locationalData');
      if (!loc) continue;
      // A célula vem junto com a posição na mesma leitura, e é preciso guardar
      // as duas: cada interior do Skyrim tem origem de coordenadas própria, então
      // `pos` sozinho não diz onde a pessoa está — duas tavernas distintas têm
      // coordenadas na mesma vizinhança numérica.
      actors.push({ actorId, entry, pos: loc.pos, cell: rangeUtils.getCell(loc) });
    } catch { continue; }
  }

  for (const client of actors) {
    const proximityData = [];

    for (const peer of actors) {
      if (peer.actorId === client.actorId) continue;

      // Células diferentes são lugares diferentes, por mais perto que os números
      // fiquem — sem isso a voz atravessa de um interior para outro sem existir
      // caminho entre eles, e o `_audienceByActor` montado aqui é o mesmo que o
      // relay usa pra decidir quem recebe `audio_frame`. Mesma regra que
      // `range-utils.distanceBetween` aplica (`ca !== cb` → Infinity) e que o
      // `nametag-service` já usa. Célula desconhecida de um dos lados não
      // descarta: falta de informação não é prova de estarem separados.
      if (client.cell && peer.cell && client.cell !== peer.cell) continue;

      const dist = distance3D(client.pos, peer.pos);
      const range = VOICE_RANGES[peer.entry.voiceMode || 'normal'];
      const volume = calcVolume(dist, range);

      if (volume > 0) {
        proximityData.push({ actorId: peer.actorId, volume, dist: Math.round(dist) });

        // Mesmo par, visto do outro lado: `peer` fala, `client` ouve naquele
        // volume. É exatamente o número que o `proximity_update` manda pro
        // ganho do WebRTC — os dois caminhos ficam obrigados a concordar
        // porque leem a mesma conta, não uma cópia dela.
        let audience = _audienceByActor.get(peer.actorId);
        if (!audience) {
          audience = [];
          _audienceByActor.set(peer.actorId, audience);
        }
        audience.push({ actorId: client.actorId, volume });
      }
    }

    // O mapa de volume vai só pro `listener`: é ele que tem ganho pra ajustar.
    // Um ator que só tem `sender` aberto (helper sem UI) continua entrando na
    // audiência dos outros — ele fala —, apenas não tem pra onde receber.
    const listener = _openListener(client.actorId);
    if (listener) {
      listener.ws.send(JSON.stringify({ type: 'proximity_update', peers: proximityData }));
    }
  }
}

/**
 * Retransmite um `audio_frame` para quem está em alcance do locutor, anexando o
 * volume que aquele ouvinte específico deve aplicar.
 *
 * O servidor não olha dentro de `data` — não decodifica, não mistura, não
 * transcodifica. Mixagem no servidor economizaria banda de descida, mas exigiria
 * decodificar e somar N fluxos por ouvinte a cada 20ms; para uma prova de
 * conceito isso é trocar um problema provado por um não provado. Ver
 * `docs/technical/VOICE_NATIVE_HELPER.md` §5.
 *
 * @param {number} fromActorId locutor já autenticado
 * @param {object} msg mensagem recebida (usa-se apenas `seq` e `data`)
 * @returns {number} quantos ouvintes receberam — usado por teste e log
 */
function relayAudioFrame(fromActorId, msg) {
  const audience = _audienceByActor.get(fromActorId);
  if (!audience || audience.length === 0) return 0;

  let delivered = 0;
  for (const listener of audience) {
    // Sempre a conexão `listener` do ouvinte, nunca um `sender` dele: o helper
    // do outro não toca nada, e mandar áudio pra lá seria gastar banda pra que
    // um processo o descarte. A audiência já exclui o próprio locutor (o tick
    // pula `peer.actorId === client.actorId`), então o `listener` de quem fala
    // não recebe a própria voz de volta — isso seria eco, não voz.
    const client = _openListener(listener.actorId);
    if (!client) continue;

    // Serializado por ouvinte porque o `volume` muda por ouvinte. Custa uma
    // cópia do payload por destinatário; com PCM cru isso é ~2,5KB cada. Está
    // registrado como item da Fase 2 (com Opus o payload cai ~30x, e aí o
    // desperdício deixa de importar).
    client.ws.send(JSON.stringify({
      type: 'audio_frame',
      fromActorId,
      volume: listener.volume,
      seq: msg.seq,
      data: msg.data
    }));
    delivered++;
  }
  return delivered;
}

/**
 * Calcula o volume (0.0 ~ 1.0) com base na distancia e no alcance.
 */
function calcVolume(dist, maxRange) {
  if (dist >= maxRange) return 0;
  // Queda linear com minimo de 0.05 para quem esta muito perto
  return Math.max(0, Math.min(1, 1 - (dist / maxRange)));
}

function distance3D(a, b) {
  return Math.sqrt(
    Math.pow(a[0] - b[0], 2) +
    Math.pow(a[1] - b[1], 2) +
    Math.pow(a[2] - b[2], 2)
  );
}

/**
 * Envia para o `listener` de todo mundo, menos o excluído.
 *
 * Só listeners: o que passa por aqui hoje é `peer_left`, que existe pra UI
 * desmontar o áudio de quem saiu. O helper não tem o que desmontar.
 */
function broadcast(msg, excludeActorId) {
  const raw = JSON.stringify(msg);
  for (const actorId of voipClients.keys()) {
    if (actorId === excludeActorId) continue;
    const listener = _openListener(actorId);
    if (listener) listener.ws.send(raw);
  }
}

/**
 * Retorna todos os atores conectados ao VOIP (para debug).
 */
function getConnectedVoipActors() {
  return [...voipClients.keys()];
}

/**
 * Porta em que o servidor está realmente escutando — útil em testes que
 * sobem o servidor em port:0 (porta efêmera escolhida pelo SO).
 * @returns {number|null}
 */
function getListeningPort() {
  if (!wss) return null;
  const addr = wss.address(); // null até o bind assíncrono terminar (evento 'listening')
  return addr ? addr.port : null;
}

/**
 * Encerra o servidor de sinalização e todos os sockets antes de devolver.
 * O await é o que permite reiniciar imediatamente sem encontrar a porta ainda
 * ocupada. Tickets e estado transitório também não sobrevivem ao lifecycle.
 */
async function stopVoipServer() {
  if (_proximityTimer) clearInterval(_proximityTimer);
  _proximityTimer = null;
  _audienceByActor.clear();
  _pendingTickets.clear();

  if (!wss) {
    voipClients.clear();
    return;
  }
  const server = wss;
  wss = null;

  // `WebSocketServer.close()` espera clientes conectados encerrarem. Durante
  // shutdown não existe negociação útil a preservar; terminar primeiro evita
  // o processo ficar preso indefinidamente por um cliente morto ou hostil.
  for (const socket of server.clients) {
    try { socket.terminate(); } catch { /* já encerrado */ }
  }

  try {
    await new Promise((resolve, reject) => {
      server.close((err) => {
        if (err && err.code !== 'ERR_SERVER_NOT_RUNNING') reject(err);
        else resolve();
      });
    });
  } finally {
    voipClients.clear();
  }
}

/**
 * Comando /voz: opt-in explícito — voz por proximidade não é forçada em todo
 * mundo (ver SKYMP_RP_DEVELOPMENT_PLAN.md, "Se voice chat é obrigatório" segue
 * uma decisão em aberto). Emite um ticket e empurra pro cliente via a property
 * SkyMP voipTicket (mesmo padrão comprovado de browserModal/panelData).
 */
function requestVoiceConnection(actorId) {
  const character = commands.getActiveCharacterData(actorId);
  if (!character) {
    commands.sendNotification(actorId, 'Seu personagem ainda nao esta carregado.');
    return;
  }

  // Dois tickets, um por papel. O da UI vai pela property, como sempre; o do
  // helper é emitido sempre, esteja ou não exposto — emitir é barato (expira em
  // 30s sem uso) e assim a EXPOSIÇÃO, que é a parte arriscada, fica sendo a
  // única coisa atrás da flag. Um ticket só não serviria: é de uso único, e
  // quem chegasse primeiro queimaria o do outro.
  const ticket = issueTicket(actorId, 'listener');
  const senderTicket = issueTicket(actorId, 'sender');

  _exposeDebugTicket(actorId, senderTicket);

  if (typeof mp === 'undefined') return;
  try {
    mp.set(actorId, 'voipTicket', {
      actorId,
      ticket,
      host: VOIP_PUBLIC_HOST,
      port: VOIP_PORT,
      sentAt: Date.now()
    });
  } catch (err) {
    console.error('[voip] Falha ao enviar ticket de voz:', err.message);
  }
}

/**
 * ⚠️ ANDAIME DE TESTE — TEMPORÁRIO. Remover junto com a Fase 3.
 *
 * Escreve o ticket do `sender` num arquivo local e loga em `warn`, pra que uma
 * pessoa testando consiga copiá-lo pro `--ticket` do `voice-helper.exe`. Hoje o
 * ticket só existe dentro da property `voipTicket`, que é lida pelo navegador do
 * jogo — não há como um humano vê-lo.
 *
 * Por que atrás de flag, desligada por padrão: isto grava em disco, em texto
 * puro, uma credencial que autentica como aquele jogador na cena de voz. Vale 30
 * segundos, o que limita o estrago, e ainda assim quem ler o arquivo dentro da
 * janela fala pela boca da pessoa. É aceitável numa bancada com um engenheiro
 * olhando, e em nenhum outro lugar.
 *
 * A Fase 3 (handoff automático, jogo → helper, sem intervenção manual) substitui
 * isto por completo, e esta função e a flag devem sumir junto.
 * Ver `docs/technical/VOICE_NATIVE_HELPER.md` §11.
 */
function _exposeDebugTicket(actorId, senderTicket) {
  if (!_debugExposeTicketEnabled()) return;

  const payload = {
    actorId,
    actorIdHex: `0x${actorId.toString(16).toUpperCase()}`,
    ticket: senderTicket,
    role: 'sender',
    host: VOIP_PUBLIC_HOST,
    port: VOIP_PORT,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + TICKET_TTL_MS).toISOString(),
    ttlSeconds: TICKET_TTL_MS / 1000,
    aviso: 'ANDAIME DE TESTE. Desligue VOIP_DEBUG_EXPOSE_TICKET depois do teste.'
  };

  console.warn(
    `[voip] ⚠️  VOIP_DEBUG_EXPOSE_TICKET ligado — ticket de 'sender' exposto em texto puro.\n` +
    `[voip]     voice-helper.exe --actor-id ${payload.actorIdHex} --ticket ${senderTicket} ` +
    `--host ${VOIP_PUBLIC_HOST} --port ${VOIP_PORT}\n` +
    `[voip]     Vale ${payload.ttlSeconds}s. Desligue a flag depois do teste.`
  );

  // O arquivo é conveniência; falhar em escrevê-lo não pode derrubar o /voz —
  // o log acima já entregou o ticket.
  try {
    fs.writeFileSync(VOIP_DEBUG_TICKET_FILE, JSON.stringify(payload, null, 2));
  } catch (err) {
    console.warn(`[voip] Não consegui escrever ${VOIP_DEBUG_TICKET_FILE}: ${err.message}`);
  }
}

function commandDefs() {
  return [
    {
      name: ['/voz', '/voice'],
      description: 'Conecta ao chat de voz por proximidade (opt-in)',
      usage: '/voz',
      handler: (actorId) => requestVoiceConnection(actorId)
    }
  ];
}

module.exports = {
  commandDefs,
  startVoipServer,
  stopVoipServer,
  getConnectedVoipActors,
  getListeningPort,
  issueTicket,
  requestVoiceConnection,
  // Formato do áudio no fio — o helper nativo e a UI precisam concordar com isto.
  AUDIO_SAMPLE_RATE,
  AUDIO_CHANNELS,
  AUDIO_FRAME_MS,
  MAX_AUDIO_FRAME_B64,
  AUDIO_FRAME_RATE_PER_SECOND,
  AUDIO_FRAME_BURST,
  MAX_VOIP_MESSAGE_BYTES,
  // `tickProximity` é chamado pelo ticker de 2s em produção; exposto porque o
  // teste do relay precisa de um tick determinístico em vez de esperar o timer.
  tickProximity,
  calcVolume,
  // Papéis de conexão — o helper manda 'sender', a UI não manda nada e vira
  // 'listener'. Ver `voipClients` e VOICE_NATIVE_HELPER.md §10.
  VOIP_ROLES,
  DEFAULT_VOIP_ROLE,
  // Exposto só pra testes
  _consumeTicket,
  _pendingTickets,
  _ticketKey,
  _consumeAudioFrameQuota,
  _isCurrentClientSocket,
  _audienceByActor,
  _voipClients: voipClients,
  _debugExposeTicketEnabled,
  VOIP_DEBUG_TICKET_FILE
};
