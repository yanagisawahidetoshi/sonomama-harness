import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { Button } from '.';

const meta = {
  title: 'shared/components/ui/Button',
  component: Button,
  args: { children: '保存する', onClick: fn() },
} satisfies Meta<typeof Button>;

export default meta;
type TStory = StoryObj<typeof meta>;

export const Default: TStory = {};

export const Outline: TStory = { args: { variant: 'outline' } };

export const Ghost: TStory = { args: { variant: 'ghost' } };

export const Neutral: TStory = { args: { theme: 'neutral' } };

export const Negative: TStory = { args: { theme: 'negative', children: '削除する' } };

export const Sizes: TStory = {
  render: (args) => (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <Button {...args} size="sm" />
      <Button {...args} size="md" />
      <Button {...args} size="lg" />
    </div>
  ),
};

export const Loading: TStory = { args: { isLoading: true } };

export const Disabled: TStory = {
  args: { isDisabled: true },
  play: async ({ args, canvasElement }) => {
    const button = within(canvasElement).getByRole('button', { name: '保存する' });
    await userEvent.click(button);
    await expect(button).toBeDisabled();
    await expect(args.onClick).not.toHaveBeenCalled();
  },
};

export const Click: TStory = {
  play: async ({ args, canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: '保存する' }));
    await expect(args.onClick).toHaveBeenCalledTimes(1);
  },
};
