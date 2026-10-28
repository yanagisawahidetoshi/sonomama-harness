import { parseEnv } from '../config/env';
import { createHttpClient } from './http-client';

// Expo inlines EXPO_PUBLIC_* only for static `process.env.NAME` references.
export const httpClient = createHttpClient(
  parseEnv({ EXPO_PUBLIC_API_BASE_URL: process.env.EXPO_PUBLIC_API_BASE_URL }).apiBaseUrl,
);
