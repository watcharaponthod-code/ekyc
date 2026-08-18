/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/**/*.test.ts'],
  // The core package's `exports` map points TypeScript at a built `lib/`;
  // tests want the live source, like the app's Metro config does.
  moduleNameMapper: {
    '^@ekyc/react-native-ekyc$': '<rootDir>/../react-native-ekyc/src/index.ts',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: { jsx: 'react-jsx', strict: true, esModuleInterop: true } }],
  },
}
