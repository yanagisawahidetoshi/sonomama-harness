import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PageHeading } from '.';

describe('PageHeading', () => {
  describe('given a page title', () => {
    it('when rendered then shows it as the level 1 heading', () => {
      render(<PageHeading>受講生一覧</PageHeading>);
      expect(screen.getByRole('heading', { level: 1, name: '受講生一覧' })).toBeInTheDocument();
    });
  });
});
