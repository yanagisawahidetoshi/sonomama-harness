import { StyleSheet } from 'react-native';

export const colors = {
  light: { background: '#FFFFFF', text: '#1A1A1A' },
  dark: { background: '#121212', text: '#F2F2F2' },
} as const;

export const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 24, fontWeight: '700' },
});
