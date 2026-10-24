/** Loader for the child's snapshot test: every `win32-native.mjs` import becomes the fake window. */
const FAKE = new URL('./fake-win32-native.mjs', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('win32-native.mjs')) return { url: FAKE, shortCircuit: true };
  return nextResolve(specifier, context);
}
