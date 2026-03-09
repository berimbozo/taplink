import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // If you deploy the portal to a subdirectory, set base here.
  // For Railway root deployment, leave it as "/".
  base: "/",
});
