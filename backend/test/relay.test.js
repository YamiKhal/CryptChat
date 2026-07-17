import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';

import { startServer, stopServer } from './helpers/server.js';
import { TestUser, initCrypto } from './helpers/client.js';

/**
 * Ephemeral relay presence: typing and anonymous join/leave (ROADMAP #3).
 *
 * These signals are routed but never stored and never signed, so the only way
 * to test them is over a real socket with two real members -- exactly what the
 * emulator now speaks. The invariants that matter here are as much about what
 * is NOT sent (no echo to the sender, no identity on a leave) as what is.
 *
 * Requires Postgres, like the other flow tests.
 */

before(async () => {
  await initCrypto();
  await startServer();
});

after(async () => {
  await stopServer();
});

/** Two registered users sharing one channel, both with live sockets. */
async function twoInAChannel() {
  const a = new TestUser();
  const b = new TestUser();
  await a.register();
  await b.register();

  const channel = await a.createChannel();
  await b.joinChannel(channel.code, a.channels.get(channel.channelId).key);

  await a.connectRelay();
  await b.connectRelay();

  return { a, b, channelId: channel.channelId };
}

describe('typing', () => {
  test('relays a typing ping to other members, carrying the sender', async () => {
    const { a, b, channelId } = await twoInAChannel();
    try {
      a.sendRelay({ type: 'typing', channelId });
      const frame = await b.waitForRelay((m) => m.type === 'typing' && m.channelId === channelId);
      assert.equal(frame.senderId, a.userId);
    } finally {
      a.closeRelay();
      b.closeRelay();
    }
  });

  test('never echoes typing back to the sender', async () => {
    const { a, b, channelId } = await twoInAChannel();
    try {
      a.sendRelay({ type: 'typing', channelId });
      // b must see it; a must not.
      await b.waitForRelay((m) => m.type === 'typing');
      assert.ok(await a.expectNoRelay((m) => m.type === 'typing'));
    } finally {
      a.closeRelay();
      b.closeRelay();
    }
  });

  test('forwards a stop so the indicator can be retracted at once', async () => {
    const { a, b, channelId } = await twoInAChannel();
    try {
      a.sendRelay({ type: 'typing', channelId, stop: true });
      const frame = await b.waitForRelay((m) => m.type === 'typing' && m.channelId === channelId);
      assert.equal(frame.stop, true);
    } finally {
      a.closeRelay();
      b.closeRelay();
    }
  });

  test('drops a typing ping from a non-member', async () => {
    const { a, b, channelId } = await twoInAChannel();
    const intruder = new TestUser();
    await intruder.register();
    await intruder.connectRelay();
    try {
      intruder.sendRelay({ type: 'typing', channelId });
      // Neither member should receive anything: the intruder is not in the channel.
      assert.ok(await b.expectNoRelay((m) => m.type === 'typing'));
      assert.ok(await a.expectNoRelay((m) => m.type === 'typing'));
    } finally {
      a.closeRelay();
      b.closeRelay();
      intruder.closeRelay();
    }
  });
});

describe('stable message id', () => {
  test('recipients receive the sender\'s clientId, so ids match across clients', async () => {
    const { a, b, channelId } = await twoInAChannel();
    try {
      const clientId = '33333333-3333-3333-3333-333333333333';
      a.sendRelay({
        type: 'send',
        channelId,
        clientId,
        kind: 'message',
        ciphertext: 'Zm9vYmFy',
        nonce: 'AAAAAAAAAAAAAAAAAAAAAAAA',
      });

      const frame = await b.waitForRelay((m) => m.type === 'message' && m.channelId === channelId);
      // Without this the sender stored under clientId while the recipient stored
      // under the queue id, so edits/deletes/reactions could never match.
      assert.equal(frame.clientId, clientId);
    } finally {
      a.closeRelay();
      b.closeRelay();
    }
  });
});

describe('anonymous leave', () => {
  test('tells remaining members someone left, without saying who', async () => {
    const { a, b, channelId } = await twoInAChannel();
    try {
      await b.leaveChannel(channelId);
      const frame = await a.waitForRelay((m) => m.type === 'member-left' && m.channelId === channelId);
      // The whole point: no identity rides along.
      assert.equal(frame.userId, undefined);
      assert.equal(frame.senderId, undefined);
    } finally {
      a.closeRelay();
      b.closeRelay();
    }
  });
});
