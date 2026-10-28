import { z } from 'zod';

const envSchema = z.object({ VITE_API_BASE_URL: z.url() });

export type TEnv = { apiBaseUrl: string };

export function parseEnv(raw: Record<string, unknown>): TEnv {
  const { VITE_API_BASE_URL } = envSchema.parse(raw);
  return { apiBaseUrl: VITE_API_BASE_URL };
}
