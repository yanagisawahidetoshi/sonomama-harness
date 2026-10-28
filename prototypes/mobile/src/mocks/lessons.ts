// Local dummy data only. Never paste real user data, tokens or API responses here.
export type TLesson = {
  id: string;
  title: string;
  instructor: string;
  durationMinutes: number;
};

export const lessonMock: TLesson = {
  id: 'lesson-001',
  title: 'はじめてのフォトレッスン',
  instructor: '講師 A',
  durationMinutes: 45,
};

export const longTitleLessonMock: TLesson = {
  ...lessonMock,
  id: 'lesson-002',
  title: 'とても長いタイトルのレッスンで折り返しと省略の見え方を確認するためのサンプルテキスト',
};
