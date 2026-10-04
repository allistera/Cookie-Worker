// workers-types does not declare node:async_hooks, and pulling in all of
// @types/node would clash with the Workers globals. Only what we use.
declare module 'node:async_hooks' {
  export class AsyncLocalStorage<T> {
    run<R>(store: T, callback: () => R): R;
    getStore(): T | undefined;
  }
}
