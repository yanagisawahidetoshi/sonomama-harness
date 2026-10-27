import { Text, useColorScheme, View } from 'react-native';
import { colors, styles } from './styles';

export function HomeScreen() {
  const palette = colors[useColorScheme() === 'dark' ? 'dark' : 'light'];
  return (
    <View testID="home-screen" style={[styles.container, { backgroundColor: palette.background }]}>
      <Text style={[styles.title, { color: palette.text }]}>SONOMAMA</Text>
    </View>
  );
}
