import axios, { type AxiosInstance } from 'axios';

// Auth headers are added by interceptors once the auth provider is decided; keep this layer provider-agnostic.
export function createHttpClient(baseURL: string): AxiosInstance {
  return axios.create({ baseURL, headers: { Accept: 'application/json' } });
}
