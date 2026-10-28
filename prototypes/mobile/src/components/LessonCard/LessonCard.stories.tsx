import type { Meta, StoryObj } from '@storybook/react-native';
import { View } from 'react-native';
import { lessonMock, longTitleLessonMock } from '../../mocks/lessons';
import { LessonCard } from '.';

const meta = {
  title: 'components/LessonCard',
  component: LessonCard,
  args: { lesson: lessonMock },
  decorators: [
    (Story) => (
      <View style={{ flex: 1, padding: 16, justifyContent: 'center' }}>
        <Story />
      </View>
    ),
  ],
} satisfies Meta<typeof LessonCard>;

export default meta;
type TStory = StoryObj<typeof meta>;

export const Default: TStory = {};

export const LongTitle: TStory = { args: { lesson: longTitleLessonMock } };

export const Loading: TStory = { args: { state: 'loading' } };

export const Empty: TStory = { args: { state: 'empty', lesson: undefined } };

export const ErrorState: TStory = { name: 'Error', args: { state: 'error' } };
