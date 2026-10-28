import { describe, expect, it } from 'vitest';
import { createHttpClient } from './http-client';

describe('createHttpClient', () => {
  describe('given an API base URL', () => {
    it('when created then sends requests to that base URL as JSON', () => {
      const client = createHttpClient('http://127.0.0.1:4010');
      expect(client.defaults.baseURL).toBe('http://127.0.0.1:4010');
      expect(client.defaults.headers.Accept).toBe('application/json');
    });
  });
});
