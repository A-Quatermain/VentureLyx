import useSWR from 'swr';
import { apiFetch } from './api';

export function useApi<T>(path: string) {
  return useSWR<T>(path, (p: string) => apiFetch<T>(p));
}
