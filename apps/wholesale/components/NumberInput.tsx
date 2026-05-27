"use client";

import { InputHTMLAttributes } from "react";

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "type"> & {
  value: number | "";
  onChange: (value: number | "") => void;
  suffix?: string;
};

export default function NumberInput({ value, onChange, suffix = "원", className = "", ...props }: Props) {
  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const digits = e.target.value.replace(/[^\d]/g, "");
    if (digits === "") { onChange(""); return; }
    const n = parseInt(digits, 10);
    onChange(isNaN(n) ? "" : n);
  }

  const display = value === "" ? "" : Number(value).toLocaleString();

  return (
    <div className="relative">
      <input
        type="text"
        inputMode="numeric"
        value={display}
        onChange={handleChange}
        className={`w-full px-4 py-2.5 ${suffix ? "pr-8" : ""} border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-ring text-right font-medium ${className}`}
        {...props}
      />
      {suffix && (
        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-gray-400 pointer-events-none">
          {suffix}
        </span>
      )}
    </div>
  );
}
