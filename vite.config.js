import { defineConfig } from "vite";

export default defineConfig({
    build: {
        outDir: "dist",
        emptyOutDir: true,
        lib: {
            entry: "src/background.js",
            formats: ["iife"],
            name: "MagazinePdfExtension",
            fileName: () => "background.js"
        }
    }
});
