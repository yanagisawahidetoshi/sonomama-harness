import { render, screen } from '@testing-library/react-native';
import { HomeScreen } from '.';

describe('HomeScreen', () => {
  describe('given the student app starts', () => {
    it('when the home screen renders then shows the smoke-test anchor and title', async () => {
      await render(<HomeScreen />);
      expect(screen.getByTestId('home-screen')).toBeOnTheScreen();
      expect(screen.getByTestId('home-title')).toHaveTextContent('SONOMAMA');
    });
  });
});
