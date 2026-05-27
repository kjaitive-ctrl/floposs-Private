import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "scripts/**",
  ]),
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        destructuredArrayIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
      }],
      // React 19 새 strict 룰 — React 18 표준 fetch 패턴이 광범위 위반.
      // 점진 마이그레이션 의도로 warn 강등 (대기 목록: React Query 또는 Server Components).
      "react-hooks/set-state-in-effect": "warn",
    },
  },
]);

export default eslintConfig;
