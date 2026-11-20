const UTF8_PYTHON_ENVIRONMENT = {
  PYTHONUTF8: "1",
  PYTHONIOENCODING: "utf-8",
} as const;

export function pythonUtf8Environment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...environment, ...UTF8_PYTHON_ENVIRONMENT };
}

export function enableUtf8Python(environment: NodeJS.ProcessEnv = process.env): void {
  Object.assign(environment, UTF8_PYTHON_ENVIRONMENT);
}
