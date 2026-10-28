import { useState } from 'react';
import type { TLesson } from '../../mocks/lessons';
import { styles } from './styles';

export type TLessonCardState = 'ready' | 'loading' | 'empty' | 'error';

interface Props {
  lesson?: TLesson;
  state?: TLessonCardState;
}

export function LessonCard({ lesson, state = 'ready' }: Props) {
  const [saved, setSaved] = useState(false);

  if (state === 'loading')
    return (
      <section style={styles.card} aria-busy="true">
        <p style={styles.message}>読み込み中…</p>
      </section>
    );
  if (state === 'error')
    return (
      <section style={styles.card}>
        <p style={styles.error}>レッスンを表示できませんでした</p>
      </section>
    );
  if (state === 'empty' || !lesson)
    return (
      <section style={styles.card}>
        <p style={styles.message}>レッスンはまだありません</p>
      </section>
    );

  return (
    <section style={styles.card}>
      <h2 style={styles.title}>{lesson.title}</h2>
      <p style={styles.meta}>
        {lesson.instructor}・{lesson.durationMinutes}分
      </p>
      <button
        type="button"
        aria-pressed={saved}
        style={saved ? { ...styles.button, ...styles.buttonActive } : styles.button}
        onClick={() => setSaved((value) => !value)}
      >
        {saved ? '保存済み' : '保存する'}
      </button>
    </section>
  );
}
