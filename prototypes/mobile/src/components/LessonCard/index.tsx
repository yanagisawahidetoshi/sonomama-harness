import { useState } from 'react';
import { ActivityIndicator, Pressable, Text, useColorScheme, View } from 'react-native';
import type { TLesson } from '../../mocks/lessons';
import { colors, styles } from './styles';

export type TLessonCardState = 'ready' | 'loading' | 'empty' | 'error';

interface Props {
  lesson?: TLesson;
  state?: TLessonCardState;
}

export function LessonCard({ lesson, state = 'ready' }: Props) {
  const palette = colors[useColorScheme() === 'dark' ? 'dark' : 'light'];
  const [saved, setSaved] = useState(false);
  const card = [styles.card, { backgroundColor: palette.surface }];

  if (state === 'loading') {
    return (
      <View style={card}>
        <ActivityIndicator color={palette.accent} />
      </View>
    );
  }
  if (state === 'error') {
    return (
      <View style={card}>
        <Text style={[styles.message, { color: palette.danger }]}>レッスンを表示できませんでした</Text>
      </View>
    );
  }
  if (state === 'empty' || !lesson) {
    return (
      <View style={card}>
        <Text style={[styles.message, { color: palette.text }]}>レッスンはまだありません</Text>
      </View>
    );
  }

  return (
    <View style={card}>
      <Text style={[styles.title, { color: palette.text }]}>{lesson.title}</Text>
      <Text style={[styles.meta, { color: palette.textMuted }]}>
        {lesson.instructor}・{lesson.durationMinutes}分
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ selected: saved }}
        onPress={() => setSaved((value) => !value)}
        style={[
          styles.button,
          { borderColor: palette.accent, backgroundColor: saved ? palette.accent : 'transparent' },
        ]}
      >
        <Text style={[styles.buttonLabel, { color: saved ? palette.surface : palette.accent }]}>
          {saved ? '保存済み' : '保存する'}
        </Text>
      </Pressable>
    </View>
  );
}
