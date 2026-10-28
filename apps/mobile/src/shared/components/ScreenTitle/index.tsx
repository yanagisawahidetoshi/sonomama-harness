import { Text, useColorScheme } from 'react-native';
import { colors } from '@/shared/theme/colors';
import { styles } from './styles';

interface Props {
  title: string;
  testID?: string;
}

export function ScreenTitle({ title, testID }: Props) {
  const palette = colors[useColorScheme() === 'dark' ? 'dark' : 'light'];
  return (
    <Text accessibilityRole="header" testID={testID} style={[styles.title, { color: palette.text }]}>
      {title}
    </Text>
  );
}
