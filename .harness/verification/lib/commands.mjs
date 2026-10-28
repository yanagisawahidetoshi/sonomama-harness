// Compare argv arrays element by element: `pnpm run check` must not be satisfied by `pnpm run check:architecture`.
export const startsWith = (command, prefix) => prefix.every((arg, i) => command[i] === arg);
export const hasCommand = (commands, prefix) => commands.some(command => startsWith(command, prefix));
