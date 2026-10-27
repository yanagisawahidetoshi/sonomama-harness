import { QueryClient } from '@tanstack/react-query';
import { isAxiosError } from 'axios';

const MAX_RETRIES = 3;

export function shouldRetry(failureCount: number, error: unknown): boolean {
  const status = isAxiosError(error) ? error.response?.status : undefined;
  if (status !== undefined && status >= 400 && status < 500) return false;
  return failureCount < MAX_RETRIES;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 5 * 60 * 1000, gcTime: 10 * 60 * 1000, retry: shouldRetry },
    },
  });
}
