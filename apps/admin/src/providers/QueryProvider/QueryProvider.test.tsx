import { useQueryClient } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { QueryProvider } from '.';

function StaleTime() {
  return <p>{String(useQueryClient().getDefaultOptions().queries?.staleTime)}</p>;
}

describe('QueryProvider', () => {
  describe('given a component that reads the query client', () => {
    it('when wrapped then receives the shared client with a 5 minute staleTime', () => {
      render(
        <QueryProvider>
          <StaleTime />
        </QueryProvider>,
      );
      expect(screen.getByText(String(5 * 60 * 1000))).toBeInTheDocument();
    });
  });
});
