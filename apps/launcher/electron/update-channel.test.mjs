import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  assertPayloadChannel,
  githubFeedUrl,
  installedReleaseForChannel,
  parseUpdateChannel,
  rememberedReleaseCandidates,
  releaseStateKey,
} from './update-channel.mjs';

describe('canais independentes de update', () => {
  test('aceita somente os três canais conhecidos', () => {
    for (const channel of ['stable', 'beta', 'development']) assert.equal(parseUpdateChannel(channel), channel);
    assert.throws(() => parseUpdateChannel('nightly'), /invalido/);
  });

  test('usa feeds separados sem quebrar as URLs stable existentes', () => {
    assert.equal(githubFeedUrl('org/dist', 'client', 'stable'), 'https://github.com/org/dist/releases/latest/download/client-update.json');
    assert.equal(githubFeedUrl('org/dist', 'client', 'beta'), 'https://github.com/org/dist/releases/download/client-beta/client-update.json');
    assert.equal(githubFeedUrl('org/dist', 'mods', 'stable'), 'https://github.com/org/dist/releases/download/mods/mods-dist.json');
    assert.equal(githubFeedUrl('org/dist', 'mods', 'development'), 'https://github.com/org/dist/releases/download/mods-development/mods-dist.json');
  });

  test('recusa payload assinado publicado no canal errado', () => {
    assert.equal(assertPayloadChannel({ channel: 'beta' }, 'beta', 'mods').channel, 'beta');
    assert.throws(() => assertPayloadChannel({ channel: 'development' }, 'stable', 'mods'), /development.*stable/);
    assert.throws(() => assertPayloadChannel({}, 'stable', 'client'), /ausente/);
  });

  test('separa high-watermark e release instalada por canal', () => {
    assert.equal(releaseStateKey('parity', 'beta'), 'parity:beta');
    assert.equal(installedReleaseForChannel({ channel: 'beta' }, 'stable'), null);
    assert.deepEqual(installedReleaseForChannel({ channel: 'beta' }, 'beta'), { channel: 'beta' });
    assert.deepEqual(installedReleaseForChannel({}, 'stable'), {});
  });

  test('preserva o high-watermark legado somente na migração do canal stable', () => {
    const releases = {
      client: { sequence: 12 },
      'client:stable': { sequence: 10 },
      'client:beta': { sequence: 3 },
    };

    assert.deepEqual(rememberedReleaseCandidates(releases, 'client', 'stable'), [
      { sequence: 10 },
      { sequence: 12 },
    ]);
    assert.deepEqual(rememberedReleaseCandidates(releases, 'client', 'beta'), [
      { sequence: 3 },
      null,
    ]);
  });
});
