import { View } from 'react-native';
import { LessonCard } from '../components/LessonCard';
import { lessonMock } from '../mocks/lessons';

export default function Index() {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <LessonCard lesson={lessonMock} />
    </View>
  );
}
