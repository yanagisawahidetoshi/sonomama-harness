import { QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { createQueryClient } from '@/shared/api/query-client';

interface Props {
  children: ReactNode;
}

export function QueryProvider({ children }: Props) {
  const [queryClient] = useState(createQueryClient);
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
