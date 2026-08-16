const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createQueue } = require('./queue');

// Relógio controlado — a fila depende de expiração de reserva, e testar isso
// com sleeps reais tornaria a suíte lenta e instável.
function makeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

let ticketCounter = 0;
const makeTicket = () => `ticket-${++ticketCounter}`;

describe('fila — admissão dentro da capacidade', () => {
  test('admite direto quando há slot livre', () => {
    const q = createQueue({ capacity: 2 });
    const res = q.join(1, 'd1', makeTicket);
    assert.equal(res.status, 'success');
    assert.ok(res.ticket);
  });

  test('enfileira quando a capacidade acabou', () => {
    const q = createQueue({ capacity: 1 });
    assert.equal(q.join(1, 'd1', makeTicket).status, 'success');

    const second = q.join(2, 'd2', makeTicket);
    assert.equal(second.status, 'queued');
    assert.equal(second.position, 1);
  });

  test('posições na fila respeitam ordem de chegada', () => {
    const q = createQueue({ capacity: 1 });
    q.join(1, 'd1', makeTicket);
    assert.equal(q.join(2, 'd2', makeTicket).position, 1);
    assert.equal(q.join(3, 'd3', makeTicket).position, 2);
  });
});

describe('fila — idempotência (o launcher faz polling)', () => {
  test('join repetido devolve o mesmo ticket, não um slot novo', () => {
    const q = createQueue({ capacity: 2 });
    const first = q.join(7, 'd7', makeTicket);
    const second = q.join(7, 'd7', makeTicket);

    assert.equal(second.status, 'success');
    assert.equal(second.ticket, first.ticket, 'o ticket precisa ser estável entre chamadas');
    assert.equal(q.snapshot().occupied, 1, 'não pode consumir dois slots pra mesma conta');
  });

  test('join repetido de quem está na fila não cria posição duplicada', () => {
    const q = createQueue({ capacity: 1 });
    q.join(1, 'd1', makeTicket);
    q.join(2, 'd2', makeTicket);

    assert.equal(q.join(2, 'd2', makeTicket).position, 1);
    assert.equal(q.snapshot().waiting, 1);
  });
});

describe('fila — liberação de slot', () => {
  test('release promove o próximo da fila', () => {
    const q = createQueue({ capacity: 1 });
    q.join(1, 'd1', makeTicket);
    q.join(2, 'd2', makeTicket);

    q.release(1, makeTicket);

    const status = q.status(2, makeTicket);
    assert.equal(status.status, 'success', 'quem estava esperando deveria ter sido promovido');
    assert.equal(q.snapshot().waiting, 0);
  });

  test('release de quem não está admitido não quebra nem promove errado', () => {
    const q = createQueue({ capacity: 1 });
    q.join(1, 'd1', makeTicket);
    assert.equal(q.release(999, makeTicket), false);
    assert.equal(q.snapshot().occupied, 1);
  });
});

describe('fila — expiração de reserva', () => {
  test('slot de quem não conectou volta pra fila depois do TTL', () => {
    const clock = makeClock();
    const q = createQueue({ capacity: 1, reservationTtlMs: 60_000, now: clock.now });

    q.join(1, 'd1', makeTicket);
    assert.equal(q.join(2, 'd2', makeTicket).status, 'queued');

    clock.advance(61_000);

    const status = q.status(2, makeTicket);
    assert.equal(status.status, 'success', 'a reserva abandonada precisa liberar o slot');
  });

  test('quem conectou NÃO perde o slot por tempo', () => {
    const clock = makeClock();
    const q = createQueue({ capacity: 1, reservationTtlMs: 60_000, now: clock.now });

    q.join(1, 'd1', makeTicket);
    q.markConnected(1);
    q.join(2, 'd2', makeTicket);

    clock.advance(10 * 60_000);

    assert.equal(q.status(2, makeTicket).status, 'queued', 'jogador em sessão não pode ser expulso pela fila');
    assert.equal(q.snapshot().connected, 1);
  });
});

describe('fila — ticket de sessão', () => {
  test('resolve ticket válido e marca conectado', () => {
    const q = createQueue({ capacity: 2 });
    const { ticket } = q.join(42, 'd42', makeTicket);

    const entry = q.resolveSessionTicket(ticket);
    assert.equal(entry.accountId, 42);
    assert.equal(entry.discordId, 'd42');

    q.markConnected(42);
    assert.equal(q.snapshot().connected, 1);
  });

  test('ticket desconhecido não resolve', () => {
    const q = createQueue({ capacity: 2 });
    q.join(1, 'd1', makeTicket);
    assert.equal(q.resolveSessionTicket('nao-existe'), null);
    assert.equal(q.resolveSessionTicket(''), null);
    assert.equal(q.resolveSessionTicket(undefined), null);
  });

  test('ticket deixa de resolver depois do release', () => {
    const q = createQueue({ capacity: 2 });
    const { ticket } = q.join(5, 'd5', makeTicket);
    q.release(5, makeTicket);
    assert.equal(q.resolveSessionTicket(ticket), null);
  });
});

