import { z } from 'zod';

const envSchema = z.object({ EXPO_PUBLIC_API_BASE_URL: z.url() });

export type TEnv = { apiBaseUrl: string };

export function parseEnv(raw: Record<string, unknown>): TEnv {
  const { EXPO_PUBLIC_API_BASE_URL } = envSchema.parse(raw);
  return { apiBaseUrl: EXPO_PUBLIC_API_BASE_URL };
}
