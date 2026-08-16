/**
 * check-schema-drift.test.js
 *
 * Testa o parser de migrations e a comparação, sem banco — para que o CI possa
 * rodar isto em todo PR. A parte que precisa de banco fica no comando em si
 * (`npm run check:schema`), que roda com o servidor.
 *
 * O teste tem duas metades e as duas importam:
 *
 *   1. **Contra as migrations reais.** Se alguém escrever uma migration numa
 *      forma de DDL que o parser não reconhece, o esperado fica menor do que a
 *      realidade e o checador passa a aprovar um banco incompleto — falhar
 *      caladamente é exatamente o que ele existe para evitar. As asserções
 *      abaixo fixam tabelas e colunas que sabidamente vêm de arquivos
 *      diferentes (CREATE TABLE em um, ALTER TABLE ADD COLUMN em outro).
 *
 *   2. **Contra um banco sintético.** A comparação é função pura, então dá pra
 *      simular exatamente o cenário que motivou o script: migrations aplicadas
 *      até a v6, com v7 e v8 faltando.
 *
 * Executa com: node --test scripts/check-schema-drift.test.js
 */

const assert = require('assert');
const path = require('path');
const { describe, it } = require('node:test');

const drift = require('./check-schema-drift');

const databaseDir = path.resolve(__dirname, '..', '..', 'packages', 'database');

describe('ordenação dos arquivos', () => {
  it('schema.sql vem primeiro e as migrations em ordem numérica', () => {
    const nomes = drift.listarArquivosSql(databaseDir).map(p => path.basename(p));
    assert.equal(nomes[0], 'schema.sql', 'schema.sql precisa vir antes das migrations');

    const versoes = nomes.slice(1).map(drift.versaoDe);
    const ordenado = [...versoes].sort((a, b) => a - b);
    assert.deepEqual(versoes, ordenado, 'migrations fora de ordem numérica');
  });

  it('ordena por número, não alfabeticamente', () => {
    // Alfabético colocaria v10 antes de v2. Não temos v10 hoje; o dia que
    // tiver, o erro seria silencioso — a v10 seria lida antes da v2.
    assert.equal(drift.versaoDe('migration-v10-qualquer.sql'), 10);
    assert.equal(drift.versaoDe('migration-v2.sql'), 2);
    assert.ok(drift.versaoDe('migration-v10-qualquer.sql') > drift.versaoDe('migration-v2.sql'));
  });
});

