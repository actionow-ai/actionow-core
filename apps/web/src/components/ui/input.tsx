// Animate UI does not publish a styled Input registry item. This local primitive follows its official tokens, focus treatment, radius, and accessibility conventions.
import * as React from 'react';

import { cn } from '@/lib/utils';

type InputProps = React.ComponentProps<'input'>;

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type = 'text', ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={cn(
        'flex h-10 w-full rounded-full bg-surface-subtle px-4 text-sm text-foreground outline-hidden transition-[outline-color,background-color] placeholder:text-muted-foreground/75 hover:bg-surface-strong/70 focus:bg-surface focus:outline-solid focus:outline-2 focus:outline-offset-2 focus:outline-ring disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  ),
);

Input.displayName = 'Input';

type TextareaProps = React.ComponentProps<'textarea'>;

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        'flex min-h-24 w-full resize-y rounded-xl bg-surface-subtle px-4 py-2.5 text-sm text-foreground outline-hidden transition-[outline-color,background-color] placeholder:text-muted-foreground/75 hover:bg-surface-strong/70 focus:bg-surface focus:outline-solid focus:outline-2 focus:outline-offset-2 focus:outline-ring disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  ),
);

Textarea.displayName = 'Textarea';

type FileInputProps = Omit<React.ComponentProps<'input'>, 'type'>;

const FileInput = React.forwardRef<HTMLInputElement, FileInputProps>(
  ({ className, ...props }, ref) => (
    <input ref={ref} type="file" className={cn('sr-only', className)} {...props} />
  ),
);

FileInput.displayName = 'FileInput';

export { FileInput, Input, Textarea };
