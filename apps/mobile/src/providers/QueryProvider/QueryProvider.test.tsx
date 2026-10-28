import { useQueryClient } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';
import { QueryProvider } from '.';

function StaleTime() {
  return <Text>{String(useQueryClient().getDefaultOptions().queries?.staleTime)}</Text>;
}

describe('QueryProvider', () => {
  describe('given a component that reads the query client', () => {
    it('when wrapped then receives the shared client with a 5 minute staleTime', async () => {
      await render(
        <QueryProvider>
          <StaleTime />
        </QueryProvider>,
      );
      expect(screen.getByText(String(5 * 60 * 1000))).toBeOnTheScreen();
    });
  });
});
