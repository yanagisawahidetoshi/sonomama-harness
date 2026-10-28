import { render, screen } from '@testing-library/react-native';
import { ScreenTitle } from '.';

describe('ScreenTitle', () => {
  describe('given a screen title', () => {
    it('when rendered then shows it as a header', async () => {
      await render(<ScreenTitle title="レッスン" />);
      expect(screen.getByRole('header', { name: 'レッスン' })).toBeOnTheScreen();
    });
  });
});
