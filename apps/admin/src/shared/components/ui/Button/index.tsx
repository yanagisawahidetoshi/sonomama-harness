import type { ComponentProps } from 'react';
import { Button as SparkleButton } from 'sparkle-design';

interface Props extends ComponentProps<typeof SparkleButton> {}

export function Button(props: Props) {
  return <SparkleButton {...props} />;
}
