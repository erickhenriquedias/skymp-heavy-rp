/**
 * Testes em nível HTTP do `game-api`.
 *
 * Existem porque `queue.test.js` testa o módulo de fila, não as rotas — então
 * o transporte da credencial (query string versus corpo, GET versus POST) não
 * tinha nenhuma rede de proteção. Foi assim que `SEC-QS-01` passou despercebido.
 *
 * ## Por que isto roda sem MariaDB
 *
 * `consumeLaunchTicket` recusa ticket ausente, não-string ou com menos de 32
 * caracteres **antes** de tocar o banco. Todos os casos aqui caem nessa recusa
 * antecipada, então a suíte não precisa de banco e não fica instável na CI.
 *
 * O preço é o limite declarado abaixo: não dá pra testar o caminho feliz sem
 * um banco. Caminho feliz continua sendo trabalho da sessão de teste real.
 */

process.env.INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || 'test-secret-not-used-here';
process.env.MODS_MANIFEST_PATH = require('node:path').join(
  require('node:os').tmpdir(),
  `skyrp-missing-mods-${process.pid}.json`
);

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const {
  app,
  queue,
  setSessionLeaseServiceForTests,
  setReadinessProbeForTests,
  setMaintenanceForTests
} = require('./server');

setSessionLeaseServiceForTests({
  confirmConnected: async (accountId, sessionId) => ({
    ok: queue.confirmSessionConnected(accountId, sessionId),
    reason: 'admission_not_found'
  }),
  claim: async accountId => {
    const admission = queue.getAdmission(accountId);
    if (!admission?.connected) return { ok: false, reason: 'connected_admission_not_found' };
    return { ok: true, leaseToken: 'lease'.padEnd(64, 'a') };
  },
  release: async leaseToken => typeof leaseToken === 'string' && leaseToken.length >= 32
    ? { ok: true, released: false, stale: true }
    : { ok: false, released: false, reason: 'invalid_lease' }
});

let server;
let baseUrl;