describe('parser, contra as migrations reais do repositório', () => {
  const esperado = drift.extrairEsperado(drift.listarArquivosSql(databaseDir));

  it('encontra as tabelas centrais', () => {
    for (const tabela of [
      'accounts', 'characters', 'character_inventory', 'audit_logs', 'gold_transactions',
      'staff_roles', 'market_stalls', 'governance_roles', 'launch_tickets', 'game_sessions'
    ]) {
      assert.ok(esperado.has(tabela), `tabela '${tabela}' nao foi extraida das migrations`);
    }
  });

  it('funde ADD COLUMN de uma migration na tabela criada em outra', () => {
    // `characters` nasce em schema.sql; estas cinco colunas chegam na v5.
    // Se o parser não fundir, ele aprovaria um banco sem os campos da rubrica
    // de whitelist — e a aplicação de personagem quebraria só no envio.
    const characters = esperado.get('characters');
    for (const coluna of [
      'motivations', 'weaknesses', 'social_ties', 'needs_extra_review', 'extra_review_notes'
    ]) {
      assert.ok(characters.colunas.has(coluna), `characters.${coluna} (migration v5) nao foi extraida`);
    }
  });

  it('inclui o vínculo e os índices atômicos da whitelist da v17', () => {
    const whitelist = esperado.get('whitelist_applications');
    assert.ok(whitelist.colunas.has('character_id'));
    assert.ok(whitelist.indices.has('uq_whitelist_character'));
    assert.ok(whitelist.indices.has('idx_whitelist_account_status_created'));
  });

  it('inclui concessão de acesso por cargo Discord da v18', () => {
    const whitelist = esperado.get('whitelist_applications');
    const access = esperado.get('discord_role_access');
    assert.ok(whitelist.colunas.has('approval_source'));
    assert.ok(access, 'discord_role_access não foi extraída');
    for (const column of ['account_id', 'discord_id', 'eligible', 'matched_role_id', 'expires_at']) {
      assert.ok(access.colunas.has(column), `discord_role_access.${column} ausente`);
    }
    assert.ok(access.indices.has('idx_discord_role_access_expiry'));
  });

  it('inclui lease exato de conexão e índice único da v19', () => {
    const sessions = esperado.get('game_sessions');
    for (const column of ['connection_lease_hash', 'connected_at', 'disconnected_at']) {
      assert.ok(sessions.colunas.has(column), `game_sessions.${column} ausente`);
    }
    assert.ok(sessions.indices.has('uq_game_session_connection_lease'));
  });

  it('extrai índices adicionados por ALTER TABLE', () => {
    // A v7 é a mais perigosa de faltar: sem ela nada quebra, só fica lento
    // sob carga — que é quando ninguém está olhando o schema.
    const auditLogs = esperado.get('audit_logs');
    assert.ok(auditLogs.indices.size > 0, 'nenhum indice extraido de audit_logs (migration v7)');
    assert.ok(auditLogs.indices.has('idx_audit_created'), 'idx_audit_created (v7) nao foi extraido');
  });

  it('comentário não vira declaração', () => {
    // As migrations têm blocos longos de comentário citando nomes de tabela.
    // Se `--` não fosse removido, o esperado ganharia tabelas fantasma e o
    // check falharia sempre, o que faria alguém desligá-lo.
    const sql = drift.semComentarios('-- CREATE TABLE `fantasma` (\nSELECT 1;');
    assert.ok(!/fantasma/.test(sql));
  });

  it('os índices da v15 sobrevivem ao ponto e vírgula dentro de COMMENT', () => {
    // Regressão real de 13/08/2026. O parser cortava o `ALTER TABLE` no
    // primeiro `;` do texto, sem saber que strings existem — e o `COMMENT` de
    // `character_id` na v15 continha um. Os três `ADD INDEX` que vinham depois
    // sumiam da declaração esperada, **em silêncio**, com o comando saindo em
    // código 0: o checador passava a aprovar um banco sem aqueles índices.
    const gold = esperado.get('gold_transactions');
    for (const indice of ['idx_gold_tx_owner_date', 'idx_gold_tx_transfer', 'idx_gold_tx_actor_date']) {
      assert.ok(gold.indices.has(indice), `indice '${indice}' (v15) nao foi extraido`);
    }
    for (const coluna of ['owner_type', 'owner_ref', 'counterparty_type', 'counterparty_ref', 'transfer_id', 'actor_character_id']) {
      assert.ok(gold.colunas.has(coluna), `coluna '${coluna}' (v15) nao foi extraida`);
    }
  });
});

describe('parser, ciente de aspas', () => {
  it('um `;` dentro de COMMENT não corta o ALTER TABLE', () => {
    // Mutação que reprova aqui: voltar a delimitar a instrução com
    // /ALTER\s+TABLE\s+`([^`]+)`([\s\S]*?);/ em vez de `instrucoesSql`.
    const sql = [
      'ALTER TABLE `t`',
      "  ADD COLUMN IF NOT EXISTS `a` INT NULL COMMENT 'vale x; senao y',",
      '  ADD INDEX IF NOT EXISTS `idx_depois_do_ponto_e_virgula` (`a`);'
    ].join('\n');

    const instrucoes = drift.instrucoesSql(sql);
    assert.equal(instrucoes.length, 1, 'o ; da string nao pode terminar a instrucao');
    assert.ok(/idx_depois_do_ponto_e_virgula/.test(instrucoes[0]));
  });

  it('divide em instruções de verdade quando o `;` está fora de string', () => {
    const instrucoes = drift.instrucoesSql("USE `db`;\nALTER TABLE `t` ADD COLUMN `a` INT;\n");
    assert.equal(instrucoes.length, 2);
    assert.ok(/USE/.test(instrucoes[0]));
    assert.ok(/ALTER/.test(instrucoes[1]));
  });

  it('`--` dentro de string não é comentário', () => {
    // O mesmo cegueira, na outra função: `linha.replace(/--.*$/, '')` comia
    // metade de um COMMENT que contivesse dois hifens.
    const sql = drift.semComentarios("ADD COLUMN `faixa` INT COMMENT 'de 10--20 septims'");
    assert.ok(/10--20 septims/.test(sql), 'o texto dentro da string precisa sobreviver');
  });

  it('aspas escapadas não confundem o fim da string', () => {
    const instrucoes = drift.instrucoesSql("SELECT 'o''brien; nao termina aqui'; SELECT 2");
    assert.equal(instrucoes.length, 2);
    assert.ok(/o''brien; nao termina aqui/.test(instrucoes[0]));
  });
});

