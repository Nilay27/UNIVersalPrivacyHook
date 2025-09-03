import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-gradient-to-r from-red-500 to-orange-500 text-white hover:from-red-600 hover:to-orange-600 shadow-sm hover:shadow-md",
        destructive:
          "bg-red-500 text-white hover:bg-red-600",
        outline:
          "border border-gray-300 bg-white text-gray-700 hover:bg-gray-50",
        secondary:
          "bg-gray-100 text-gray-700 hover:bg-gray-200",
        ghost: "hover:bg-gray-100 text-gray-700",
        link: "text-orange-500 underline-offset-4 hover:underline",
        cyan: "bg-orange-500 text-white hover:bg-orange-600 shadow-sm hover:shadow-md",
        primary: "bg-orange-500 text-white hover:bg-orange-600",
        success: "bg-green-500 text-white hover:bg-green-600",
        orange: "bg-orange-500 text-white hover:bg-orange-600 shadow-sm hover:shadow-md",
      },
      size: {
        default: "h-10 px-6 py-2",
        sm: "h-8 rounded-lg px-3 text-xs",
        lg: "h-12 rounded-xl px-8 text-base",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }