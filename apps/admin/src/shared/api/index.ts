import { parseEnv } from '../config/env';
import { createHttpClient } from './http-client';

export const httpClient = createHttpClient(parseEnv(import.meta.env).apiBaseUrl);
