import { resolve } from "node:path";
import { defineConfig } from "vite";

const root = import.meta.dirname;

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        index: resolve(root, "index.html"),
        pricing: resolve(root, "pricing.html"),
        contact: resolve(root, "contact.html"),
        success: resolve(root, "success.html"),
        cancel: resolve(root, "cancel.html"),
        privacy: resolve(root, "privacy.html"),
        terms: resolve(root, "terms.html"),
        notFound: resolve(root, "404.html"),
        admin: resolve(root, "admin.html")
      }
    }
  }
});
