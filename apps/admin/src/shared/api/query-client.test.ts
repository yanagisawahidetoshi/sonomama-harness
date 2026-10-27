import { AxiosError, AxiosHeaders } from 'axios';
import { describe, expect, it } from 'vitest';
import { createQueryClient, shouldRetry } from './query-client';

const httpError = (status: number) =>
  new AxiosError('request failed', 'ERR_BAD_RESPONSE', undefined, undefined, {
    status,
    statusText: '',
    headers: {},
    config: { headers: new AxiosHeaders() },
    data: null,
  });

describe('createQueryClient', () => {
  describe('given the default query options', () => {
    it('when created then keeps data fresh for 5 minutes and cached for 10 minutes', () => {
      const defaults = createQueryClient().getDefaultOptions().queries;
      expect(defaults?.staleTime).toBe(5 * 60 * 1000);
      expect(defaults?.gcTime).toBe(10 * 60 * 1000);
      expect(defaults?.retry).toBe(shouldRetry);
    });
  });
});

describe('shouldRetry', () => {
  describe('given a 4xx response', () => {
    it('when deciding then never retries', () => {
      expect(shouldRetry(0, httpError(400))).toBe(false);
      expect(shouldRetry(0, httpError(404))).toBe(false);
    });
  });

  describe('given a 5xx or network error', () => {
    it('when deciding then retries up to 3 times', () => {
      expect(shouldRetry(0, httpError(500))).toBe(true);
      expect(shouldRetry(2, new Error('network'))).toBe(true);
      expect(shouldRetry(3, httpError(503))).toBe(false);
    });
  });
});
