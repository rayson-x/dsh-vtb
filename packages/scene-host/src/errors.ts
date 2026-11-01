export class SceneHostScaffoldError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'SceneHostScaffoldError';
    this.code = code;
  }
}
