import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  target: "node22",
  clean: true,
  dts: false,
  minify: false,
  // The shebang at the top of src/cli.ts is preserved by tsup.
});
