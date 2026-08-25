import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', '*.mjs'],
  },
  {
    files: ['src/**/*.ts'],
    extends: [...tseslint.configs.recommended],
    rules: {
      // 웹뷰↔확장 메시지 경계에 any가 많다. 타입화(M-26)는 별도 작업이므로 지금은 끈다.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
);
