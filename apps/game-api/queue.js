/**
 * queue.js
 *
 * Fila de entrada do servidor, sem dependência de rede nem de banco — tudo
 * aqui é pura manipulação de estado em memória, pra que dê pra testar a
 * política de admissão sem subir nada.
 *
 * Modelo: capacidade fixa de slots. Quem chega e encontra slot livre entra
 * direto; quem não encontra fica numa fila FIFO e é promovido quando um slot
 * vaga. Um slot vaga quando o jogador desconecta (o gamemode avisa) ou quando
 * a reserva expira sem ele ter aparecido no jogo.
 *
 * A expiração de reserva é o que impede a fila de travar: sem ela, um jogador
 * que fecha o launcher depois de ser admitido seguraria o slot pra sempre e a
 * fila inteira ficaria parada atrás dele.
 */

// Quanto tempo um jogador admitido tem pra efetivamente entrar no jogo antes
// de o slot voltar pra fila. Precisa cobrir o boot do Skyrim + SKSE, que não é
// rápido — daí o valor generoso.
const DEFAULT_RESERVATION_TTL_MS = 3 * 60 * 1000;

function createQueue(options = {}) {
  const capacity = Number.isInteger(options.capacity) && options.capacity > 0 ? options.capacity : 40;
  const reservationTtlMs = options.reservationTtlMs || DEFAULT_RESERVATION_TTL_MS;
  const now = options.now || (() => Date.now());

  // accountId -> admissão atual. sessionId liga a fila à linha exata do banco;
  // leaseHash liga o disconnect à conexão exata sem guardar o token em claro.
  const _admitted = new Map();
  const _accountByLeaseHash = new Map();
  // Lista ordenada de { accountId, discordId, joinedAt }
  let _waiting = [];

  /**
   * Devolve slots cujas reservas expiraram sem o jogador ter conectado.
   * Chamado no início de toda operação — é mais simples e mais confiável que
   * manter um timer por reserva.
   */
  function _reapExpired() {
    const t = now();
    for (const [accountId, entry] of _admitted) {
      if (entry.connected) continue;
      if (t - entry.reservedAt > reservationTtlMs) {
        if (entry.leaseHash) _accountByLeaseHash.delete(entry.leaseHash);
        _admitted.delete(accountId);
      }
    }
  }

  function _promoteFromWaiting(makeTicket) {
    while (_admitted.size < capacity && _waiting.length > 0) {
      const next = _waiting.shift();
      _admitted.set(next.accountId, {
        accountId: next.accountId,
        discordId: next.discordId,
        sessionTicket: makeTicket(next.accountId),
        reservedAt: now(),
        connected: false,
        recovered: false,
        sessionId: null,
        leaseHash: null,
        superseded: null
      });
    }
  }

  function _resultForAdmitted(entry, discordId, makeTicket, rotateConnected = false) {
    if (!entry.recovered && !(rotateConnected && entry.connected)) {
      return { status: 'success', ticket: entry.sessionTicket };
    }

    const ticket = makeTicket(entry.accountId);
    if (entry.leaseHash) _accountByLeaseHash.delete(entry.leaseHash);
    _admitted.set(entry.accountId, {
      accountId: entry.accountId,
      discordId: discordId || entry.discordId,
      sessionTicket: ticket,
      reservedAt: now(),
      connected: false,
      recovered: false,
      sessionId: null,
      leaseHash: null,
      // Mantém a ocupação anterior até o INSERT da sessão nova confirmar. Se
      // o MariaDB falhar, a fila restaura este estado e não abre um slot falso.
      superseded: entry.connected ? { ...entry, superseded: null } : null
    });
    return { status: 'success', ticket };
  }

  /**
   * Pede entrada. Idempotente por conta: chamar duas vezes não cria duas
   * posições nem dois slots — o launcher faz polling, então repetição é o caso
   * normal, não a exceção.
   *
   * @returns {{status:'success', ticket:string} | {status:'queued', position:number}}
   */
  function join(accountId, discordId, makeTicket) {
    _reapExpired();

    const existing = _admitted.get(accountId);
    if (existing) {
      // Após restart só recuperamos a ocupação, nunca o token em claro. Se a
      // mesma conta pede reconnect, ela substitui a reserva recuperada por um
      // ticket novo sem consumir um segundo slot.
      return _resultForAdmitted(existing, discordId, makeTicket, true);
    }

    const waitingIndex = _waiting.findIndex((e) => e.accountId === accountId);
    if (waitingIndex !== -1) {
      _promoteFromWaiting(makeTicket);
      const promoted = _admitted.get(accountId);
      if (promoted) return { status: 'success', ticket: promoted.sessionTicket };
      return { status: 'queued', position: _waiting.findIndex((e) => e.accountId === accountId) + 1 };
    }

    if (_admitted.size < capacity) {
      const ticket = makeTicket(accountId);
      _admitted.set(accountId, {
        accountId, discordId, sessionTicket: ticket, reservedAt: now(),
        connected: false, recovered: false, sessionId: null, leaseHash: null,
        superseded: null
      });
      return { status: 'success', ticket };
    }

    _waiting.push({ accountId, discordId, joinedAt: now() });
    return { status: 'queued', position: _waiting.length };
  }

  /**
   * Consulta sem efeito colateral de entrada — mas ainda promove quem estiver
   * esperando, porque o polling é o único momento em que descobrimos que uma
   * reserva expirou.
   */
  function status(accountId, makeTicket) {
    _reapExpired();
    _promoteFromWaiting(makeTicket);

    const admitted = _admitted.get(accountId);
    if (admitted) return _resultForAdmitted(admitted, admitted.discordId, makeTicket);

    const index = _waiting.findIndex((e) => e.accountId === accountId);
    if (index !== -1) return { status: 'queued', position: index + 1 };

    return { status: 'not_queued' };
  }

  /** O gamemode confirma que o jogador entrou: a reserva vira ocupação real. */
  function markConnected(accountId) {
    const entry = _admitted.get(accountId);
    if (!entry) return false;
    entry.connected = true;
    return true;
  }

  /** O gamemode avisa que o jogador saiu: o slot volta pra fila. */
  function release(accountId, makeTicket) {
    const entry = _admitted.get(accountId);
    if (entry?.leaseHash) _accountByLeaseHash.delete(entry.leaseHash);
    const removed = _admitted.delete(accountId);
    _waiting = _waiting.filter((e) => e.accountId !== accountId);
    if (removed && makeTicket) _promoteFromWaiting(makeTicket);
    return removed;
  }

  function bindSession(accountId, sessionTicket, sessionId) {
    const entry = _admitted.get(accountId);
    if (!entry || entry.sessionTicket !== sessionTicket) return false;
    if (!Number.isSafeInteger(sessionId) || sessionId <= 0) return false;
    entry.sessionId = sessionId;
    entry.superseded = null;
    return true;
  }

  function restoreSuperseded(accountId, sessionTicket) {
    const entry = _admitted.get(accountId);
    if (!entry || entry.sessionTicket !== sessionTicket || !entry.superseded) return false;
    const previous = entry.superseded;
    _admitted.set(accountId, previous);
    if (previous.leaseHash) _accountByLeaseHash.set(previous.leaseHash, accountId);
    return true;
  }

  function confirmSessionConnected(accountId, sessionId) {
    const entry = _admitted.get(accountId);
    if (!entry || entry.sessionId !== sessionId) return false;
    entry.connected = true;
    return true;
  }

  function getAdmission(accountId) {
    const entry = _admitted.get(accountId);
    return entry ? { ...entry } : null;
  }

  function setConnectionLease(accountId, sessionId, leaseHash) {
    const entry = _admitted.get(accountId);
    if (!entry || entry.sessionId !== sessionId || !entry.connected) return false;
    if (typeof leaseHash !== 'string' || leaseHash.length !== 64) return false;
    if (entry.leaseHash) _accountByLeaseHash.delete(entry.leaseHash);
    entry.leaseHash = leaseHash;
    _accountByLeaseHash.set(leaseHash, accountId);
    return true;
  }

  function releaseByLeaseHash(leaseHash, makeTicket) {
    const accountId = _accountByLeaseHash.get(leaseHash);
    if (!accountId) return false;
    const entry = _admitted.get(accountId);
    if (!entry || entry.leaseHash !== leaseHash) {
      _accountByLeaseHash.delete(leaseHash);
      return false;
    }
    return release(accountId, makeTicket);
  }

  /** Valida um ticket de sessão. Usado pelo gamemode ao aceitar a conexão. */
  function resolveSessionTicket(ticket) {
    if (!ticket) return null;
    for (const entry of _admitted.values()) {
      if (entry.sessionTicket === ticket) return entry;
    }
    return null;
  }

  /**
   * Reidrata somente a ocupação depois de um restart. Tokens são irreversíveis
   * no banco e deliberadamente não fazem parte deste estado.
   */
  function restoreAdmissions(entries) {
    if (!Array.isArray(entries)) throw new TypeError('entries deve ser array');
    if (_admitted.size > 0 || _waiting.length > 0) {
      throw new Error('fila precisa estar vazia antes da recuperação');
    }

    const restored = new Map();
    const restoredLeaseHashes = new Set();
    for (const entry of entries) {
      if (!entry || !Number.isSafeInteger(entry.accountId) || entry.accountId <= 0) {
        throw new TypeError('accountId inválido na recuperação');
      }
      if (typeof entry.discordId !== 'string' || entry.discordId.length === 0) {
        throw new TypeError('discordId inválido na recuperação');
      }
      if (!Number.isFinite(entry.reservedAt) || typeof entry.connected !== 'boolean') {
        throw new TypeError('estado inválido na recuperação');
      }
      if (restored.has(entry.accountId)) throw new Error('accountId duplicado na recuperação');
      const leaseHash = typeof entry.leaseHash === 'string' && entry.leaseHash.length === 64
        ? entry.leaseHash
        : null;
      if (leaseHash && restoredLeaseHashes.has(leaseHash)) {
        throw new Error('connection lease duplicado na recuperação');
      }
      if (leaseHash) restoredLeaseHashes.add(leaseHash);
      restored.set(entry.accountId, {
        accountId: entry.accountId,
        discordId: entry.discordId,
        sessionTicket: null,
        reservedAt: entry.reservedAt,
        connected: entry.connected,
        recovered: true,
        sessionId: Number.isSafeInteger(entry.sessionId) && entry.sessionId > 0 ? entry.sessionId : null,
        leaseHash,
        superseded: null
      });
    }

    // Só publica depois de validar o conjunto inteiro: linha ruim não deixa a
    // fila parcialmente restaurada.
    for (const [accountId, entry] of restored) {
      _admitted.set(accountId, entry);
      if (entry.leaseHash) _accountByLeaseHash.set(entry.leaseHash, accountId);
    }
    _reapExpired();
    return _admitted.size;
  }

  function snapshot() {
    _reapExpired();
    return {
      capacity,
      occupied: _admitted.size,
      connected: Array.from(_admitted.values()).filter((e) => e.connected).length,
      waiting: _waiting.length
    };
  }

  return {
    join,
    status,
    markConnected,
    release,
    resolveSessionTicket,
    bindSession,
    restoreSuperseded,
    confirmSessionConnected,
    getAdmission,
    setConnectionLease,
    releaseByLeaseHash,
    restoreAdmissions,
    snapshot
  };
}

module.exports = { createQueue, DEFAULT_RESERVATION_TTL_MS };
