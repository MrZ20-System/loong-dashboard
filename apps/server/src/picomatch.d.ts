/**
 * picomatch@4 ships no type declarations. This ambient module covers only
 * the API surface LoongBoard consumes (plan 10: `picomatch(patterns,
 * { dot: true })` returning a matcher). Declared with `export default`
 * because Node's CJS interop exposes `module.exports` as the default.
 */
declare module "picomatch" {
  export interface PicomatchOptions {
    /** Match paths containing dot-segments such as `.github/workflows`. */
    dot?: boolean;
  }

  export type PicomatchMatcher = (test: string) => boolean;

  export default function picomatch(
    glob: string | readonly string[],
    options?: PicomatchOptions,
  ): PicomatchMatcher;
}
