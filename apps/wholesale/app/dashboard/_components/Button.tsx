"use client";

import { type ButtonHTMLAttributes, forwardRef } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "cash" | "transfer" | "credit" | "sample";
type Size = "sm" | "md" | "lg";

const VARIANTS: Record<Variant, string> = {
  primary:   "bg-primary text-white hover:bg-primary-hover",
  secondary: "border border-gray-300 bg-white text-gray-700 hover:bg-gray-50",
  ghost:     "text-gray-600 hover:bg-gray-100",
  danger:    "bg-danger text-white hover:bg-danger-hover",
  cash:      "bg-cash text-white hover:bg-cash-hover",
  transfer:  "bg-transfer text-white hover:bg-transfer-hover",
  credit:    "bg-credit text-white hover:bg-credit-hover",
  sample:    "bg-sample text-white hover:bg-sample-hover",
};

const SIZES: Record<Size, string> = {
  sm: "px-3 py-1.5 text-xs",
  md: "px-4 py-2 text-sm",
  lg: "px-6 py-2.5 text-sm",
};

const BASE = "rounded-lg font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap focus:outline-none focus:ring-2 focus:ring-primary-ring";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
};

const Button = forwardRef<HTMLButtonElement, Props>(function Button(
  { variant = "primary", size = "md", className = "", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      {...rest}
      className={`${BASE} ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
    />
  );
});

export default Button;
