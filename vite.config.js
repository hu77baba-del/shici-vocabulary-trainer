import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  publicDir: false,
  build: {
    target: "es2022",
    outDir: "public/vendor/paddleocr/runtime",
    emptyOutDir: true,
    sourcemap: false,
    minify: true,
    rollupOptions: { external: ["onnxruntime-web"] },
    lib: {
      entry: resolve(import.meta.dirname, "src/ocr-runtime.js"),
      formats: ["es"],
      fileName: () => "paddle-ocr.js"
    }
  }
});
