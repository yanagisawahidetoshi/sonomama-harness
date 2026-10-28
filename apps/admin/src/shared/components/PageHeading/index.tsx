import type { ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

export function PageHeading({ children }: Props) {
  return <h1>{children}</h1>;
}
