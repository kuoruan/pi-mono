/**
 * Vite's `?raw` import form — used by the shiki engine bench to bind its
 * realistic dense-source fixture — has no built-in type in a Node-only
 * tsconfig (vite/client pulls in DOM globals). This ambient declaration
 * mirrors vite's own `raw` module: default-exported file content.
 */
declare module "*?raw" {
  const content: string;
  export default content;
}
