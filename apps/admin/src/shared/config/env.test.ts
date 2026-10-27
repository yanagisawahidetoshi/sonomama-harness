import { describe, expect, it } from 'vitest';
import { parseEnv } from './env';

describe('parseEnv', () => {
  describe('given VITE_API_BASE_URL is a URL', () => {
    it('when parsed then exposes it as apiBaseUrl', () => {
      expect(parseEnv({ VITE_API_BASE_URL: 'http://127.0.0.1:4010' })).toEqual({ apiBaseUrl: 'http://127.0.0.1:4010' });
    });
  });

  describe('given VITE_API_BASE_URL is missing or not a URL', () => {
    it('when parsed then rejects the configuration', () => {
      expect(() => parseEnv({})).toThrow();
      expect(() => parseEnv({ VITE_API_BASE_URL: 'not a url' })).toThrow();
    });
  });
});
