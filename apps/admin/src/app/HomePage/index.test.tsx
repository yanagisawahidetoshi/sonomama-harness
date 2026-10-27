import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { HomePage } from '.';

describe('HomePage', () => {
  describe('given the admin app starts', () => {
    it('when the home page renders then shows the admin title', () => {
      render(<HomePage />);
      expect(screen.getByRole('heading', { name: 'SONOMAMA 管理画面' })).toBeInTheDocument();
    });
  });
});
