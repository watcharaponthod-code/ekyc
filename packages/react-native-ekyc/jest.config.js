/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/**/*.test.ts'],
  moduleNameMapper: {
    '^expo-image-manipulator$': '<rootDir>/tests/__mocks__/expo-image-manipulator.ts',
  },
  transform: {
    '^.+\.tsx?$': ['ts-jest', { tsconfig: { jsx: 'react-jsx', strict: true, esModuleInterop: true } }],
  },
}
