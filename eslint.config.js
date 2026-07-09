import js from "@eslint/js";

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        fetch: "readonly",
        Response: "readonly",
        Request: "readonly",
        Headers: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        ReadableStream: "readonly",
        AbortController: "readonly",
        AbortSignal: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        crypto: "readonly",
        structuredClone: "readonly",
        atob: "readonly",
        btoa: "readonly",
        setTimeout: "readonly",
        setInterval: "readonly",
        setImmediate: "readonly",
        clearImmediate: "readonly",
        clearTimeout: "readonly",
        clearInterval: "readonly",
        queueMicrotask: "readonly",
        PerformanceObserver: "readonly",
        performance: "readonly",
        Worker: "readonly",
        MessageChannel: "readonly",
        MessagePort: "readonly",
        BroadcastChannel: "readonly",
        WebSocket: "readonly",
        File: "readonly",
        FormData: "readonly",
        Blob: "readonly",
        ReadableStreamDefaultReader: "readonly",
        WritableStreamDefaultWriter: "readonly",
        EventTarget: "readonly",
        Event: "readonly",
        CustomEvent: "readonly",
        ErrorEvent: "readonly",
        MessageEvent: "readonly",
        Error: "readonly",
        SyntaxError: "readonly",
        TypeError: "readonly",
        RangeError: "readonly",
        ReferenceError: "readonly",
        EvalError: "readonly",
        URIError: "readonly",
        AggregateError: "readonly",
        Map: "readonly",
        Set: "readonly",
        WeakMap: "readonly",
        WeakSet: "readonly",
        Promise: "readonly",
        Proxy: "readonly",
        Symbol: "readonly",
        Intl: "readonly",
        WebAssembly: "readonly",
        SharedArrayBuffer: "readonly",
        Atomics: "readonly",
        BigInt: "readonly",
        FinalizationRegistry: "readonly",
        WeakRef: "readonly"
      }
    },
    rules: {
      "no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_"
        }
      ],
      "no-console": "off",
      "no-constant-condition": ["error", { checkLoops: false }],
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-control-regex": "off",
      "no-async-promise-executor": "warn"
    },
    ignores: [
      "node_modules/",
      "data/",
      "logs/",
      "tmp/",
      "clients/generated/"
    ]
  }
];
