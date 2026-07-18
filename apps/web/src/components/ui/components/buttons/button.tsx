'use client';

import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import {
  Button as ButtonPrimitive,
  type ButtonProps as ButtonPrimitiveProps,
} from '@/components/ui/primitives/buttons/button';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full text-sm font-medium transition-[box-shadow,_color,_background-color,_outline-color,_text-decoration-color,_fill,_stroke] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-invalid:outline-solid aria-invalid:outline-2 aria-invalid:outline-destructive",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground shadow-xs hover:bg-primary/88',
        accent: 'bg-accent text-accent-foreground shadow-xs hover:bg-accent/80',
        destructive:
          'bg-destructive text-white shadow-xs hover:bg-destructive/88 focus-visible:outline-destructive',
        outline: 'bg-surface-subtle text-foreground shadow-xs hover:bg-surface-strong',
        secondary: 'bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/75',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-4 py-2 has-[>svg]:px-3.5',
        sm: 'h-8 gap-1.5 px-3.5 has-[>svg]:px-3',
        lg: 'h-10 px-6 has-[>svg]:px-4',
        icon: 'size-9',
        'icon-sm': 'size-8',
        'icon-lg': 'size-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

type ButtonProps = ButtonPrimitiveProps & VariantProps<typeof buttonVariants>;

function Button({ className, variant, size, ...props }: ButtonProps) {
  return (
    <ButtonPrimitive className={cn(buttonVariants({ variant, size, className }))} {...props} />
  );
}

export { Button, type ButtonProps, buttonVariants };
