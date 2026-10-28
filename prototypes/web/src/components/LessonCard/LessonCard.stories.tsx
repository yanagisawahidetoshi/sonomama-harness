import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { lessonMock, longTitleLessonMock } from '../../mocks/lessons';
import { LessonCard } from '.';

const meta = {
  title: 'components/LessonCard',
  component: LessonCard,
  args: { lesson: lessonMock },
} satisfies Meta<typeof LessonCard>;

export default meta;
type TStory = StoryObj<typeof meta>;

export const Default: TStory = {};

export const LongTitle: TStory = { args: { lesson: longTitleLessonMock } };

export const Loading: TStory = { args: { state: 'loading' } };

export const Empty: TStory = { args: { state: 'empty', lesson: undefined } };

export const ErrorState: TStory = { name: 'Error', args: { state: 'error' } };

export const MobileWidth: TStory = { globals: { viewport: { value: 'mobile' } } };

export const SaveToggle: TStory = {
  play: async ({ canvasElement }) => {
    const button = within(canvasElement).getByRole('button', { name: '保存する' });
    await userEvent.click(button);
    await expect(button).toHaveAttribute('aria-pressed', 'true');
  },
};
