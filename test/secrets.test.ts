import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.MONGODB_URI ??= 'mongodb://127.0.0.1:27017/sumon_trade_test';
process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-test-access-secret-0001';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-test-refresh-secret-01';
process.env.NODE_ENV = 'test';
const { openSecret, sealSecret } = await import('../src/core/secrets.js');

test('a sealed secret opens to the same text and never contains it', () => {
  const sealed = sealSecret('smtp-p@ss wörd');
  assert.match(sealed, /^enc:v1:/);
  assert.ok(!sealed.includes('smtp-p@ss'));
  assert.equal(openSecret(sealed), 'smtp-p@ss wörd');
});

test('sealing twice gives different ciphertexts', () => {
  assert.notEqual(sealSecret('same'), sealSecret('same'));
});

test('a tampered value opens to an empty string', () => {
  const sealed = sealSecret('secret');
  const tampered = sealed.slice(0, -2) + (sealed.endsWith('A') ? 'BB' : 'AA');
  assert.equal(openSecret(tampered), '');
});

test('values saved before encryption and empty values pass through', () => {
  assert.equal(openSecret('legacy-plain'), 'legacy-plain');
  assert.equal(openSecret(''), '');
  assert.equal(openSecret(undefined), '');
  assert.equal(sealSecret(''), '');
});
