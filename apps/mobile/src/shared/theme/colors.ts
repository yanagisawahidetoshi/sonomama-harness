export const colors = {
  light: { background: '#FFFFFF', text: '#1A1A1A' },
  dark: { background: '#121212', text: '#F2F2F2' },
} as const;

export type TColorScheme = keyof typeof colors;
