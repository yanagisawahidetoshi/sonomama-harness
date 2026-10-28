import { useColorScheme, View } from 'react-native';
import { ScreenTitle } from '@/shared/components/ScreenTitle';
import { colors } from '@/shared/theme/colors';
import { styles } from './styles';

export function HomeScreen() {
  const palette = colors[useColorScheme() === 'dark' ? 'dark' : 'light'];
  return (
    <View testID="home-screen" style={[styles.container, { backgroundColor: palette.background }]}>
      <ScreenTitle title="SONOMAMA" testID="home-title" />
    </View>
  );
}
