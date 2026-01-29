/** @type {import("jest").Config} */
export default {
  preset: "ts-jest",
  testEnvironment: "node",
  projects: [
    {
      displayName: "unit",
      preset: "ts-jest",
      testEnvironment: "node",
      moduleNameMapper: {
        "^(\\.{1,2}/.*)\\.js$": "$1"
      },
      transform: {
        "^.+\\.(ts|tsx|js|jsx)$": ["ts-jest", { tsconfig: { allowJs: true } }]
      },
      transformIgnorePatterns: ["/node_modules/(?!(msw|@mswjs|until-async)/)"],
      roots: ["<rootDir>/tests/unit"],
      setupFilesAfterEnv: ["<rootDir>/tests/setup.ts"]
    },
    {
      displayName: "wire",
      preset: "ts-jest",
      testEnvironment: "node",
      moduleNameMapper: {
        "^(\\.{1,2}/.*)\\.js$": "$1"
      },
      transform: {
        "^.+\\.(ts|tsx|js|jsx)$": ["ts-jest", { tsconfig: { allowJs: true } }]
      },
      transformIgnorePatterns: ["/node_modules/(?!(msw|@mswjs|until-async)/)"],
      roots: ["<rootDir>/tests/wire"],
      setupFilesAfterEnv: ["<rootDir>/tests/setup.ts", "<rootDir>/tests/mock-server/setup.ts"]
    }
  ],
  workerThreads: false,
  passWithNoTests: true
};