before(async () => {
  await new Promise((resolve) => {
    // Porta 0 = o SO escolhe uma livre. Fixar porta faria a suíte brigar com
    // um game-api rodando na máquina do dev.
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

function request(method, path, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      `${baseUrl}${path}`,
      {
        method,
        headers: payload
          ? { ...headers, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : headers
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(data); } catch { /* corpo não-JSON é resultado válido de teste */ }
          resolve({ status: res.statusCode, body: parsed, raw: data });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Ticket com formato plausível: 64 hex, o mesmo tamanho que `makeSessionTicket`
// produz. Se alguma rota voltar a ler da query string, este valor passa do
// filtro de tamanho e o comportamento muda de forma observável.
const PLAUSIBLE_TICKET = 'a'.repeat(64);

describe('SEC-QS-01 — o ticket não viaja em query string', () => {
  test('GET /api/queue/status não existe mais', async () => {
    const res = await request('GET', `/api/queue/status?ticket=${PLAUSIBLE_TICKET}`);

    // 404 é a resposta do Express pra método sem rota registrada. Se isto voltar
    // a ser 200/401/500, o GET foi reintroduzido e o ticket voltou pra URL.
    assert.equal(res.status, 404, 'GET foi reintroduzido — o ticket voltou pra query string');
  });

  test('POST /api/queue/status ignora ticket vindo da query string', async () => {
    const res = await request('POST', `/api/queue/status?ticket=${PLAUSIBLE_TICKET}`, { body: {} });

    assert.equal(res.status, 401);
    assert.equal(res.body.message, 'invalid_ticket');
  });

  test('query string não muda a resposta em relação a não mandar ticket nenhum', async () => {
    const semTicket = await request('POST', '/api/queue/status', { body: {} });
    const comQuery = await request('POST', `/api/queue/status?ticket=${PLAUSIBLE_TICKET}`, { body: {} });

    assert.deepEqual(comQuery.body, semTicket.body);
    assert.equal(comQuery.status, semTicket.status);
  });

  test('POST /api/queue/join também ignora a query string', async () => {
    const res = await request('POST', `/api/queue/join?ticket=${PLAUSIBLE_TICKET}`, { body: {} });

    assert.equal(res.status, 401);
    assert.equal(res.body.message, 'invalid_ticket');
  });
});

describe('fila — recusa antes de tocar o banco', () => {
  for (const [nome, body] of [
    ['corpo vazio', {}],
    ['ticket nulo', { ticket: null }],
    ['ticket numérico', { ticket: 12345678901234567890123456789012 }],
    ['ticket curto demais', { ticket: 'abc' }],
    ['ticket com 31 caracteres', { ticket: 'a'.repeat(31) }]
  ]) {
    test(`status recusa ${nome} com 401`, async () => {
      const res = await request('POST', '/api/queue/status', { body });
      assert.equal(res.status, 401);
      assert.equal(res.body.message, 'invalid_ticket');
    });

    test(`join recusa ${nome} com 401`, async () => {
      const res = await request('POST', '/api/queue/join', { body });
      assert.equal(res.status, 401);
      assert.equal(res.body.message, 'invalid_ticket');
    });
  }

  test('requisição sem corpo nenhum não derruba a rota', async () => {
    // `express.json()` deixa `req.body` indefinido quando não há corpo. A rota
    // faz `(req.body || {}).ticket` justamente por isso; se alguém tirar esse
    // guarda, isto vira 500.
    const res = await request('POST', '/api/queue/status');
    assert.equal(res.status, 401);
  });
});

describe('endpoints internos exigem segredo', () => {
  test('session/resolve sem X-Internal-Secret responde 401', async () => {
    const res = await request('POST', '/internal/session/resolve', { body: { session: 'x' } });
    assert.equal(res.status, 401);
  });

  test('session/release sem X-Internal-Secret responde 401', async () => {
    const res = await request('POST', '/internal/session/release', { body: { session: 'x' } });
    assert.equal(res.status, 401);
  });

  test('session/connected sem X-Internal-Secret responde 401', async () => {
    const res = await request('POST', '/internal/session/connected', { body: { accountId: 42 } });
    assert.equal(res.status, 401);
  });

  test('session/claim sem X-Internal-Secret responde 401', async () => {
    const res = await request('POST', '/internal/session/claim', { body: { accountId: 42 } });
    assert.equal(res.status, 401);
  });
});

describe('confirmação interna da ocupação', () => {
  const headers = { 'X-Internal-Secret': 'test-secret-not-used-here' };

  test('recusa conta que não possui admissão', async () => {
    const res = await request('POST', '/internal/session/connected', {
      headers,
      body: { accountId: 999999, sessionId: 999999 }
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'admission_not_found');
  });

  test('marca admissão existente como conectada', async () => {
    const ticket = queue.join(4242, 'discord-4242', () => 'session-ticket-4242').ticket;
    assert.equal(queue.bindSession(4242, ticket, 42420), true);
    const res = await request('POST', '/internal/session/connected', {
      headers,
      body: { accountId: 4242, sessionId: 42420 }
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true, marked: true });
    assert.equal(queue.snapshot().connected, 1);
    queue.release(4242);
  });

  test('recusa sessionId ausente antes do serviço', async () => {
    const res = await request('POST', '/internal/session/connected', {
      headers,
      body: { accountId: 7 }
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_session_id');
  });

  test('claim exige uma admissão conectada', async () => {
    const res = await request('POST', '/internal/session/claim', {
      headers,
      body: { accountId: 999998 }
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'connected_admission_not_found');
  });

  test('release recusa lease inválido e aceita disconnect antigo idempotente', async () => {
    const invalid = await request('POST', '/internal/session/release', {
      headers,
      body: { leaseToken: 'curto' }
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.reason, 'invalid_lease');

    const stale = await request('POST', '/internal/session/release', {
      headers,
      body: { leaseToken: 'old'.padEnd(64, 'x') }
    });
    assert.equal(stale.status, 200);
    assert.deepEqual(stale.body, { ok: true, released: false, stale: true });
  });
});

describe('liveness e readiness separados', () => {
  test('/health confirma somente o processo e não expõe fila ou manifesto', async () => {
    const res = await request('GET', '/health');

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
    assert.equal(res.body.queue, undefined);
    assert.equal(res.body.manifest, undefined);
  });

  test('/ready responde 200 somente quando todas as dependências estão prontas', async () => {
    setReadinessProbeForTests(async () => ({
      ready: true,
      checks: { database: 'ok', manifest: 'ok', maintenance: 'inactive' }
    }));
    try {
      const res = await request('GET', '/ready');
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, {
        ready: true,
        checks: { database: 'ok', manifest: 'ok', maintenance: 'inactive' }
      });
    } finally {
      setReadinessProbeForTests(null);
    }
  });

  test('/ready responde 503 quando MariaDB não está disponível', async () => {
    setReadinessProbeForTests(async () => ({
      ready: false,
      checks: { database: 'unavailable', manifest: 'ok', maintenance: 'inactive' }
    }));
    try {
      const res = await request('GET', '/ready');
      assert.equal(res.status, 503);
      assert.equal(res.body.ready, false);
      assert.equal(res.body.checks.database, 'unavailable');
    } finally {
      setReadinessProbeForTests(null);
    }
  });

  test('exceção do probe falha fechado sem vazar mensagem interna', async () => {
    setReadinessProbeForTests(async () => { throw new Error('senha do banco apareceu aqui'); });
    try {
      const res = await request('GET', '/ready');
      assert.equal(res.status, 503);
      assert.equal(res.raw.includes('senha do banco'), false);
    } finally {
      setReadinessProbeForTests(null);
    }
  });
});

describe('modo de manutenção', () => {
  test('join e status retornam maintenance antes de consumir qualquer ticket', async () => {
    setMaintenanceForTests(true, 'Retornamos às 20h.');
    try {
      const join = await request('POST', '/api/queue/join', { body: {} });
      const status = await request('POST', '/api/queue/status', { body: {} });
      assert.equal(join.status, 503);
      assert.deepEqual(join.body, { status: 'maintenance', message: 'Retornamos às 20h.' });
      assert.deepEqual(status.body, join.body);
    } finally {
      setMaintenanceForTests(false);
    }
  });

  test('/status anuncia manutenção sem depender de banco ou manifesto', async () => {
    setMaintenanceForTests(true, 'Atualização do modpack.');
    setReadinessProbeForTests(async () => { throw new Error('não deveria ser chamado'); });
    try {
      const res = await request('GET', '/status');
      assert.equal(res.status, 200);
      assert.equal(res.body.state, 'maintenance');
      assert.equal(res.body.message, 'Atualização do modpack.');
      assert.equal(Number.isInteger(res.body.players), true);
    } finally {
      setReadinessProbeForTests(null);
      setMaintenanceForTests(false);
    }
  });
});

describe('status público', () => {
  test('expõe somente contagens agregadas quando online', async () => {
    setReadinessProbeForTests(async () => ({ ready: true }));
    try {
      const res = await request('GET', '/status');
      assert.equal(res.status, 200);
      assert.ok(['online', 'full'].includes(res.body.state));
      assert.equal(Number.isInteger(res.body.players), true);
      assert.equal(Number.isInteger(res.body.capacity), true);
      assert.equal(Number.isInteger(res.body.queue), true);
      assert.equal(JSON.stringify(res.body).includes('discord'), false);
      assert.equal(JSON.stringify(res.body).includes('ticket'), false);
    } finally {
      setReadinessProbeForTests(null);
    }
  });

  test('dependência indisponível vira starting, sem detalhes internos', async () => {
    setReadinessProbeForTests(async () => ({ ready: false }));
    try {
      const res = await request('GET', '/status');
      assert.equal(res.body.state, 'starting');
      assert.equal(Object.hasOwn(res.body, 'checks'), false);
    } finally {
      setReadinessProbeForTests(null);
    }
  });

  test('consultas concorrentes compartilham um único probe de readiness', async () => {
    let probes = 0;
    setReadinessProbeForTests(async () => {
      probes += 1;
      await new Promise(resolve => setTimeout(resolve, 5));
      return { ready: true };
    });
    try {
      const responses = await Promise.all(Array.from({ length: 10 }, () => request('GET', '/status')));
      assert.equal(responses.every(response => response.status === 200), true);
      assert.equal(probes, 1);
    } finally {
      setReadinessProbeForTests(null);
    }
  });
});

describe('manifesto indisponível falha fechado no transporte HTTP', () => {
  test('GET /mods.json responde 503, nunca 200 com listas vazias', async () => {
    const res = await request('GET', '/mods.json');
    assert.equal(res.status, 503);
    assert.equal(res.body.error, 'Manifesto de mods indisponivel no servidor.');
    assert.equal(res.body.mods, undefined);
    assert.equal(res.body.loadOrder, undefined);
  });
});

/**
 * ## O que esta suíte NÃO prova
 *
 * - **Nada do caminho feliz.** Todo caso aqui termina em recusa antecipada.
 *   Ticket válido, admissão, emissão de `pollTicket` e persistência de sessão
 *   exigem MariaDB e continuam sem cobertura automatizada.
 * - **Não prova ausência de leitura da query string quando há banco.** Com um
 *   banco disponível, uma regressão que lesse `req.query.ticket` também
 *   devolveria 401 (o ticket não existiria na tabela). O que trava a regressão
 *   de verdade é o teste do GET 404: reverter o transporte sem reverter o
 *   método é improvável, e o método é observável sem banco.
 */
