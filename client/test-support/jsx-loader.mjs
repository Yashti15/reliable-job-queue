import { transformSync } from 'esbuild'

export async function load(url, context, nextLoad) {
  if (url.endsWith('.jsx')) {
    const result = await nextLoad(url, { ...context, format: 'module' })
    const sourceText =
      typeof result.source === 'string'
        ? result.source
        : Buffer.from(result.source).toString('utf8')
    const transformed = transformSync(sourceText, {
      loader: 'jsx',
      format: 'esm',
      jsx: 'automatic',
    })
    return {
      format: 'module',
      shortCircuit: true,
      source: transformed.code,
    }
  }
  return nextLoad(url, context)
}
