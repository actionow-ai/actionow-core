'use client';

import { motion, type Variants } from 'motion/react';
import * as React from 'react';

import {
  getVariants,
  type IconProps,
  IconWrapper,
  useAnimateIconContext,
} from '@/components/ui/icons/icon';

type ArrowRightProps = IconProps<keyof typeof animations>;

const animations = {
  default: {
    group: {
      initial: {
        x: 0,
        transition: { type: 'spring', stiffness: 340, damping: 22 },
      },
      animate: {
        x: 3,
        transition: { type: 'spring', stiffness: 340, damping: 22 },
      },
    },
    line: {
      initial: {
        x2: 19,
        transition: { ease: 'easeInOut', duration: 0.25 },
      },
      animate: {
        x2: 16,
        transition: { ease: 'easeInOut', duration: 0.25 },
      },
    },
  } satisfies Record<string, Variants>,
} as const;

function IconComponent({ size, ...props }: ArrowRightProps) {
  const { controls } = useAnimateIconContext();
  const variants = getVariants(animations);

  return (
    <motion.svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <motion.line
        x1={5}
        y1={12}
        x2={19}
        y2={12}
        variants={variants.line}
        initial="initial"
        animate={controls}
      />
      <motion.g variants={variants.group} initial="initial" animate={controls}>
        <path d="m12 5 7 7-7 7" />
      </motion.g>
    </motion.svg>
  );
}

function ArrowRight(props: ArrowRightProps) {
  return <IconWrapper icon={IconComponent} {...props} />;
}

export {
  animations,
  ArrowRight,
  ArrowRight as ArrowRightIcon,
  type ArrowRightProps as ArrowRightIconProps,
  type ArrowRightProps,
};
