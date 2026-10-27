import { LessonCard } from './components/LessonCard';
import { lessonMock } from './mocks/lessons';

export function App() {
  return (
    <main style={{ display: 'grid', gap: 'var(--space-4)', padding: 'var(--space-4)' }}>
      <LessonCard lesson={lessonMock} />
    </main>
  );
}
