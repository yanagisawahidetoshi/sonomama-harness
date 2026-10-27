import { parseEnv } from './env';

describe('parseEnv', () => {
  describe('given EXPO_PUBLIC_API_BASE_URL is a URL', () => {
    it('when parsed then exposes it as apiBaseUrl', () => {
      expect(parseEnv({ EXPO_PUBLIC_API_BASE_URL: 'http://192.168.0.10:4010' })).toEqual({
        apiBaseUrl: 'http://192.168.0.10:4010',
      });
    });
  });

  describe('given EXPO_PUBLIC_API_BASE_URL is missing or not a URL', () => {
    it('when parsed then rejects the configuration', () => {
      expect(() => parseEnv({})).toThrow();
      expect(() => parseEnv({ EXPO_PUBLIC_API_BASE_URL: 'not a url' })).toThrow();
    });
  });
});
