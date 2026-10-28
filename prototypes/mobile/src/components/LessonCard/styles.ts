import { StyleSheet } from 'react-native';

// Semantic tokens for prototyping. Values are placeholders until the Design System is decided.
export const colors = {
  light: { surface: '#FFFFFF', text: '#18181B', textMuted: '#52525B', accent: '#2563EB', danger: '#DC2626' },
  dark: { surface: '#18181B', text: '#F4F4F5', textMuted: '#A1A1AA', accent: '#60A5FA', danger: '#F87171' },
} as const;

export const styles = StyleSheet.create({
  card: { gap: 8, width: '100%', maxWidth: 360, padding: 16, borderRadius: 12 },
  title: { fontSize: 18, fontWeight: '700', lineHeight: 25 },
  meta: { fontSize: 14 },
  message: { fontSize: 14 },
  button: { alignSelf: 'flex-start', paddingVertical: 8, paddingHorizontal: 12, borderWidth: 1, borderRadius: 12 },
  buttonLabel: { fontSize: 14, fontWeight: '600' },
});
