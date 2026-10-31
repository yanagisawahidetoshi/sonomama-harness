import { test } from 'node:test';
import assert from 'node:assert/strict';

test('spike #168 fails on purpose so the trusted judge reports FAIL', () => {
  assert.fail('spike #168');
});