describe('fila — status de quem nunca entrou', () => {
  test('reporta not_queued', () => {
    const q = createQueue({ capacity: 2 });
    assert.equal(q.status(123, makeTicket).status, 'not_queued');
  });
});

describe('fila — recuperação após restart', () => {
  test('restaura ocupação conectada sem precisar do token em claro', () => {
    const q = createQueue({ capacity: 2 });
    assert.equal(q.restoreAdmissions([
      { accountId: 1, discordId: 'd1', reservedAt: Date.now(), connected: true }
    ]), 1);
    assert.deepEqual(q.snapshot(), { capacity: 2, occupied: 1, connected: 1, waiting: 0 });
    assert.equal(q.resolveSessionTicket('qualquer-token'), null);
  });

  test('restaura acima da capacidade e falha fechado para novas contas', () => {
    const q = createQueue({ capacity: 1 });
    q.restoreAdmissions([
      { accountId: 1, discordId: 'd1', reservedAt: Date.now(), connected: true },
      { accountId: 2, discordId: 'd2', reservedAt: Date.now(), connected: true }
    ]);
    assert.equal(q.join(3, 'd3', makeTicket).status, 'queued');
    assert.equal(q.snapshot().occupied, 2);
  });

  test('reconnect da mesma conta troca estado recuperado por ticket novo sem outro slot', () => {
    const q = createQueue({ capacity: 1 });
    q.restoreAdmissions([
      { accountId: 1, discordId: 'd1', reservedAt: Date.now(), connected: true }
    ]);
    const result = q.join(1, 'd1', makeTicket);
    assert.equal(result.status, 'success');
    assert.ok(result.ticket);
    assert.equal(q.snapshot().occupied, 1);
    assert.equal(q.snapshot().connected, 0);
  });

  test('falha ao persistir reconnect restaura a ocupação e o lease anteriores', () => {
    const q = createQueue({ capacity: 1 });
    q.restoreAdmissions([{
      accountId: 1, discordId: 'd1', reservedAt: Date.now(), connected: true,
      sessionId: 10, leaseHash: 'a'.repeat(64)
    }]);
    const reconnect = q.join(1, 'd1', makeTicket);
    assert.equal(q.snapshot().connected, 0);
    assert.equal(q.restoreSuperseded(1, reconnect.ticket), true);
    assert.equal(q.snapshot().connected, 1);
    assert.equal(q.releaseByLeaseHash('a'.repeat(64)), true);
    assert.equal(q.snapshot().occupied, 0);
  });

  test('polling também renova reserva recuperada sem devolver ticket nulo', () => {
    const q = createQueue({ capacity: 1 });
    q.restoreAdmissions([
      { accountId: 1, discordId: 'd1', reservedAt: Date.now(), connected: false }
    ]);
    const result = q.status(1, makeTicket);
    assert.equal(result.status, 'success');
    assert.equal(typeof result.ticket, 'string');
    assert.equal(q.snapshot().occupied, 1);
  });

  test('reserva recuperada vencida é removida pelo TTL original', () => {
    const clock = makeClock();
    const q = createQueue({ capacity: 1, reservationTtlMs: 1000, now: clock.now });
    q.restoreAdmissions([
      { accountId: 1, discordId: 'd1', reservedAt: clock.now() - 1001, connected: false }
    ]);
    assert.equal(q.snapshot().occupied, 0);
  });

  test('conjunto inválido não publica recuperação parcial', () => {
    const q = createQueue({ capacity: 2 });
    assert.throws(() => q.restoreAdmissions([
      { accountId: 1, discordId: 'd1', reservedAt: Date.now(), connected: true },
      { accountId: 1, discordId: 'd1', reservedAt: Date.now(), connected: true }
    ]), /duplicado/);
    assert.equal(q.snapshot().occupied, 0);
  });

  test('lease duplicado na recuperação falha sem publicar estado parcial', () => {
    const q = createQueue({ capacity: 2 });
    assert.throws(() => q.restoreAdmissions([
      {
        accountId: 1, discordId: 'd1', reservedAt: Date.now(), connected: true,
        sessionId: 10, leaseHash: 'a'.repeat(64)
      },
      {
        accountId: 2, discordId: 'd2', reservedAt: Date.now(), connected: true,
        sessionId: 20, leaseHash: 'a'.repeat(64)
      }
    ]), /lease duplicado/);
    assert.equal(q.snapshot().occupied, 0);
  });
});