describe('comparação', () => {
  const esperadoFalso = new Map([
    ['characters', { colunas: new Set(['id', 'gold', 'status']), indices: new Set(['idx_char']), origem: 'schema.sql' }],
    ['game_sessions', { colunas: new Set(['id', 'token_hash']), indices: new Set(), origem: 'migration-v8-game-sessions.sql' }]
  ]);

  it('banco alinhado não acusa nada', () => {
    const real = new Map([
      ['characters', { colunas: new Set(['id', 'gold', 'status']), indices: new Set(['idx_char']) }],
      ['game_sessions', { colunas: new Set(['id', 'token_hash']), indices: new Set() }]
    ]);
    const r = drift.compararSchemas(esperadoFalso, real);
    assert.equal(drift.houveFalta(r), false);
    assert.deepEqual(r.tabelasExtra, []);
  });

  it('detecta migration inteira não aplicada', () => {
    // O cenário real: aplicaram até a v6 e pararam.
    const real = new Map([
      ['characters', { colunas: new Set(['id', 'gold', 'status']), indices: new Set(['idx_char']) }]
    ]);
    const r = drift.compararSchemas(esperadoFalso, real);
    assert.equal(drift.houveFalta(r), true);
    assert.equal(r.tabelasFaltando.length, 1);
    assert.equal(r.tabelasFaltando[0].tabela, 'game_sessions');
    assert.match(r.tabelasFaltando[0].origem, /v8/, 'o relatorio precisa dizer qual migration aplicar');
  });

  it('detecta migration aplicada pela metade', () => {
    const real = new Map([
      ['characters', { colunas: new Set(['id', 'gold']), indices: new Set(['idx_char']) }],
      ['game_sessions', { colunas: new Set(['id', 'token_hash']), indices: new Set() }]
    ]);
    const r = drift.compararSchemas(esperadoFalso, real);
    assert.equal(drift.houveFalta(r), true);
    assert.deepEqual(
      r.colunasFaltando.map(c => `${c.tabela}.${c.coluna}`),
      ['characters.status']
    );
  });

  it('detecta índice faltando sem confundir com coluna', () => {
    const real = new Map([
      ['characters', { colunas: new Set(['id', 'gold', 'status']), indices: new Set() }],
      ['game_sessions', { colunas: new Set(['id', 'token_hash']), indices: new Set() }]
    ]);
    const r = drift.compararSchemas(esperadoFalso, real);
    assert.equal(r.colunasFaltando.length, 0, 'indice faltando nao pode virar coluna faltando');
    assert.equal(r.indicesFaltando.length, 1);
    assert.equal(r.indicesFaltando[0].indice, 'idx_char');
  });

  it('tabela criada à mão aparece como extra, sem virar falta', () => {
    const real = new Map([
      ['characters', { colunas: new Set(['id', 'gold', 'status']), indices: new Set(['idx_char']) }],
      ['game_sessions', { colunas: new Set(['id', 'token_hash']), indices: new Set() }],
      ['tabela_temporaria_do_fulano', { colunas: new Set(['id']), indices: new Set() }]
    ]);
    const r = drift.compararSchemas(esperadoFalso, real);
    assert.equal(drift.houveFalta(r), false, 'tabela extra nao e falta de migration');
    assert.deepEqual(r.tabelasExtra, ['tabela_temporaria_do_fulano']);
  });
});
