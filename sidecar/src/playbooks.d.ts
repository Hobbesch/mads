// Playbook-Markdown wird von esbuild als Text ins Bundle gezogen (`loader: { ".md": "text" }`
// in scripts/build.mjs). Ohne diese Deklaration kennt tsc den Import nicht. Gleiches Muster
// wie build-info.d.ts für die Build-Zeit-Konstanten.
declare module "*.md" {
  const content: string;
  export default content;
}
