// -----------------------------------------------------------------------------
// The client of the Smile (src/smile/client.js) against a fake transport, and
// the HTTP transport (src/smile/http.js) against a server on loopback. No test
// leaves the machine.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { SmileClient, formatSetpoint, retryAfterMs } from '../src/smile/client.js';
import { CODES, isAuthRefused } from '../src/smile/errors.js';
import { httpRequest } from '../src/smile/http.js';

const P1 = readFileSync(new URL('./fixtures/p1v4_442_single.xml', import.meta.url));
const NOW = Date.parse('2026-10-18T10:00:00Z');

function fakeRequest(answer = () => ({ status: 200, headers: {}, body: P1 })) {
  const calls = [];
  const request = async (url, options) => {
    calls.push({ url, ...options });
    options.onSent?.();
    return answer(url, options);
  };
  return { request, calls };
}

const client = (request, now = () => NOW) =>
  new SmileClient({ origin: 'http://192.168.1.30:80', smileId: 'abcdefgh', request, now });

test('one read: basic authentication smile:<ID>, the answer parsed', async () => {
  const fake = fakeRequest();
  const model = await client(fake.request).domainObjects();
  assert.equal(model.smile, 'p1');
  const [call] = fake.calls;
  assert.equal(call.url, 'http://192.168.1.30:80/core/domain_objects');
  assert.equal(call.method, 'GET');
  assert.equal(
    call.headers.authorization,
    `Basic ${Buffer.from('smile:abcdefgh').toString('base64')}`,
  );
  assert.equal(call.maxBytes, 4 * 1024 * 1024);
  assert.equal(call.timeout, 10_000);
});

test('HTTP errors: 401 refused, 429 with its Retry-After, others with their status only', async () => {
  for (const [status, headers, check] of [
    [401, {}, (err) => assert.ok(isAuthRefused(err))],
    [429, { 'retry-after': '120' }, (err) => assert.equal(err.retryAfterMs, 120_000)],
    [500, {}, (err) => assert.equal(err.status, 500)],
  ]) {
    const fake = fakeRequest(() => ({
      status,
      headers,
      body: Buffer.from('<error>secret</error>'),
    }));
    const err = await client(fake.request)
      .domainObjects()
      .catch((e) => e);
    assert.equal(err.code, CODES.HTTP);
    assert.ok(!err.message.includes('secret'), 'never the text of the answer');
    check(err);
  }
  assert.equal(retryAfterMs('Sun, 18 Oct 2026 10:02:00 GMT', NOW), 120_000);
  assert.equal(retryAfterMs('soon', NOW), undefined);
  assert.equal(retryAfterMs(undefined, NOW), undefined);
});

test('not the XML of a Smile, or a DTD: a bad answer', async () => {
  for (const body of [
    'not xml',
    '<html><body>router</body></html>',
    '<!DOCTYPE x [<!ENTITY a "b">]><domain_objects/>',
  ]) {
    const fake = fakeRequest(() => ({ status: 200, headers: {}, body: Buffer.from(body) }));
    const err = await client(fake.request)
      .domainObjects()
      .catch((e) => e);
    assert.equal(err.code, CODES.BAD_ANSWER, body);
  }
});

test('the commands: paths and bodies of python-plugwise, texts escaped', async () => {
  const fake = fakeRequest(() => ({ status: 202, headers: {}, body: Buffer.alloc(0) }));
  const smile = client(fake.request);
  const zone = { id: 'a'.repeat(32), name: 'Salon & <cuisine>', type: 'livingroom' };
  await smile.setSetpoint(zone.id, 'b'.repeat(32), 20.46);
  await smile.setPreset(zone, 'asleep');
  await smile.setRegulationMode('heating');
  await smile.setRelay('c'.repeat(32), false);
  await smile.setGatewayMode('d'.repeat(32), 'away', { gatewayTime: '2026-10-18T12:00:00+02:00' });
  await smile.setGatewayMode('d'.repeat(32), 'vacation');
  await smile.setGatewayMode('d'.repeat(32), 'full');
  const sent = fake.calls.map((c) => [
    c.method,
    c.url.replace('http://192.168.1.30:80', ''),
    c.body,
  ]);
  assert.deepEqual(sent, [
    [
      'PUT',
      `/core/locations;id=${zone.id}/thermostat;id=${'b'.repeat(32)}`,
      '<thermostat_functionality><setpoint>20.5</setpoint></thermostat_functionality>',
    ],
    [
      'PUT',
      `/core/locations;id=${zone.id}`,
      `<locations><location id="${zone.id}"><name>Salon &amp; &lt;cuisine&gt;</name><type>livingroom</type><preset>asleep</preset></location></locations>`,
    ],
    [
      'PUT',
      '/core/appliances;type=gateway/regulation_mode_control',
      '<regulation_mode_control_functionality><mode>heating</mode></regulation_mode_control_functionality>',
    ],
    [
      'PUT',
      `/core/appliances;id=${'c'.repeat(32)}/relay`,
      '<relay_functionality><state>off</state></relay_functionality>',
    ],
    [
      'PUT',
      `/core/appliances;id=${'d'.repeat(32)}/gateway_mode_control`,
      '<gateway_mode_control_functionality><mode>away</mode><valid_from>2026-10-18T10:00:00.000Z</valid_from><valid_to>2037-04-21T08:00:53.000Z</valid_to></gateway_mode_control_functionality>',
    ],
    [
      'PUT',
      `/core/appliances;id=${'d'.repeat(32)}/gateway_mode_control`,
      '<gateway_mode_control_functionality><mode>vacation</mode><valid_from>2026-10-17T23:00:00.000Z</valid_from><valid_to>2037-04-21T08:00:53.000Z</valid_to></gateway_mode_control_functionality>',
    ],
    [
      'PUT',
      `/core/appliances;id=${'d'.repeat(32)}/gateway_mode_control`,
      '<gateway_mode_control_functionality><mode>full</mode></gateway_mode_control_functionality>',
    ],
  ]);
  assert.equal(formatSetpoint(19), '19');
  assert.equal(formatSetpoint(4.04), '4');
});

