import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { APP_IDENTITY_CONTRACT, APP_IDENTITY_PATH, identityVerdict, readApplicationIdentity } from '../src/app-identity.mjs';

async function withApp(handler, fn) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    return await fn(server.address().port);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function claimFor(appId, contract = APP_IDENTITY_CONTRACT) {
  return (req, res) => {
    if (req.url !== APP_IDENTITY_PATH) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ contract, app_id: appId }));
  };
}

test('a port that serves the identity document names its application', async () => {
  await withApp(claimFor('report-pa-project'), async port => {
    assert.deepEqual(await readApplicationIdentity(port), { state: 'claimed', appId: 'report-pa-project' });
  });
});

test('the answer is compared exactly, so a different application is visible', async () => {
  await withApp(claimFor('hr-portal'), async port => {
    const claim = await readApplicationIdentity(port);
    assert.equal(identityVerdict(claim, 'report-pa-project'), 'other');
    assert.equal(identityVerdict(claim, 'hr-portal'), 'own');
  });
});

test('no document is "absent", never a mismatch', () => {
  // The distinction the whole rollout depends on: an application that predates
  // the contract must keep answering exactly as it always has.
  assert.equal(identityVerdict({ state: 'absent' }, 'demo'), 'unknown');
  assert.equal(identityVerdict(null, 'demo'), 'unknown');
  assert.equal(identityVerdict({ state: 'unusable' }, 'demo'), 'unknown');
});

test('a document this contract does not recognise is not a claim', async () => {
  await withApp(claimFor('demo', 'some-other-contract.v9'), async port => {
    assert.deepEqual(await readApplicationIdentity(port), { state: 'absent' });
  });
});

test('a document without an app id, or malformed, is not a claim', async () => {
  for (const body of ['{}', '[]', 'null', '{"contract":"' + APP_IDENTITY_CONTRACT + '"}', 'not json']) {
    await withApp((req, res) => {
      if (req.url !== APP_IDENTITY_PATH) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
    }, async port => {
      assert.deepEqual(await readApplicationIdentity(port), { state: 'absent' }, `body ${body}`);
    });
  }
});

test('a non-200 answer is not a claim, whatever it carries', async () => {
  await withApp((req, res) => {
    res.writeHead(302, { Location: '/' });
    res.end(JSON.stringify({ contract: APP_IDENTITY_CONTRACT, app_id: 'demo' }));
  }, async port => {
    assert.deepEqual(await readApplicationIdentity(port), { state: 'absent' });
  });
});

test('an answer larger than a claim is refused instead of read to the end', async () => {
  // An application must not be able to decide how much of the probe's budget it
  // spends. The document is a few dozen bytes; anything page-sized is not it.
  await withApp((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ contract: APP_IDENTITY_CONTRACT, app_id: 'demo', pad: 'x'.repeat(20000) }));
  }, async port => {
    assert.deepEqual(await readApplicationIdentity(port, { maxBytes: 8 * 1024 }), { state: 'absent' });
  });
});

test('an application that trickles a body cannot hold the probe open', async () => {
  let timer = null;
  await withApp((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"contract":');
    // A body that never finishes is exactly the SSE/progress-feed case the
    // reachability probe drops the socket for.
    timer = setInterval(() => res.write(' '), 20);
    res.on('close', () => clearInterval(timer));
  }, async port => {
    const started = Date.now();
    // IP: the wall clock bounds it, not an idle timer that every byte resets.
    assert.deepEqual(await readApplicationIdentity(port, { timeoutMs: 200 }), { state: 'unusable' });
    assert.ok(Date.now() - started < 3000, 'the deadline must end the read');
  });
});

test('a body cut short mid-response is unusable, not "no document"', async () => {
  // The distinct case this pins: the application DID answer, and it answered
  // 200, but the body never arrived in full. Calling that 'absent' would say
  // "this application declares no identity", which the probe then caches — and
  // that cached answer would skip the real check for a whole window. It is a
  // fact about the moment, so it must read as unusable and be asked again.
  await withApp((req, res) => {
    if (req.url !== APP_IDENTITY_PATH) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"contract":"' + APP_IDENTITY_CONTRACT + '","app_id":"dem');
    // Close the socket before the JSON is complete.
    setImmediate(() => res.destroy());
  }, async port => {
    const claim = await readApplicationIdentity(port);
    assert.deepEqual(claim, { state: 'unusable' });
  });
});

test('nothing listening is unusable, not a claim', async () => {
  // Port 1 on loopback is reliably closed in the test environment.
  assert.deepEqual(await readApplicationIdentity(1, { timeoutMs: 300 }), { state: 'unusable' });
});