'use client';

import * as React from 'react';
import { motion, type HTMLMotionProps } from 'motion/react';

import { Slot, type WithAsChild } from '@/components/ui/primitives/animate/slot';

type ButtonProps = WithAsChild<
  HTMLMotionProps<'button'> & {
    hoverScale?: number;
    tapScale?: number;
  }
>;

function Button({
  // No grow-on-hover by default: a 1.05 scale makes full-width buttons overflow (and get clipped by)
  // rounded overflow-hidden containers, and reads as too bouncy for the clean design. Callers that
  // want it can still opt in via hoverScale. The subtle tap feedback (inward) stays.
  hoverScale = 1,
  tapScale = 0.97,
  asChild = false,
  ...props
}: ButtonProps) {
  const Component = asChild ? Slot : motion.button;

  return (
    <Component
      whileTap={{ scale: tapScale }}
      whileHover={{ scale: hoverScale }}
      {...props}
    />
  );
}

export { Button, type ButtonProps };