test('a deadline passed: nothing is sent; a command must be connected by its deadline', async () => {
  const fake = fakeRequest();
  const err = await client(fake.request)
    .setRelay('c'.repeat(32), true, { deadline: NOW - 1 })
    .catch((e) => e);
  assert.equal(err.code, CODES.NO_TIME);
  assert.equal(err.notSent, true);
  assert.equal(fake.calls.length, 0);
  await client(fake.request).setRelay('c'.repeat(32), true, { deadline: NOW + 2000 });
  assert.equal(fake.calls[0].sendWithin, 2000);
  await client(fake.request).domainObjects({ deadline: NOW + 1500 });
  assert.equal(fake.calls[1].timeout, 1500, 'a read ends by its deadline');
  assert.equal(fake.calls[1].sendWithin, undefined);
});

test('a closed client sends nothing', async () => {
  const fake = fakeRequest();
  const smile = client(fake.request);
  smile.close();
  const err = await smile.domainObjects().catch((e) => e);
  assert.equal(err.code, CODES.CLOSED);
  assert.equal(fake.calls.length, 0);
});

// --- The transport, on loopback -------------------------------------------------------

async function serve(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('http: GET and PUT with their body, the size cap, onSent', async () => {
  const seen = [];
  const server = await serve((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body, headers: req.headers });
      if (req.url === '/big') {
        res.end('x'.repeat(5000));
        return;
      }
      res.statusCode = req.method === 'PUT' ? 202 : 200;
      res.end(req.method === 'PUT' ? '' : '<ok/>');
    });
  });
  try {
    let sent = 0;
    const get = await httpRequest(`${server.url}/core/domain_objects`, {
      timeout: 2000,
      maxBytes: 1000,
      headers: { authorization: 'Basic x' },
      onSent: () => (sent += 1),
    });
    assert.equal(get.status, 200);
    assert.equal(get.body.toString(), '<ok/>');
    assert.equal(sent, 1);
    const put = await httpRequest(`${server.url}/core/x;id=1/relay`, {
      method: 'PUT',
      body: '<a>é</a>',
      timeout: 2000,
      sendWithin: 1000,
      maxBytes: 1000,
    });
    assert.equal(put.status, 202);
    assert.equal(seen[1].body, '<a>é</a>');
    assert.equal(seen[1].url, '/core/x;id=1/relay');
    assert.equal(seen[1].headers['content-type'], 'text/xml');
    assert.equal(seen[0].headers.authorization, 'Basic x');
    const err = await httpRequest(`${server.url}/big`, { timeout: 2000, maxBytes: 1000 }).catch(
      (e) => e,
    );
    assert.equal(err.code, CODES.TOO_LARGE);
  } finally {
    await server.close();
  }
});

test('http: nothing listening is "not sent"; no answer is a timeout after sending', async () => {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  const refused = await httpRequest(`http://127.0.0.1:${port}/`, {
    timeout: 2000,
    maxBytes: 100,
  }).catch((e) => e);
  assert.equal(refused.code, CODES.UNREACHABLE);
  assert.equal(refused.notSent, true);

  const sockets = [];
  const silent = net.createServer((socket) => sockets.push(socket));
  await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve));
  try {
    let sent = false;
    const late = await httpRequest(`http://127.0.0.1:${silent.address().port}/`, {
      timeout: 300,
      maxBytes: 100,
      onSent: () => (sent = true),
    }).catch((e) => e);
    assert.equal(late.code, CODES.TIMEOUT);
    assert.equal(sent, true);
    assert.equal(late.notSent, undefined, 'it may have reached the Smile');
  } finally {
    for (const s of sockets) s.destroy();
    await new Promise((resolve) => silent.close(resolve));
  }
});

test('http: an answer that is not HTTP is a bad answer', async () => {
  const sockets = [];
  const garbage = net.createServer((socket) => {
    sockets.push(socket);
    socket.on('error', () => {});
    socket.write('SSH-2.0-OpenSSH\r\n\r\n');
  });
  await new Promise((resolve) => garbage.listen(0, '127.0.0.1', resolve));
  try {
    const err = await httpRequest(`http://127.0.0.1:${garbage.address().port}/`, {
      timeout: 2000,
      maxBytes: 100,
    }).catch((e) => e);
    assert.equal(err.code, CODES.BAD_ANSWER);
  } finally {
    for (const s of sockets) s.destroy();
    await new Promise((resolve) => garbage.close(resolve));
  }
});
