// Ambient declarations for side-effect imports that TS doesn't understand
// out of the box. `next-env.d.ts` covers most Next.js types but not plain
// `import './x.css'` style globals.

declare module "*.css";
declare module "*.scss";
