import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Button } from '.';

describe('Button', () => {
  describe('given a label', () => {
    it('when rendered then shows a button with that accessible name', () => {
      render(<Button>保存</Button>);
      expect(screen.getByRole('button', { name: '保存' })).toBeInTheDocument();
    });
  });

  describe('given an onClick handler', () => {
    it('when the user clicks the button then calls the handler once', async () => {
      const onClick = vi.fn();
      render(<Button onClick={onClick}>保存</Button>);
      await userEvent.click(screen.getByRole('button', { name: '保存' }));
      expect(onClick).toHaveBeenCalledTimes(1);
    });
  });

  describe('given the Sparkle Design isDisabled prop', () => {
    it('when the user clicks the button then it is disabled and the handler is not called', async () => {
      const onClick = vi.fn();
      render(
        <Button isDisabled onClick={onClick}>
          保存
        </Button>,
      );
      const button = screen.getByRole('button', { name: '保存' });
      await userEvent.click(button);
      expect(button).toBeDisabled();
      expect(onClick).not.toHaveBeenCalled();
    });
  });

  describe('given Sparkle Design variant and native attributes', () => {
    it('when rendered then passes them through to the rendered button', () => {
      render(
        <Button variant="outline" theme="negative" type="submit" aria-describedby="hint">
          削除
        </Button>,
      );
      const button = screen.getByRole('button', { name: '削除' });
      expect(button).toHaveAttribute('type', 'submit');
      expect(button).toHaveAttribute('aria-describedby', 'hint');
    });
  });
});
