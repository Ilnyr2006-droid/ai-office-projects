declare module "node:test" {
  const test: (name: string, fn: () => Promise<unknown> | unknown) => void;
  export default test;
}

declare module "node:assert/strict" {
  const assert: {
    ok(value: unknown, message?: string): void;
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
  };
  export default assert;
}

declare module "dotenv" {
  const dotenv: {
    config(): void;
  };
  export default dotenv;
}

declare module "fs" {
  export const promises: {
    readFile(path: string, encoding: string): Promise<string>;
  };
  const fs: {
    existsSync(path: string): boolean;
    mkdirSync(path: string, options?: { recursive?: boolean }): void;
  };
  export default fs;
}

declare module "path" {
  const path: {
    join(...parts: string[]): string;
    resolve(...parts: string[]): string;
    dirname(input: string): string;
  };
  export default path;
}

declare module "url" {
  export function fileURLToPath(url: string | URL): string;
}

declare module "crypto" {
  const crypto: {
    randomUUID(): string;
  };
  export default crypto;
}

declare var process: {
  env: Record<string, string | undefined>;
  exit(code?: number): never;
  once(event: string, listener: () => void): void;
};
