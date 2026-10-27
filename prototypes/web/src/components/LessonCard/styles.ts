import type { CSSProperties } from 'react';

export const styles = {
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-2)',
    width: '100%',
    maxWidth: 360,
    boxSizing: 'border-box',
    padding: 'var(--space-4)',
    borderRadius: 'var(--radius)',
    background: 'var(--color-surface)',
    color: 'var(--color-text)',
  },
  title: { margin: 0, fontSize: 'var(--font-size-title)', lineHeight: 1.4 },
  meta: { margin: 0, fontSize: 'var(--font-size-body)', color: 'var(--color-text-muted)' },
  message: { margin: 0, fontSize: 'var(--font-size-body)' },
  error: { margin: 0, fontSize: 'var(--font-size-body)', color: 'var(--color-danger)' },
  button: {
    alignSelf: 'flex-start',
    padding: 'var(--space-2) var(--space-3)',
    border: '1px solid var(--color-accent)',
    borderRadius: 'var(--radius)',
    background: 'transparent',
    color: 'var(--color-accent)',
    cursor: 'pointer',
  },
  buttonActive: { background: 'var(--color-accent)', color: 'var(--color-surface)' },
} satisfies Record<string, CSSProperties>;
