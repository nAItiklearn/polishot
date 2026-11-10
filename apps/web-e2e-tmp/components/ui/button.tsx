import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  [
    'inline-flex shrink-0 select-none items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium',
    'transition-[background-color,border-color,color,box-shadow,transform] active:translate-y-px',
    'disabled:pointer-events-none disabled:cursor-not-allowed',
    '[&_svg]:size-4 [&_svg]:shrink-0',
  ],
  {
    variants: {
      variant: {
        // Ink on paper. The persimmon accent is kept for marks and focus, not for buttons.
        primary:
          'bg-ink text-bg hover:bg-ink-2 active:bg-ink-2 disabled:border disabled:border-line disabled:bg-surface-2 disabled:text-ink-3',
        outline:
          'border border-line bg-surface text-ink shadow-low hover:border-ink-3 active:bg-surface-2 disabled:bg-surface-2 disabled:text-ink-3 disabled:shadow-none',
        ghost: 'text-ink-2 hover:bg-surface-2 hover:text-ink active:bg-surface-2',
      },
      size: {
        sm: 'h-10 px-4 text-sm',
        md: 'h-11 px-5 text-[15px]',
        lg: 'h-12 px-6 text-base',
        icon: 'size-10',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return <Comp ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
