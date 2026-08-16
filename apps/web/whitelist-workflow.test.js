'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
  WhitelistWorkflowError,
  submitWhitelistApplication,
  reviewWhitelistApplication
} = require('./whitelist-workflow');

function createPool(handler) {
  const log = [];
  const connection = {
    beginTransaction: async () => log.push({ type: 'begin' }),
    execute: async (sql, params = []) => {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      log.push({ type: 'execute', sql: normalized, params });
      return [await handler(normalized, params), []];
    },
    commit: async () => log.push({ type: 'commit' }),
    rollback: async () => log.push({ type: 'rollback' }),
    release: () => log.push({ type: 'release' })
  };
  return {
    log,
    pool: { getConnection: async () => connection }
  };
}

const application = {
  first_name: 'Ralof',
  last_name: 'de Riverwood',
  biography: 'biografia',
  motivations: 'motivacoes',
  weaknesses: 'fraquezas',
  social_ties: 'lacos',
  needsExtraReview: 0
};

describe('envio atômico da whitelist', () => {
  test('cria personagem e candidatura vinculados na mesma transação', async () => {
    const { pool, log } = createPool((sql) => {
      if (/SELECT id, status FROM accounts/.test(sql)) return [{ id: 7, status: 'active' }];
      if (/FROM whitelist_applications/.test(sql)) return [];
      if (/INSERT INTO characters/.test(sql)) return { insertId: 31, affectedRows: 1 };
      if (/INSERT INTO whitelist_applications/.test(sql)) return { insertId: 41, affectedRows: 1 };
      throw new Error(`SQL inesperado: ${sql}`);
    });

    const result = await submitWhitelistApplication(pool, 7, application);

    assert.deepEqual(result, { applicationId: 41, characterId: 31 });
    assert.deepEqual(log.filter(item => item.type !== 'execute').map(item => item.type), [
      'begin', 'commit', 'release'
    ]);
    const accountLock = log.find(item => /FROM accounts/.test(item.sql));
    assert.match(accountLock.sql, /FOR UPDATE$/);
    const insert = log.find(item => /INSERT INTO whitelist_applications/.test(item.sql));
    assert.deepEqual(insert.params, [7, 31]);
  });

  test('falha no segundo INSERT desfaz o personagem e libera a conexão', async () => {
    const failure = new Error('deadlock simulado no INSERT da candidatura');
    const { pool, log } = createPool((sql) => {
      if (/SELECT id, status FROM accounts/.test(sql)) return [{ id: 7, status: 'active' }];
      if (/FROM whitelist_applications/.test(sql)) return [];
      if (/INSERT INTO characters/.test(sql)) return { insertId: 31, affectedRows: 1 };
      if (/INSERT INTO whitelist_applications/.test(sql)) throw failure;
      throw new Error(`SQL inesperado: ${sql}`);
    });

    await assert.rejects(submitWhitelistApplication(pool, 7, application), failure);
    assert.deepEqual(log.filter(item => item.type !== 'execute').map(item => item.type), [
      'begin', 'rollback', 'release'
    ]);
  });

  test('candidatura ativa é recusada sob o lock da conta', async () => {
    const { pool, log } = createPool((sql) => {
      if (/FROM accounts/.test(sql)) return [{ id: 7, status: 'active' }];
      if (/FROM whitelist_applications/.test(sql)) return [{ id: 9, status: 'pending' }];
      throw new Error(`SQL inesperado: ${sql}`);
    });

    await assert.rejects(
      submitWhitelistApplication(pool, 7, application),
      (error) => error instanceof WhitelistWorkflowError
        && error.code === 'ACTIVE_APPLICATION_EXISTS'
    );
    assert.equal(log.some(item => /INSERT INTO characters/.test(item.sql || '')), false);
    assert.equal(log.some(item => item.type === 'rollback'), true);
  });
});

function reviewHandler(overrides = {}) {
  return (sql) => {
    if (/SELECT account_id FROM whitelist_applications/.test(sql)) return [{ account_id: 7 }];
    if (/SELECT id FROM accounts/.test(sql)) return [{ id: 7 }];
    if (/SELECT id, account_id, character_id, status/.test(sql)) {
      const applicationStatus = overrides.applicationStatus || 'pending';
      return [{
        id: 41,
        account_id: 7,
        character_id: 31,
        status: applicationStatus,
        approval_source: overrides.approvalSource === undefined
          ? (applicationStatus === 'approved' ? 'staff' : null)
          : overrides.approvalSource
      }];
    }
    if (/SELECT id, status FROM characters/.test(sql)) {
      return [{ id: 31, status: overrides.characterStatus || 'pending' }];
    }
    if (/UPDATE whitelist_applications/.test(sql)) return { affectedRows: 1 };
    if (/UPDATE characters SET extra_review_notes/.test(sql)) return { affectedRows: 1 };
    if (/UPDATE characters SET status/.test(sql)) return { affectedRows: 1 };
    if (/INSERT INTO audit_logs/.test(sql)) return { insertId: 51, affectedRows: 1 };
    if (/SELECT discord_id FROM discord_identities/.test(sql)) return [{ discord_id: '123' }];
    throw new Error(`SQL inesperado: ${sql}`);
  };
}

