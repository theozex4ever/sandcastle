import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const pkg = JSON.parse(readFileSync("./package.json", "utf8")) as {
  version: string;
};

export default defineConfig([
  {
    entry: {
      index: "src/index.ts",
      main: "src/main.ts",
      "sandboxes/docker": "src/sandboxes/docker.ts",
      "sandboxes/podman": "src/sandboxes/podman.ts",
      "sandboxes/vercel": "src/sandboxes/vercel.ts",
      "sandboxes/daytona": "src/sandboxes/daytona.ts",
      "sandboxes/no-sandbox": "src/sandboxes/no-sandbox.ts",
    },
    format: ["esm"],
    outDir: "dist",
    target: "node18",
    platform: "node",
    splitting: true,
    sourcemap: true,
    // Leave the dashboard UI bundle alone: both configs run in parallel and
    // the browser build below writes into dist/dashboard.
    clean: ["!dashboard/**"],
    dts: true,
    treeshake: true,
    external: ["@vercel/sandbox", "@daytona/sdk"],
    define: {
      __SANDCASTLE_VERSION__: JSON.stringify(pkg.version),
    },
    // Some bundled CJS dependencies (notably `undici` via `@effect/platform-node`)
    // use `require()` of Node built-ins. ESM has no `require`, so we install one
    // via `createRequire` so the bundled CJS-shaped code keeps working.
    banner: {
      js: [
        "import { createRequire as __sandcastleCreateRequire } from 'node:module';",
        "const require = __sandcastleCreateRequire(import.meta.url);",
      ].join("\n"),
    },
  },
  {
    // Browser bundle for `sandcastle dashboard`, served as static assets.
    // index.html is copied next to it in `postbuild`.
    entry: { app: "src/dashboard/ui/main.tsx" },
    tsconfig: "src/dashboard/ui/tsconfig.json",
    outDir: "dist/dashboard",
    format: ["esm"],
    platform: "browser",
    target: "es2022",
    minify: true,
    dts: false,
    splitting: false,
    sourcemap: false,
    clean: false,
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    loader: { ".css": "css" },
    outExtension: () => ({ js: ".js" }),
  },
]);