const reviewInput = {
  applicationId: 41,
  status: 'approved',
  expectedStatus: 'pending',
  reviewerNotes: null,
  extraReviewNotes: undefined,
  reviewerAccountId: 2,
  reviewedBy: 'Moderador'
};

describe('revisão atômica da whitelist', () => {
  test('altera somente o character_id vinculado e audita antes do commit', async () => {
    const { pool, log } = createPool(reviewHandler());
    const result = await reviewWhitelistApplication(pool, reviewInput);

    assert.equal(result.stateChanged, true);
    const statusUpdate = log.find(item => /UPDATE characters SET status/.test(item.sql || ''));
    assert.deepEqual(statusUpdate.params, ['approved', 31, 7]);
    assert.match(statusUpdate.sql, /status <> 'retired'/);
    assert.equal(log.some(item => /JOIN characters c ON c.account_id/.test(item.sql || '')), false);
    assert.ok(
      log.findIndex(item => /INSERT INTO audit_logs/.test(item.sql || ''))
        < log.findIndex(item => item.type === 'commit')
    );
  });

  test('replay do mesmo estado atualiza notas sem duplicar auditoria', async () => {
    const { pool, log } = createPool(reviewHandler({
      applicationStatus: 'approved',
      characterStatus: 'approved'
    }));

    const result = await reviewWhitelistApplication(pool, {
      ...reviewInput,
      expectedStatus: 'approved',
      reviewerNotes: 'nota corrigida'
    });

    assert.equal(result.stateChanged, false);
    assert.equal(log.some(item => /INSERT INTO audit_logs/.test(item.sql || '')), false);
    assert.equal(log.some(item => /UPDATE characters SET status/.test(item.sql || '')), false);
    assert.equal(log.some(item => item.type === 'commit'), true);
  });

  test('personagem retired bloqueia a revisão sem ressuscitar', async () => {
    const { pool, log } = createPool(reviewHandler({ characterStatus: 'retired' }));

    await assert.rejects(
      reviewWhitelistApplication(pool, reviewInput),
      (error) => error instanceof WhitelistWorkflowError && error.code === 'CHARACTER_RETIRED'
    );
    assert.equal(log.some(item => /UPDATE characters/.test(item.sql || '')), false);
    assert.equal(log.some(item => item.type === 'rollback'), true);
  });

  test('segundo revisor perde a corrida quando o estado esperado ficou velho', async () => {
    const { pool, log } = createPool(reviewHandler({ applicationStatus: 'approved' }));

    await assert.rejects(
      reviewWhitelistApplication(pool, { ...reviewInput, status: 'rejected' }),
      (error) => error instanceof WhitelistWorkflowError
        && error.code === 'APPLICATION_STATUS_CHANGED'
    );
    assert.equal(log.some(item => /UPDATE whitelist_applications/.test(item.sql || '')), false);
    assert.equal(log.some(item => item.type === 'rollback'), true);
  });

  test('reafirmação da staff troca origem Discord por staff e fica auditada', async () => {
    const { pool, log } = createPool(reviewHandler({
      applicationStatus: 'approved',
      characterStatus: 'approved',
      approvalSource: 'discord_role'
    }));
    const result = await reviewWhitelistApplication(pool, {
      ...reviewInput,
      expectedStatus: 'approved'
    });
    assert.equal(result.stateChanged, true);
    const update = log.find(item => /UPDATE whitelist_applications/.test(item.sql || ''));
    assert.equal(update.params[1], 'staff');
    assert.ok(log.some(item => /INSERT INTO audit_logs/.test(item.sql || '')));
  });

  test('falha na auditoria desfaz status da candidatura e do personagem', async () => {
    const auditFailure = new Error('audit indisponível');
    const { pool, log } = createPool((sql, params) => {
      if (/INSERT INTO audit_logs/.test(sql)) throw auditFailure;
      return reviewHandler()(sql, params);
    });

    await assert.rejects(reviewWhitelistApplication(pool, reviewInput), auditFailure);
    assert.equal(log.some(item => item.type === 'commit'), false);
    assert.equal(log.some(item => item.type === 'rollback'), true);
  });
});
